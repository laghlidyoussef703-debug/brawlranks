/**
 * Ranking-rebuild orchestrator (Phase 5.3). Implements the exact MVP
 * decisions from the Phase 5.3 owner-decision report — see
 * lib/ranking/formulas.ts for the individual formulas and
 * lib/ranking/repository.ts for the data-source notes (in particular, why
 * win_rate/pick_rate/high_rank_win_rate read raw participation rows while
 * matchup classification and the aggregation-existence precondition read
 * only the latest aggregation run, per task item 9).
 */

import { getPool } from "@/lib/mysql";
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
} from "@/lib/workflow";

const WORKFLOW_SLUG = "ranking-rebuild";
const PER_PLAYER_CAP = 20;

export interface RankingRebuildResult {
  outcome: "published" | "held_mass_movement" | "no_significant_change" | "no_valid_aggregation" | "no_active_rule_set" | "lock_not_acquired";
  workflowRunId?: string;
  rankingRunId?: string;
  brawlersEvaluated?: number;
  brawlersPublished?: number;
  tierMoveRatio?: number;
}

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

/** Blended win rate for a set of rows, splitting current-patch vs. all-data exactly per decision report item 9. */
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
  overallSlotCount: number;
  highRankWinRate: number | null;
  distinctRegions: number;
  distinctTrophyBrackets: number;
  recentWithin30Days: boolean;
  byMode: Map<string, { matches: number; winRate: number | null; slotCount: number }>;
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
  const byMode = new Map<string, { matches: number; winRate: number | null; slotCount: number }>();
  for (const modeId of modeIds) {
    const modeRows = capped.filter((r) => r.gameModeId === modeId);
    const modeResult = computeBlendedWinRate(modeRows, activePatchId, now);
    byMode.set(modeId, { matches: modeResult.matches, winRate: modeResult.winRate, slotCount: modeRows.length });
  }

  return {
    brawlerId,
    overallMatches: overall.matches,
    overallWinRate: overall.winRate,
    overallSlotCount: capped.length,
    highRankWinRate,
    distinctRegions: regions.size,
    distinctTrophyBrackets: brackets.size,
    recentWithin30Days,
    byMode,
  };
}

