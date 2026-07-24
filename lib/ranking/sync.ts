/**
 * Ranking-rebuild orchestrator (Phase 5.3). Implements the exact MVP
 * decisions from the Phase 5.3 owner-decision report — see
 * lib/ranking/formulas.ts for the individual formulas and
 * lib/ranking/repository.ts for the data-source notes (in particular, why
 * win_rate/pick_rate/high_rank_win_rate read raw participation rows while
 * matchup classification and the aggregation-existence precondition read
 * only the latest aggregation run, per task item 9).
 *
 * DURABLE, RESUMABLE EXECUTION (Phase 5 timeout fix — see PHASE5.md
 * "Durable batched execution"): the previous design fetched every brawler's
 * raw participation rows and wrote every candidate row inside one HTTP
 * request, whose runtime grew with the dataset (production 500 under
 * connection contention behind the ~60s Hostinger request limit). It is
 * replaced by a bounded-batch state machine spanning many short calls:
 *
 *   brawlers -> matchups -> finalize -> publish -> done
 *
 * The `brawlers` and `matchups` phases process a small, cursor-advanced
 * batch of brawlers per call, writing partial candidate rows. `finalize`
 * computes the pick-rate denominators and percentile tiers (which need the
 * whole run) over the now-persisted, bounded candidate set. `publish`
 * applies the mass-movement guard, no-significant-change rule, and atomic
 * snapshot publication — unchanged semantics, still one transaction.
 *
 * `stepRankingRebuild` is the per-call HTTP entry point (started/in_progress/
 * completed); `runRankingRebuild` is a run-to-completion driver (tests/manual)
 * whose return shape is unchanged. Ranking is never computed against an
 * incomplete aggregation: getLatestSuccessfulAggregation only returns a
 * fully-'succeeded' aggregation run.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection } from "mysql2/promise";
import { getWritePool } from "@/lib/mysql";
import { logSafeInfo } from "@/lib/errors";
import * as rankingRepo from "@/lib/ranking/repository";
import type { RawParticipationRow } from "@/lib/ranking/repository";
import { getActivePatch } from "@/lib/patches/repository";
import { TROPHY_BRACKETS, UNRANKED_BRACKET_ID } from "@/lib/ingestion/trophyBracket";
import { computeWinRate } from "@/lib/aggregation/formulas";
import {
  computeRecencyWeight,
  computePatchBlendWeight,
  blendWinRate,
  applyPerPlayerCap,
  computeOverallScore,
  computeModeScore,
  assignPercentileTiers,
  computeOverallConfidence,
  computeModeConfidence,
  classifyMatchup,
  computeMatchupConfidence,
  computeTierMoveRatio,
  exceedsMassMovementGuard,
  hasSignificantChange,
  type Tier,
  type ConfidenceLabel,
  type ChangeComparison,
} from "@/lib/ranking/formulas";
import {
  ensureWorkflowDefinition,
  acquireWorkflowLock,
  releaseWorkflowLock,
  startWorkflowRun,
  completeWorkflowRun,
  findLatestRunningRun,
  readJobCursor,
  writeJobCursor,
  reconcileStaleWorkflowRuns,
} from "@/lib/workflow";

const WORKFLOW_SLUG = "ranking-rebuild";
const PER_PLAYER_CAP = 20;

export const DEFAULT_RANKING_BATCH_SIZE = 8;
export const MAX_RANKING_BATCH_SIZE = 50;

const SLICE_LOCK_TTL_MS = 2 * 60_000;
const DRIVER_LOCK_TTL_MS = 15 * 60_000;
const STALE_JOB_SECONDS = 15 * 60;
const MAX_DRIVER_SLICES = 1_000_000;

type RankingPhase = "brawlers" | "matchups" | "finalize" | "publish" | "done";

export type RankingOutcome =
  | "published"
  | "held_mass_movement"
  | "no_significant_change"
  | "no_valid_aggregation"
  | "no_active_rule_set"
  | "lock_not_acquired";

interface RankingCursor {
  phase: RankingPhase;
  rankingRunId: string;
  aggIds: { mode: string; overall: string; matchup: string };
  ruleSetId: string;
  patchId: string | null;
  patchVersionLabel: string | null;
  nowIso: string;
  brawlerCursor: string | null;
}

export interface RankingRebuildResult {
  outcome: RankingOutcome;
  workflowRunId?: string;
  rankingRunId?: string;
  brawlersEvaluated?: number;
  brawlersPublished?: number;
  tierMoveRatio?: number;
}

export interface RankingStepResult {
  status: "started" | "in_progress" | "completed" | "lock_not_acquired";
  phase: RankingPhase;
  workflowRunId?: string;
  rankingRunId?: string;
  outcome?: RankingOutcome;
  brawlersEvaluated?: number;
  brawlersPublished?: number;
  tierMoveRatio?: number;
  /** Present on `lock_not_acquired`: the id of the run whose slice currently holds the lock (overlap guard; read-only, never a second run). */
  activeWorkflowRunId?: string;
}