export async function runRankingRebuild(triggeredBy: "manual" | "cron"): Promise<RankingRebuildResult> {
  const pool = getPool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
  const workflowRunId = await startWorkflowRun(pool, workflowDefinitionId, triggeredBy === "cron" ? "schedule" : "manual");

  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  if (!lock.acquired) {
    await completeWorkflowRun(pool, workflowRunId, "failed", "lock_not_acquired");
    return { outcome: "lock_not_acquired" };
  }

  try {
    // --- Preconditions (item 9: "fail safely if no valid aggregation exists") ---
    const latestAggregation = await rankingRepo.getLatestSuccessfulAggregation(pool);
    if (!latestAggregation) {
      await completeWorkflowRun(pool, workflowRunId, "failed", "no_valid_aggregation");
      return { outcome: "no_valid_aggregation", workflowRunId };
    }

    const ruleSet = await rankingRepo.getActiveRuleSet(pool);
    if (!ruleSet || !ruleSet.overallTierThreshold) {
      await completeWorkflowRun(pool, workflowRunId, "failed", "no_active_rule_set");
      return { outcome: "no_active_rule_set", workflowRunId };
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

    // --- Per-Brawler raw computation (sequential, one connection — see lib/ranking/repository.ts's data-source note) ---
    const brawlerIds = await rankingRepo.getActiveBrawlerIds(pool);
    const computations: BrawlerComputation[] = [];
    for (const brawlerId of brawlerIds) {
      const rawRows = await rankingRepo.getRawParticipationRows(pool, brawlerId);
      computations.push(computeForBrawler(brawlerId, rawRows, activePatchId, now, ruleSet));
    }

    // --- Matchup coverage input (pooled from the latest aggregation run) ---
    const pooledMatchups = await rankingRepo.getPooledMatchupRows(pool, latestAggregation.matchupAggregationRunId);
    const matchupCoverageByBrawler = new Map<string, number>();
    const matchupClassificationsByPair = new Map<string, ReturnType<typeof classifyMatchup>>();
    const opponentsByBrawler = new Map<string, string[]>();
    for (const row of pooledMatchups) {
      const list = opponentsByBrawler.get(row.brawlerId) ?? [];
      list.push(row.opponentBrawlerId);
      opponentsByBrawler.set(row.brawlerId, list);
      const winRate = computeWinRate(row.wins, row.losses);
      matchupClassificationsByPair.set(`${row.brawlerId}::${row.opponentBrawlerId}`, classifyMatchup(winRate, row.matches));
    }
    for (const [brawlerId, opponents] of opponentsByBrawler) {
      const total = opponents.length;
      const qualifying = opponents.filter((opp) => matchupClassificationsByPair.get(`${brawlerId}::${opp}`) !== null).length;
      matchupCoverageByBrawler.set(brawlerId, total > 0 ? qualifying / total : 0);
    }

    // --- Pick-rate denominators (overall + per-mode), from the capped slot counts already derived above ---
    const overallSlotTotal = computations.reduce((sum, c) => sum + c.overallSlotCount, 0);
    const modeSlotTotals = new Map<string, number>();
    for (const c of computations) {
      for (const [modeId, mode] of c.byMode) {
        modeSlotTotals.set(modeId, (modeSlotTotals.get(modeId) ?? 0) + mode.slotCount);
      }
    }

    const overallWeight = ruleSet.weights["win_rate"];
    const overallFloor = overallWeight?.minSampleSize ?? 100;
    const modeFloor = ruleSet.weights["mode_win_rate"]?.minSampleSize ?? 30;

    // --- Overall scores + eligibility ---
    interface OverallCandidate {
      brawlerId: string;
      matches: number;
      winRate: number | null;
      pickRate: number;
      highRankWinRate: number | null;
      matchupCoverage: number;
      metaScore: number | null;
      meetsFloor: boolean;
      confidence: ConfidenceLabel;
    }
    const overallCandidates: OverallCandidate[] = computations.map((c) => {
      const pickRate = overallSlotTotal > 0 ? c.overallSlotCount / overallSlotTotal : 0;
      const meetsFloor = c.overallMatches >= overallFloor && c.overallWinRate !== null;
      const matchupCoverage = matchupCoverageByBrawler.get(c.brawlerId) ?? 0;
      const metaScore = meetsFloor
        ? computeOverallScore({ winRate: c.overallWinRate as number, pickRate, highRankWinRate: c.highRankWinRate, matchupCoverage })
        : null;
      const confidence = computeOverallConfidence(c.overallMatches, {
        recentBattleWithin30Days: c.recentWithin30Days,
        distinctRegions: c.distinctRegions,
        distinctTrophyBrackets: c.distinctTrophyBrackets,
      });
      return { brawlerId: c.brawlerId, matches: c.overallMatches, winRate: c.overallWinRate, pickRate, highRankWinRate: c.highRankWinRate, matchupCoverage, metaScore, meetsFloor, confidence };
    });

    const eligibleForTiers = overallCandidates.filter((c) => c.meetsFloor && c.metaScore !== null);
    const tiers = assignPercentileTiers(eligibleForTiers.map((c) => c.metaScore as number));
    const tierByBrawlerId = new Map<string, Tier>();
    eligibleForTiers.forEach((c, i) => tierByBrawlerId.set(c.brawlerId, tiers[i]));

    // --- Mode scores + eligibility (per mode, percentile among Brawlers with that mode's data) ---
    interface ModeCandidate {
      brawlerId: string;
      gameModeId: string;
      matches: number;
      winRate: number | null;
      pickRate: number;
      metaScore: number | null;
      meetsFloor: boolean;
      confidence: ConfidenceLabel;
    }
    const modeCandidatesByMode = new Map<string, ModeCandidate[]>();
    for (const c of computations) {
      for (const [modeId, mode] of c.byMode) {
        const slotTotal = modeSlotTotals.get(modeId) ?? 0;
        const pickRate = slotTotal > 0 ? mode.slotCount / slotTotal : 0;
        const meetsFloor = mode.matches >= modeFloor && mode.winRate !== null;
        const metaScore = meetsFloor ? computeModeScore({ modeWinRate: mode.winRate as number, modePickRate: pickRate }) : null;
        const confidence = computeModeConfidence(mode.matches, {
          recentBattleWithin30Days: c.recentWithin30Days,
          distinctRegions: c.distinctRegions,
          distinctTrophyBrackets: c.distinctTrophyBrackets,
        });
        const list = modeCandidatesByMode.get(modeId) ?? [];
        list.push({ brawlerId: c.brawlerId, gameModeId: modeId, matches: mode.matches, winRate: mode.winRate, pickRate, metaScore, meetsFloor, confidence });
        modeCandidatesByMode.set(modeId, list);
      }
    }
    const modeTierByBrawlerAndMode = new Map<string, Tier>();
    for (const [, list] of modeCandidatesByMode) {
      const eligible = list.filter((c) => c.meetsFloor && c.metaScore !== null);
      const modeTiers = assignPercentileTiers(eligible.map((c) => c.metaScore as number));
      eligible.forEach((c, i) => modeTierByBrawlerAndMode.set(`${c.brawlerId}::${c.gameModeId}`, modeTiers[i]));
    }

    // --- Write candidate layer (ranking_results / matchup_results) in one transaction ---
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      for (const c of overallCandidates) {
        const tier = tierByBrawlerId.get(c.brawlerId) ?? null;
        await rankingRepo.insertRankingResult(connection, rankingRunId, {
          brawlerId: c.brawlerId,
          gameModeId: null,
          matches: c.matches,
          winRate: c.winRate,
          pickRate: c.pickRate,
          highRankWinRate: c.highRankWinRate,
          matchupCoverage: c.matchupCoverage,
          metaScore: c.metaScore,
          tier: tier ?? null,
          confidence: c.meetsFloor ? c.confidence : "insufficient",
          meetsFloor: c.meetsFloor,
        });
      }

      for (const [, list] of modeCandidatesByMode) {
        for (const c of list) {
          const tier = modeTierByBrawlerAndMode.get(`${c.brawlerId}::${c.gameModeId}`) ?? null;
          await rankingRepo.insertRankingResult(connection, rankingRunId, {
            brawlerId: c.brawlerId,
            gameModeId: c.gameModeId,
            matches: c.matches,
            winRate: c.winRate,
            pickRate: c.pickRate,
            highRankWinRate: null,
            matchupCoverage: null,
            metaScore: c.metaScore,
            tier: tier ?? null,
            confidence: c.meetsFloor ? c.confidence : "insufficient",
            meetsFloor: c.meetsFloor,
          });
        }
      }

      for (const row of pooledMatchups) {
        const winRate = computeWinRate(row.wins, row.losses);
        const relationship = classifyMatchup(winRate, row.matches);
        const meetsFloor = relationship !== null;
        // Consistency across strata is not independently derivable from the pooled figure alone at this dataset size; treated conservatively as not-yet-established, so classification never overclaims high_confidence_counter it can't actually verify.
        const confidenceLevel = computeMatchupConfidence(row.matches, false);
        await rankingRepo.insertMatchupResult(connection, rankingRunId, {
          brawlerId: row.brawlerId,
          opponentBrawlerId: row.opponentBrawlerId,
          gameModeId: null,
          matches: row.matches,
          winRate,
          relationship,
          confidenceLevel,
          meetsFloor,
        });
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    // --- Publish decision ---
    const isFirstRun = !(await rankingRepo.hasAnyPublishedSnapshot(pool));
    const newTiersMap = tierByBrawlerId;
    let tierMoveRatio = 0;
    let comparisons: ChangeComparison[] = [];

    if (!isFirstRun) {
      const previous = await rankingRepo.getCurrentSnapshotTierInfo(pool);
      const previousTiersMap = new Map(previous.map((p) => [p.brawlerId, p.tier]));
      const previousScoreMap = new Map(previous.map((p) => [p.brawlerId, p.score]));
      tierMoveRatio = computeTierMoveRatio(previousTiersMap, newTiersMap);
      comparisons = eligibleForTiers.map((c) => ({
        brawlerId: c.brawlerId,
        previousTier: previousTiersMap.get(c.brawlerId) ?? null,
        newTier: newTiersMap.get(c.brawlerId) as Tier,
        previousScore: previousScoreMap.get(c.brawlerId) ?? null,
        newScore: c.metaScore as number,
      }));
    }

    if (exceedsMassMovementGuard(tierMoveRatio, isFirstRun)) {
      await rankingRepo.completeRankingRun(pool, rankingRunId, {
        status: "held",
        holdReason: "mass_movement_guard",
        tierMoveRatio,
        brawlersEvaluated: computations.length,
        brawlersPublished: 0,
      });
      await completeWorkflowRun(pool, workflowRunId, "held", "mass_movement_guard");
      return { outcome: "held_mass_movement", workflowRunId, rankingRunId, brawlersEvaluated: computations.length, brawlersPublished: 0, tierMoveRatio };
    }

    if (!hasSignificantChange(comparisons, isFirstRun)) {
      await rankingRepo.completeRankingRun(pool, rankingRunId, {
        status: "succeeded",
        holdReason: "no_significant_change",
        tierMoveRatio,
        brawlersEvaluated: computations.length,
        brawlersPublished: 0,
      });
      await completeWorkflowRun(pool, workflowRunId, "succeeded");
      return { outcome: "no_significant_change", workflowRunId, rankingRunId, brawlersEvaluated: computations.length, brawlersPublished: 0, tierMoveRatio };
    }

    // --- Publish (item 10) ---
    const patchVersionLabel = activePatch?.versionLabel ?? null;
    const dataLimitationsJson = JSON.stringify({
      methodology: "brawlranks_internal_calculation",
      official_supercell_methodology: false,
      build_data: "unavailable",
      ai_explanation: "not_implemented",
    });

    const publishConnection = await pool.getConnection();
    let publishedCount = 0;
    try {
      await publishConnection.beginTransaction();
      await rankingRepo.supersedeCurrentSnapshot(publishConnection);
      const snapshotId = await rankingRepo.createPublishedSnapshot(publishConnection, { rankingRunId, patchId: activePatchId });

      for (const c of overallCandidates) {
        if (!c.meetsFloor || c.metaScore === null) continue;
        const tier = tierByBrawlerId.get(c.brawlerId);
        if (!tier) continue;
        const modeTiers = [...(modeCandidatesByMode.entries())]
          .filter(([, list]) => list.some((m) => m.brawlerId === c.brawlerId && m.meetsFloor))
          .map(([modeId, list]) => {
            const m = list.find((x) => x.brawlerId === c.brawlerId)!;
            return { gameModeId: modeId, tier: modeTierByBrawlerAndMode.get(`${c.brawlerId}::${modeId}`), score: m.metaScore, confidence: m.confidence };
          });

        await rankingRepo.insertPublishedSnapshotItem(publishConnection, snapshotId, {
          brawlerId: c.brawlerId,
          overallTier: tier,
          overallScore: c.metaScore,
          overallConfidence: c.confidence === "insufficient" ? "low" : c.confidence,
          modeTiersJson: JSON.stringify(modeTiers),
          patchVersionLabel,
          calculatedAt: now,
          dataLimitationsJson,
        });
        publishedCount += 1;
      }

      for (const row of pooledMatchups) {
        const winRate = computeWinRate(row.wins, row.losses);
        const relationship = classifyMatchup(winRate, row.matches);
        if (!relationship || winRate === null) continue;
        const confidenceLevel = computeMatchupConfidence(row.matches, false);
        if (confidenceLevel !== "probable_counter" && confidenceLevel !== "high_confidence_counter") continue;
        await rankingRepo.insertPublishedMatchupItem(publishConnection, snapshotId, {
          brawlerId: row.brawlerId,
          opponentBrawlerId: row.opponentBrawlerId,
          relationship,
          confidenceLevel,
          winRate,
          sampleSize: row.matches,
          gameModeId: null,
          patchVersionLabel,
        });
      }

      await publishConnection.commit();
    } catch (error) {
      await publishConnection.rollback();
      throw error;
    } finally {
      publishConnection.release();
    }

    await rankingRepo.completeRankingRun(pool, rankingRunId, {
      status: "succeeded",
      tierMoveRatio,
      brawlersEvaluated: computations.length,
      brawlersPublished: publishedCount,
    });
    await completeWorkflowRun(pool, workflowRunId, "succeeded");

    return { outcome: "published", workflowRunId, rankingRunId, brawlersEvaluated: computations.length, brawlersPublished: publishedCount, tierMoveRatio };
  } catch (error) {
    await completeWorkflowRun(pool, workflowRunId, "failed", error instanceof Error ? error.message : "unknown_error");
    throw error;
  } finally {
    await releaseWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  }
}