interface SliceOutcome {
  freshStart: boolean;
  done: boolean;
  phase: RankingPhase;
  workflowRunId: string;
  rankingRunId?: string;
  outcome?: RankingOutcome;
  brawlersEvaluated?: number;
  brawlersPublished?: number;
  tierMoveRatio?: number;
}

async function withTransaction<T>(pool: Pool, fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// ---------------------------------------------------------------------------
// Per-brawler raw computation (unchanged from the original single-run design)
// ---------------------------------------------------------------------------

function daysAgo(occurredAt: Date, now: Date): number {
  return (now.getTime() - occurredAt.getTime()) / 86_400_000;
}

interface WeightedTotals {
  weightedWins: number;
  weightedLosses: number;
}

function accumulateWeighted(rows: RawParticipationRow[], now: Date): WeightedTotals {
  let weightedWins = 0;
  let weightedLosses = 0;
  for (const row of rows) {
    const weight = computeRecencyWeight(daysAgo(row.occurredAt, now));
    if (row.result === "victory") weightedWins += weight;
    else if (row.result === "defeat") weightedLosses += weight;
  }
  return { weightedWins, weightedLosses };
}

function computeBlendedWinRate(rows: RawParticipationRow[], activePatchId: string | null, now: Date): { winRate: number | null; matches: number } {
  const allStats = accumulateWeighted(rows, now);
  const allDataWinRate = computeWinRate(allStats.weightedWins, allStats.weightedLosses);

  const currentPatchRows = activePatchId ? rows.filter((r) => r.patchId === activePatchId) : [];
  const currentStats = accumulateWeighted(currentPatchRows, now);
  const currentPatchWinRate = currentPatchRows.length > 0 ? computeWinRate(currentStats.weightedWins, currentStats.weightedLosses) : null;

  const blendWeight = computePatchBlendWeight(currentPatchRows.length);
  return { winRate: blendWinRate(currentPatchWinRate, allDataWinRate, blendWeight), matches: rows.length };
}

function computeHighRankWinRate(rows: RawParticipationRow[], now: Date, minSampleSize: number): number | null {
  for (let i = TROPHY_BRACKETS.length - 1; i >= 0; i -= 1) {
    const bracket = TROPHY_BRACKETS[i];
    const bracketRows = rows.filter((r) => r.trophyBracket === bracket.id);
    if (bracketRows.length >= minSampleSize) {
      const stats = accumulateWeighted(bracketRows, now);
      return computeWinRate(stats.weightedWins, stats.weightedLosses);
    }
  }
  return null;
}

interface BrawlerComputation {
  brawlerId: string;
  overallMatches: number;
  overallWinRate: number | null;
  highRankWinRate: number | null;
  distinctRegions: number;
  distinctTrophyBrackets: number;
  recentWithin30Days: boolean;
  byMode: Map<string, { matches: number; winRate: number | null }>;
}

function computeForBrawler(brawlerId: string, rawRows: RawParticipationRow[], activePatchId: string | null, now: Date, ruleSet: rankingRepo.ActiveRuleSet): BrawlerComputation {
  const capped = applyPerPlayerCap(
    rawRows.map((r) => ({ ...r, playerId: r.playerId })),
    PER_PLAYER_CAP
  );

  const overall = computeBlendedWinRate(capped, activePatchId, now);
  const highRankMinSample = ruleSet.weights["high_rank_win_rate"]?.minSampleSize ?? 30;
  const highRankWinRate = computeHighRankWinRate(capped, now, highRankMinSample);

  const regions = new Set(capped.map((r) => r.region).filter((r): r is string => Boolean(r)));
  const brackets = new Set(capped.map((r) => r.trophyBracket).filter((b): b is string => Boolean(b) && b !== UNRANKED_BRACKET_ID));
  const recentWithin30Days = capped.some((r) => daysAgo(r.occurredAt, now) <= 30);

  const modeIds = new Set(capped.map((r) => r.gameModeId).filter((m): m is string => Boolean(m)));
  const byMode = new Map<string, { matches: number; winRate: number | null }>();
  for (const modeId of modeIds) {
    const modeRows = capped.filter((r) => r.gameModeId === modeId);
    const modeResult = computeBlendedWinRate(modeRows, activePatchId, now);
    byMode.set(modeId, { matches: modeResult.matches, winRate: modeResult.winRate });
  }

  return {
    brawlerId,
    overallMatches: overall.matches,
    overallWinRate: overall.winRate,
    highRankWinRate,
    distinctRegions: regions.size,
    distinctTrophyBrackets: brackets.size,
    recentWithin30Days,
    byMode,
  };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

async function executeNextRankingSlice(
  pool: Pool,
  workflowDefinitionId: string,
  triggeredBy: "manual" | "cron",
  batchSize: number
): Promise<SliceOutcome> {
  const running = await findLatestRunningRun(pool, workflowDefinitionId);

  if (!running) {
    return startRankingJob(pool, workflowDefinitionId, triggeredBy);
  }

  const workflowRunId = running.id;
  const cursor = await readJobCursor<RankingCursor>(pool, workflowRunId);
  if (!cursor) {
    await completeWorkflowRun(pool, workflowRunId, "failed", "missing_cursor");
    logSafeInfo("ranking-rebuild", "job_failed_missing_cursor", { workflowRunId });
    return { freshStart: false, done: false, phase: "brawlers", workflowRunId };
  }

  switch (cursor.phase) {
    case "brawlers":
      return brawlersPhase(pool, workflowRunId, cursor, batchSize);
    case "matchups":
      return matchupsPhase(pool, workflowRunId, cursor, batchSize);
    case "finalize":
      return finalizePhase(pool, workflowRunId, cursor);
    case "publish":
    case "done":
      return publishPhase(pool, workflowRunId, cursor);
    default:
      throw new Error(`unknown ranking phase: ${cursor.phase}`);
  }
}

async function startRankingJob(pool: Pool, workflowDefinitionId: string, triggeredBy: "manual" | "cron"): Promise<SliceOutcome> {
  const workflowRunId = await startWorkflowRun(pool, workflowDefinitionId, triggeredBy === "cron" ? "schedule" : "manual");

  const latestAggregation = await rankingRepo.getLatestSuccessfulAggregation(pool);
  if (!latestAggregation) {
    await completeWorkflowRun(pool, workflowRunId, "failed", "no_valid_aggregation");
    logSafeInfo("ranking-rebuild", "job_terminal", { workflowRunId, outcome: "no_valid_aggregation" });
    return { freshStart: true, done: true, phase: "done", workflowRunId, outcome: "no_valid_aggregation" };
  }

  const ruleSet = await rankingRepo.getActiveRuleSet(pool);
  if (!ruleSet || !ruleSet.overallTierThreshold) {
    await completeWorkflowRun(pool, workflowRunId, "failed", "no_active_rule_set");
    logSafeInfo("ranking-rebuild", "job_terminal", { workflowRunId, outcome: "no_active_rule_set" });
    return { freshStart: true, done: true, phase: "done", workflowRunId, outcome: "no_active_rule_set" };
  }

  const activePatch = await getActivePatch(pool);
  const activePatchId = activePatch?.id ?? null;
  const now = new Date();

  const rankingRunId = await rankingRepo.createRankingRun(pool, {
    workflowRunId,
    rankingRuleSetId: ruleSet.id,
    modeAggregationRunId: latestAggregation.modeAggregationRunId,
    overallAggregationRunId: latestAggregation.overallAggregationRunId,
    matchupAggregationRunId: latestAggregation.matchupAggregationRunId,
    patchId: activePatchId,
  });

  const cursor: RankingCursor = {
    phase: "brawlers",
    rankingRunId,
    aggIds: { mode: latestAggregation.modeAggregationRunId, overall: latestAggregation.overallAggregationRunId, matchup: latestAggregation.matchupAggregationRunId },
    ruleSetId: ruleSet.id,
    patchId: activePatchId,
    patchVersionLabel: activePatch?.versionLabel ?? null,
    nowIso: now.toISOString(),
    brawlerCursor: null,
  };
  await writeJobCursor(pool, workflowRunId, cursor);
  logSafeInfo("ranking-rebuild", "job_started", { workflowRunId, rankingRunId });
  return { freshStart: true, done: false, phase: "brawlers", workflowRunId, rankingRunId };
}

async function requireActiveRuleSet(pool: Pool): Promise<rankingRepo.ActiveRuleSet> {
  const ruleSet = await rankingRepo.getActiveRuleSet(pool);
  if (!ruleSet || !ruleSet.overallTierThreshold) throw new Error("active ranking rule set disappeared mid-run");
  return ruleSet;
}

async function brawlersPhase(pool: Pool, workflowRunId: string, cursor: RankingCursor, batchSize: number): Promise<SliceOutcome> {
  const batch = await rankingRepo.getActiveBrawlerIdBatch(pool, cursor.brawlerCursor, batchSize);
  if (batch.length === 0) {
    await withTransaction(pool, (c) => writeJobCursor(c, workflowRunId, { ...cursor, phase: "matchups", brawlerCursor: null }));
    logSafeInfo("ranking-rebuild", "phase_advance", { workflowRunId, from: "brawlers", to: "matchups" });
    return { freshStart: false, done: false, phase: "matchups", workflowRunId, rankingRunId: cursor.rankingRunId };
  }

  const ruleSet = await requireActiveRuleSet(pool);
  const overallFloor = ruleSet.weights["win_rate"]?.minSampleSize ?? 100;
  const modeFloor = ruleSet.weights["mode_win_rate"]?.minSampleSize ?? 30;
  const now = new Date(cursor.nowIso);

  const computations: BrawlerComputation[] = [];
  for (const brawlerId of batch) {
    const rawRows = await rankingRepo.getRawParticipationRows(pool, brawlerId);
    computations.push(computeForBrawler(brawlerId, rawRows, cursor.patchId, now, ruleSet));
  }

  await withTransaction(pool, async (c) => {
    for (const comp of computations) {
      const meetsFloor = comp.overallMatches >= overallFloor && comp.overallWinRate !== null;
      const confidence: ConfidenceLabel = meetsFloor
        ? computeOverallConfidence(comp.overallMatches, {
            recentBattleWithin30Days: comp.recentWithin30Days,
            distinctRegions: comp.distinctRegions,
            distinctTrophyBrackets: comp.distinctTrophyBrackets,
          })
        : "insufficient";
      await rankingRepo.insertRankingResult(c, cursor.rankingRunId, {
        brawlerId: comp.brawlerId,
        gameModeId: null,
        matches: comp.overallMatches,
        winRate: comp.overallWinRate,
        pickRate: null,
        highRankWinRate: comp.highRankWinRate,
        matchupCoverage: null,
        metaScore: null,
        tier: null,
        confidence,
        meetsFloor,
      });

      for (const [modeId, mode] of comp.byMode) {
        const modeMeetsFloor = mode.matches >= modeFloor && mode.winRate !== null;
        const modeConfidence: ConfidenceLabel = modeMeetsFloor
          ? computeModeConfidence(mode.matches, {
              recentBattleWithin30Days: comp.recentWithin30Days,
              distinctRegions: comp.distinctRegions,
              distinctTrophyBrackets: comp.distinctTrophyBrackets,
            })
          : "insufficient";
        await rankingRepo.insertRankingResult(c, cursor.rankingRunId, {
          brawlerId: comp.brawlerId,
          gameModeId: modeId,
          matches: mode.matches,
          winRate: mode.winRate,
          pickRate: null,
          highRankWinRate: null,
          matchupCoverage: null,
          metaScore: null,
          tier: null,
          confidence: modeConfidence,
          meetsFloor: modeMeetsFloor,
        });
      }
    }
    await writeJobCursor(c, workflowRunId, { ...cursor, brawlerCursor: batch[batch.length - 1] });
  });

  logSafeInfo("ranking-rebuild", "batch_processed", { workflowRunId, phase: "brawlers", brawlers: batch.length, cursor: batch[batch.length - 1] });
  return { freshStart: false, done: false, phase: "brawlers", workflowRunId, rankingRunId: cursor.rankingRunId };
}

async function matchupsPhase(pool: Pool, workflowRunId: string, cursor: RankingCursor, batchSize: number): Promise<SliceOutcome> {
  const batch = await rankingRepo.getActiveBrawlerIdBatch(pool, cursor.brawlerCursor, batchSize);
  if (batch.length === 0) {
    await withTransaction(pool, (c) => writeJobCursor(c, workflowRunId, { ...cursor, phase: "finalize", brawlerCursor: null }));
    logSafeInfo("ranking-rebuild", "phase_advance", { workflowRunId, from: "matchups", to: "finalize" });
    return { freshStart: false, done: false, phase: "finalize", workflowRunId, rankingRunId: cursor.rankingRunId };
  }

  const perBrawler = new Map<string, rankingRepo.PooledMatchupRow[]>();
  for (const brawlerId of batch) {
    perBrawler.set(brawlerId, await rankingRepo.getPooledMatchupRowsForBrawler(pool, cursor.aggIds.matchup, brawlerId));
  }

  await withTransaction(pool, async (c) => {
    for (const brawlerId of batch) {
      const pooled = perBrawler.get(brawlerId) ?? [];
      let qualifying = 0;
      for (const row of pooled) {
        const winRate = computeWinRate(row.wins, row.losses);
        const relationship = classifyMatchup(winRate, row.matches);
        if (relationship !== null) qualifying += 1;
        const confidenceLevel = computeMatchupConfidence(row.matches, false);
        await rankingRepo.insertMatchupResult(c, cursor.rankingRunId, {
          brawlerId: row.brawlerId,
          opponentBrawlerId: row.opponentBrawlerId,
          gameModeId: null,
          matches: row.matches,
          winRate,
          relationship,
          confidenceLevel,
          meetsFloor: relationship !== null,
        });
      }
      const coverage = pooled.length > 0 ? qualifying / pooled.length : 0;
      await rankingRepo.updateRankingResultMatchupCoverage(c, cursor.rankingRunId, brawlerId, coverage);
    }
    await writeJobCursor(c, workflowRunId, { ...cursor, brawlerCursor: batch[batch.length - 1] });
  });

  logSafeInfo("ranking-rebuild", "batch_processed", { workflowRunId, phase: "matchups", brawlers: batch.length, cursor: batch[batch.length - 1] });
  return { freshStart: false, done: false, phase: "matchups", workflowRunId, rankingRunId: cursor.rankingRunId };
}

async function finalizePhase(pool: Pool, workflowRunId: string, cursor: RankingCursor): Promise<SliceOutcome> {
  const rows = await rankingRepo.getRankingResultsForRun(pool, cursor.rankingRunId);
  const overallRows = rows.filter((r) => r.gameModeId === null);
  const modeRows = rows.filter((r) => r.gameModeId !== null);

  // Pick-rate denominators (Section 7.28 MVP): `matches` already equals the
  // capped participant-slot count for each scope, so the denominator is just
  // the sum of matches across the run's rows for that scope.
  const overallSlotTotal = overallRows.reduce((sum, r) => sum + r.matches, 0);
  const modeSlotTotals = new Map<string, number>();
  for (const r of modeRows) modeSlotTotals.set(r.gameModeId as string, (modeSlotTotals.get(r.gameModeId as string) ?? 0) + r.matches);

  interface Update {
    id: string;
    pickRate: number;
    metaScore: number | null;
    eligible: boolean;
    scoreForTier: number;
  }

  const overallUpdates: Update[] = overallRows.map((r) => {
    const pickRate = overallSlotTotal > 0 ? r.matches / overallSlotTotal : 0;
    const metaScore =
      r.meetsFloor && r.winRate !== null
        ? computeOverallScore({ winRate: r.winRate, pickRate, highRankWinRate: r.highRankWinRate, matchupCoverage: r.matchupCoverage })
        : null;
    return { id: r.id, pickRate, metaScore, eligible: r.meetsFloor && metaScore !== null, scoreForTier: metaScore ?? 0 };
  });
  const overallEligible = overallUpdates.filter((u) => u.eligible);
  const overallTiers = assignPercentileTiers(overallEligible.map((u) => u.scoreForTier));
  const overallTierById = new Map<string, Tier>();
  overallEligible.forEach((u, i) => overallTierById.set(u.id, overallTiers[i]));

  const modeUpdatesByMode = new Map<string, Update[]>();
  for (const r of modeRows) {
    const total = modeSlotTotals.get(r.gameModeId as string) ?? 0;
    const pickRate = total > 0 ? r.matches / total : 0;
    const metaScore = r.meetsFloor && r.winRate !== null ? computeModeScore({ modeWinRate: r.winRate, modePickRate: pickRate }) : null;
    const list = modeUpdatesByMode.get(r.gameModeId as string) ?? [];
    list.push({ id: r.id, pickRate, metaScore, eligible: r.meetsFloor && metaScore !== null, scoreForTier: metaScore ?? 0 });
    modeUpdatesByMode.set(r.gameModeId as string, list);
  }
  const modeTierById = new Map<string, Tier>();
  for (const [, list] of modeUpdatesByMode) {
    const eligible = list.filter((u) => u.eligible);
    const tiers = assignPercentileTiers(eligible.map((u) => u.scoreForTier));
    eligible.forEach((u, i) => modeTierById.set(u.id, tiers[i]));
  }

  await withTransaction(pool, async (c) => {
    for (const u of overallUpdates) {
      await rankingRepo.updateRankingResultScoreTier(c, u.id, { pickRate: u.pickRate, metaScore: u.metaScore, tier: overallTierById.get(u.id) ?? null });
    }
    for (const [, list] of modeUpdatesByMode) {
      for (const u of list) {
        await rankingRepo.updateRankingResultScoreTier(c, u.id, { pickRate: u.pickRate, metaScore: u.metaScore, tier: modeTierById.get(u.id) ?? null });
      }
    }
    await writeJobCursor(c, workflowRunId, { ...cursor, phase: "publish", brawlerCursor: null });
  });

  logSafeInfo("ranking-rebuild", "phase_advance", { workflowRunId, from: "finalize", to: "publish", overallRows: overallRows.length, modeRows: modeRows.length });
  return { freshStart: false, done: false, phase: "publish", workflowRunId, rankingRunId: cursor.rankingRunId };
}

async function publishPhase(pool: Pool, workflowRunId: string, cursor: RankingCursor): Promise<SliceOutcome> {
  const rankingRunId = cursor.rankingRunId;
  const rows = await rankingRepo.getRankingResultsForRun(pool, rankingRunId);
  const overallRows = rows.filter((r) => r.gameModeId === null);

  const brawlersEvaluated = overallRows.length;
  const newTiers = new Map<string, Tier>();
  for (const r of overallRows) if (r.tier) newTiers.set(r.brawlerId, r.tier);

  const isFirstRun = !(await rankingRepo.hasAnyPublishedSnapshot(pool));
  let tierMoveRatio = 0;
  let comparisons: ChangeComparison[] = [];
  if (!isFirstRun) {
    const previous = await rankingRepo.getCurrentSnapshotTierInfo(pool);
    const previousTiers = new Map(previous.map((p) => [p.brawlerId, p.tier]));
    const previousScores = new Map(previous.map((p) => [p.brawlerId, p.score]));
    tierMoveRatio = computeTierMoveRatio(previousTiers, newTiers);
    comparisons = overallRows
      .filter((r) => r.tier)
      .map((r) => ({
        brawlerId: r.brawlerId,
        previousTier: previousTiers.get(r.brawlerId) ?? null,
        newTier: r.tier as Tier,
        previousScore: previousScores.get(r.brawlerId) ?? null,
        newScore: r.metaScore as number,
      }));
  }

  if (exceedsMassMovementGuard(tierMoveRatio, isFirstRun)) {
    await rankingRepo.completeRankingRun(pool, rankingRunId, { status: "held", holdReason: "mass_movement_guard", tierMoveRatio, brawlersEvaluated, brawlersPublished: 0 });
    await withTransaction(pool, async (c) => {
      await writeJobCursor(c, workflowRunId, { ...cursor, phase: "done" });
      await completeWorkflowRun(c, workflowRunId, "held", "mass_movement_guard");
    });
    logSafeInfo("ranking-rebuild", "job_completed", { workflowRunId, outcome: "held_mass_movement", tierMoveRatio });
    return { freshStart: false, done: true, phase: "done", workflowRunId, rankingRunId, outcome: "held_mass_movement", brawlersEvaluated, brawlersPublished: 0, tierMoveRatio };
  }

  if (!hasSignificantChange(comparisons, isFirstRun)) {
    await rankingRepo.completeRankingRun(pool, rankingRunId, { status: "succeeded", holdReason: "no_significant_change", tierMoveRatio, brawlersEvaluated, brawlersPublished: 0 });
    await withTransaction(pool, async (c) => {
      await writeJobCursor(c, workflowRunId, { ...cursor, phase: "done" });
      await completeWorkflowRun(c, workflowRunId, "succeeded");
    });
    logSafeInfo("ranking-rebuild", "job_completed", { workflowRunId, outcome: "no_significant_change", tierMoveRatio });
    return { freshStart: false, done: true, phase: "done", workflowRunId, rankingRunId, outcome: "no_significant_change", brawlersEvaluated, brawlersPublished: 0, tierMoveRatio };
  }

  const { brawlersPublished: publishedCount } = await publishRankingRunFromCandidates(pool, {
    rankingRunId,
    patchId: cursor.patchId,
    patchVersionLabel: cursor.patchVersionLabel,
    calculatedAt: new Date(cursor.nowIso),
    tierMoveRatio,
    brawlersEvaluated,
  });

  await withTransaction(pool, async (c) => {
    await writeJobCursor(c, workflowRunId, { ...cursor, phase: "done" });
    await completeWorkflowRun(c, workflowRunId, "succeeded");
  });
  logSafeInfo("ranking-rebuild", "job_completed", { workflowRunId, outcome: "published", brawlersPublished: publishedCount, tierMoveRatio });
  return { freshStart: false, done: true, phase: "done", workflowRunId, rankingRunId, outcome: "published", brawlersEvaluated, brawlersPublished: publishedCount, tierMoveRatio };
}

// ---------------------------------------------------------------------------
// Shared transactional publication (scheduled publish phase + operator approval)
// ---------------------------------------------------------------------------

export interface PublishFromCandidatesInputs {
  rankingRunId: string;
  patchId: string | null;
  patchVersionLabel: string | null;
  /** The run's original calculation time (from its job cursor), kept immutable across a later approval. */
  calculatedAt: Date;
  tierMoveRatio: number | null;
  brawlersEvaluated: number;
  /** Preserved on the ranking_run so an approved run still records it WAS held (default null = a normal scheduled publish). */
  holdReason?: string | null;
}

export interface PublishFromCandidatesResult {
  snapshotId: string;
  brawlersPublished: number;
}

/**
 * The SINGLE transactional publication of a ranking run's already-computed
 * candidate rows into the public snapshot tables — shared by the scheduled
 * `publish` phase and the operator held-run approval path. In one transaction it
 * supersedes the current snapshot, creates the new one, inserts every
 * publishable overall item (with its nested mode tiers) and every qualifying
 * matchup item, and marks the ranking_run succeeded. Any failure rolls the whole
 * transaction back, so the previous snapshot stays current.
 *
 * It applies NO threshold, mass-movement, or eligibility policy of its own: it
 * publishes exactly the rows whose per-row gates were already decided when the
 * candidate was computed (`meets_floor` + an assigned `tier`). It therefore
 * never re-derives or alters any formula/threshold — the approval path reuses it
 * verbatim, differing only in that it bypasses the *pre-publish* mass-movement
 * hold (the whole point of an operator approval) and records an audit step via
 * `onPublished`, which runs inside the SAME transaction for atomic evidence.
 */
export async function publishRankingRunFromCandidates(
  pool: Pool,
  inputs: PublishFromCandidatesInputs,
  onPublished?: (c: PoolConnection, ctx: { snapshotId: string; brawlersPublished: number }) => Promise<void>
): Promise<PublishFromCandidatesResult> {
  const rows = await rankingRepo.getRankingResultsForRun(pool, inputs.rankingRunId);
  const overallRows = rows.filter((r) => r.gameModeId === null);
  const modeRowsByBrawler = new Map<string, rankingRepo.RunCandidateRow[]>();
  for (const r of rows) {
    if (r.gameModeId === null) continue;
    const list = modeRowsByBrawler.get(r.brawlerId) ?? [];
    list.push(r);
    modeRowsByBrawler.set(r.brawlerId, list);
  }
  const qualifyingMatchups = await rankingRepo.getQualifyingMatchupResults(pool, inputs.rankingRunId);
  const dataLimitationsJson = JSON.stringify({
    methodology: "brawlranks_internal_calculation",
    official_supercell_methodology: false,
    build_data: "unavailable",
    ai_explanation: "not_implemented",
  });

  return withTransaction(pool, async (c) => {
    await rankingRepo.supersedeCurrentSnapshot(c);
    const snapshotId = await rankingRepo.createPublishedSnapshot(c, { rankingRunId: inputs.rankingRunId, patchId: inputs.patchId });

    let count = 0;
    for (const r of overallRows) {
      if (!r.meetsFloor || r.metaScore === null || !r.tier) continue;
      const modeTiers = (modeRowsByBrawler.get(r.brawlerId) ?? [])
        .filter((m) => m.meetsFloor && m.tier)
        .map((m) => ({ gameModeId: m.gameModeId, tier: m.tier, score: m.metaScore, confidence: m.confidence }));
      await rankingRepo.insertPublishedSnapshotItem(c, snapshotId, {
        brawlerId: r.brawlerId,
        overallTier: r.tier,
        overallScore: r.metaScore,
        overallConfidence: r.confidence === "insufficient" ? "low" : r.confidence,
        modeTiersJson: JSON.stringify(modeTiers),
        patchVersionLabel: inputs.patchVersionLabel,
        calculatedAt: inputs.calculatedAt,
        dataLimitationsJson,
      });
      count += 1;
    }

    for (const m of qualifyingMatchups) {
      await rankingRepo.insertPublishedMatchupItem(c, snapshotId, {
        brawlerId: m.brawlerId,
        opponentBrawlerId: m.opponentBrawlerId,
        relationship: m.relationship,
        confidenceLevel: m.confidenceLevel,
        winRate: m.winRate,
        sampleSize: m.matches,
        gameModeId: null,
        patchVersionLabel: inputs.patchVersionLabel,
      });
    }

    await rankingRepo.completeRankingRun(c, inputs.rankingRunId, {
      status: "succeeded",
      holdReason: inputs.holdReason ?? null,
      tierMoveRatio: inputs.tierMoveRatio,
      brawlersEvaluated: inputs.brawlersEvaluated,
      brawlersPublished: count,
    });

    if (onPublished) await onPublished(c, { snapshotId, brawlersPublished: count });
    return { snapshotId, brawlersPublished: count };
  });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Per-call entry point. One bounded slice per call: reconcile stale runs, claim
 * or resume the single ranking-rebuild workflow under a per-slice lock, run
 * exactly one bounded slice, persist the cursor, and ALWAYS release the lock in
 * `finally`. As of Phase 11 this is driven OUT-OF-PROCESS by a standalone
 * DigitalOcean systemd worker (scripts/worker/ranking-worker.ts), not the
 * Hostinger Next.js request thread — the retired HTTP route returns 410.
 *
 * `deps.pool` is an injection seam for tests (default: the DigitalOcean write
 * pool via WRITE_DB_* / writer-role TLS); production/worker never pass it.
 */
export async function stepRankingRebuild(
  triggeredBy: "manual" | "cron",
  batchSize: number = DEFAULT_RANKING_BATCH_SIZE,
  deps: { pool?: Pool } = {}
): Promise<RankingStepResult> {
  const pool = deps.pool ?? getWritePool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
  await reconcileStaleWorkflowRuns(pool, workflowDefinitionId, STALE_JOB_SECONDS);

  const lockRunId = randomUUID();
  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, lockRunId, SLICE_LOCK_TTL_MS);
  if (!lock.acquired) {
    // Another worker invocation holds the lock and is progressing the job.
    // Surface the in-flight run id (read-only) so the caller reports a safe
    // lock_not_acquired — never a second run.
    const active = await findLatestRunningRun(pool, workflowDefinitionId);
    return {
      status: "lock_not_acquired",
      phase: "brawlers",
      outcome: "lock_not_acquired",
      workflowRunId: active?.id,
      activeWorkflowRunId: active?.id,
    };
  }

  try {
    const r = await executeNextRankingSlice(pool, workflowDefinitionId, triggeredBy, clampBatch(batchSize));
    const status: RankingStepResult["status"] = r.freshStart && !r.done ? "started" : r.done ? "completed" : "in_progress";
    return {
      status,
      phase: r.phase,
      workflowRunId: r.workflowRunId,
      rankingRunId: r.rankingRunId,
      outcome: r.outcome,
      brawlersEvaluated: r.brawlersEvaluated,
      brawlersPublished: r.brawlersPublished,
      tierMoveRatio: r.tierMoveRatio,
    };
  } finally {
    await releaseWorkflowLock(pool, workflowDefinitionId, lockRunId);
  }
}

/**
 * Run-to-completion driver: holds the lock once and loops every slice until
 * done. Intended for tests/manual/CLI, NOT the request-limited HTTP path
 * (use stepRankingRebuild there). Return shape unchanged from the original
 * implementation.
 */
export async function runRankingRebuild(
  triggeredBy: "manual" | "cron",
  batchSize: number = DEFAULT_RANKING_BATCH_SIZE
): Promise<RankingRebuildResult> {
  const pool = getWritePool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
  await reconcileStaleWorkflowRuns(pool, workflowDefinitionId, STALE_JOB_SECONDS);

  const lockRunId = randomUUID();
  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, lockRunId, DRIVER_LOCK_TTL_MS);
  if (!lock.acquired) {
    return { outcome: "lock_not_acquired" };
  }

  try {
    let last: SliceOutcome | null = null;
    for (let i = 0; i < MAX_DRIVER_SLICES; i += 1) {
      last = await executeNextRankingSlice(pool, workflowDefinitionId, triggeredBy, clampBatch(batchSize));
      if (last.done) break;
    }
    if (!last || !last.done || !last.outcome) {
      throw new Error("ranking driver did not converge");
    }
    return {
      outcome: last.outcome,
      workflowRunId: last.workflowRunId,
      rankingRunId: last.rankingRunId,
      brawlersEvaluated: last.brawlersEvaluated,
      brawlersPublished: last.brawlersPublished,
      tierMoveRatio: last.tierMoveRatio,
    };
  } finally {
    await releaseWorkflowLock(pool, workflowDefinitionId, lockRunId);
  }
}

function clampBatch(batchSize: number): number {
  if (!Number.isInteger(batchSize) || batchSize <= 0) return DEFAULT_RANKING_BATCH_SIZE;
  return Math.min(batchSize, MAX_RANKING_BATCH_SIZE);
}
