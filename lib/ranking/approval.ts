/**
 * Operator approval for a ranking run held by the mass-movement guard
 * (Phase 11 controlled bootstrap approval — see DATASET.md "Ranking sequence":
 * "On approval, verify exactly one current snapshot, immutable prior snapshots,
 * item counts, and no partial child set").
 *
 * WHY THIS EXISTS
 *   The first DigitalOcean ranking run is compared against the stale 2026-07-16
 *   Hostinger snapshot, so a large tier movement is EXPECTED and the
 *   mass-movement guard (>25% of ranked Brawlers changing tier) legitimately
 *   holds it (observed tierMoveRatio≈0.648, hold_reason=mass_movement_guard,
 *   brawlersPublished=0). Every OTHER quality gate already passed. This module
 *   lets a named operator approve THAT specific held run and publish it, without
 *   ever touching thresholds, formulas, or the guard, and without re-running
 *   ranking.
 *
 * SAFETY MODEL
 *   - Targets ONE explicit rankingRunId; never guesses or defaults a run.
 *   - Refuses unless status='held' AND hold_reason='mass_movement_guard'.
 *   - Idempotent: a run that already has a published_snapshots row is a no-op
 *     (the table's UNIQUE(ranking_run_id) also enforces this at the DB level).
 *   - Re-runs every completeness/quality check on the candidate BEFORE publishing
 *     (all 106 active Brawlers have an overall candidate row, the referenced
 *     aggregation triple is succeeded, matchup child rows exist, at least one
 *     Brawler is publishable).
 *   - Publishes through the SAME transactional publication function the
 *     scheduled path uses (lib/ranking/sync `publishRankingRunFromCandidates`) —
 *     supersede + create + items + complete in ONE transaction, so any failure
 *     preserves the old snapshot.
 *   - Records who/why/when + an evidence hash as an `operator_approval`
 *     workflow_step INSIDE the publish transaction (atomic audit).
 *   - Preserves the run's immutable calculatedAt / patch label by reading them
 *     from the run's persisted job cursor (never invents a timestamp).
 */

import { createHash } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { getWritePool } from "@/lib/mysql";
import { logSafeInfo } from "@/lib/errors";
import * as rankingRepo from "@/lib/ranking/repository";
import { readJobCursor, recordWorkflowStep } from "@/lib/workflow";
import { publishRankingRunFromCandidates } from "@/lib/ranking/sync";
import { exceedsMassMovementGuard } from "@/lib/ranking/formulas";

const REQUIRED_HOLD_REASON = "mass_movement_guard";
const APPROVAL_STEP_NAME = "operator_approval";
/** workflow_steps.step_order 0 is the job cursor; the approval audit uses a distinct fixed slot so re-approval upserts the SAME row (idempotent). */
const APPROVAL_STEP_ORDER = 100;
const SUCCEEDED_AGG = new Set(["succeeded", "succeeded_with_warnings"]);
/** Mirrors lib/ranking/formulas exceedsMassMovementGuard's >0.25 rule — recorded as evidence only, never re-applied to alter the decision. */
const MASS_MOVEMENT_THRESHOLD = 0.25;

/** A recoverable operator/validation error (bad input, wrong state) — distinct from an unexpected crash. Carries no secrets. */
export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

export type ApproveOutcome = "published" | "already_published" | "validated";

export interface ApproveEvidence {
  activeBrawlers: number;
  overallCandidateRows: number;
  modeCandidateRows: number;
  matchupResultRows: number;
  qualifyingMatchups: number;
  publishableBrawlers: number;
  tierMoveRatio: number | null;
  massMovementThreshold: number;
  guardWouldHold: boolean;
  aggregationRunIds: { mode: string; overall: string; matchup: string };
  ruleSetId: string;
  evidenceHash: string;
}

export interface ApproveResult {
  outcome: ApproveOutcome;
  rankingRunId: string;
  workflowRunId: string;
  snapshotId?: string;
  brawlersPublished: number;
  approvedBy: string;
  reason: string;
  approvedAt: string;
  evidence: ApproveEvidence;
}

export interface ApproveParams {
  rankingRunId: string;
  approvedBy: string;
  reason: string;
}

export interface ApproveOptions {
  pool?: Pool;
  /** Run every check and compute evidence, but publish nothing (operator pre-flight). */
  dryRun?: boolean;
}

interface CursorShape {
  rankingRunId?: string;
  patchId?: string | null;
  patchVersionLabel?: string | null;
  nowIso?: string;
}

/**
 * Validate a held run and (unless dryRun) publish it under operator approval.
 * Throws {@link ApprovalError} for any invalid input, wrong state, or incomplete
 * candidate; the caller maps that to a nonzero exit. Returns `already_published`
 * as a safe no-op when the run was already published.
 */
export async function approveHeldRanking(params: ApproveParams, opts: ApproveOptions = {}): Promise<ApproveResult> {
  const rankingRunId = (params.rankingRunId ?? "").trim();
  const approvedBy = (params.approvedBy ?? "").trim();
  const reason = (params.reason ?? "").trim();
  if (!rankingRunId) throw new ApprovalError("a non-empty --ranking-run-id is required");
  if (!approvedBy) throw new ApprovalError("a non-empty --approved-by is required (records who approved)");
  if (!reason) throw new ApprovalError("a non-empty --reason is required (records why)");

  const pool = opts.pool ?? getWritePool();
  const approvedAt = new Date().toISOString();

  // 1. The run must exist.
  const run = await rankingRepo.getRankingRunById(pool, rankingRunId);
  if (!run) throw new ApprovalError(`unknown ranking run: ${rankingRunId}`);

  // 2. Idempotency: already published -> safe no-op (never republish/supersede).
  const existing = await rankingRepo.getPublishedSnapshotByRankingRun(pool, rankingRunId);
  if (existing) {
    const evidence = await buildEvidence(pool, run);
    logSafeInfo("ranking-approval", "already_published", { rankingRunId, snapshotId: existing.id });
    return {
      outcome: "already_published",
      rankingRunId,
      workflowRunId: run.workflowRunId,
      snapshotId: existing.id,
      brawlersPublished: run.brawlersPublished ?? 0,
      approvedBy,
      reason,
      approvedAt,
      evidence,
    };
  }

  // 3. State gate: only a mass-movement HOLD may be operator-approved.
  if (run.status !== "held") {
    throw new ApprovalError(`ranking run ${rankingRunId} is not held (status=${run.status}); refusing to publish`);
  }
  if (run.holdReason !== REQUIRED_HOLD_REASON) {
    throw new ApprovalError(`ranking run ${rankingRunId} hold_reason is '${run.holdReason ?? "null"}', expected '${REQUIRED_HOLD_REASON}'`);
  }

  // 4. The referenced aggregation triple must genuinely be succeeded.
  const aggStatuses = await rankingRepo.getAggregationRunStatuses(pool, [
    run.modeAggregationRunId,
    run.overallAggregationRunId,
    run.matchupAggregationRunId,
  ]);
  for (const [label, id] of [
    ["mode", run.modeAggregationRunId],
    ["overall", run.overallAggregationRunId],
    ["matchup", run.matchupAggregationRunId],
  ] as const) {
    const status = aggStatuses.get(id);
    if (!status || !SUCCEEDED_AGG.has(status)) {
      throw new ApprovalError(`referenced ${label} aggregation run ${id} is not succeeded (status=${status ?? "missing"})`);
    }
  }

  // 5. Recover the run's immutable calculatedAt / patch label from its cursor.
  const cursor = await readJobCursor<CursorShape>(pool, run.workflowRunId);
  if (!cursor || !cursor.nowIso) {
    throw new ApprovalError(`job cursor missing for workflow run ${run.workflowRunId}; cannot recover the run's immutable calculatedAt/patch label`);
  }
  if (cursor.rankingRunId && cursor.rankingRunId !== rankingRunId) {
    throw new ApprovalError(`job cursor rankingRunId (${cursor.rankingRunId}) does not match ${rankingRunId}`);
  }
  const calculatedAt = new Date(cursor.nowIso);
  if (Number.isNaN(calculatedAt.getTime())) {
    throw new ApprovalError(`job cursor nowIso is not a valid date: ${cursor.nowIso}`);
  }

  // 6. Completeness / quality checks on the held candidate.
  const activeBrawlerIds = await rankingRepo.getActiveBrawlerIds(pool);
  const activeCount = activeBrawlerIds.length;
  if (activeCount === 0) throw new ApprovalError("no active brawlers found; refusing to publish an empty tier list");

  const candidateRows = await rankingRepo.getRankingResultsForRun(pool, rankingRunId);
  const overallRows = candidateRows.filter((r) => r.gameModeId === null);
  const modeRows = candidateRows.filter((r) => r.gameModeId !== null);
  const overallBrawlerIds = new Set(overallRows.map((r) => r.brawlerId));

  const missing = activeBrawlerIds.filter((id) => !overallBrawlerIds.has(id));
  if (missing.length > 0) {
    throw new ApprovalError(`incomplete candidate: ${missing.length}/${activeCount} active brawlers have no overall ranking_result row`);
  }
  if (overallRows.length !== activeCount) {
    throw new ApprovalError(`candidate has ${overallRows.length} overall rows but there are ${activeCount} active brawlers`);
  }
  if (run.brawlersEvaluated !== activeCount) {
    throw new ApprovalError(`ranking_run.brawlers_evaluated (${run.brawlersEvaluated}) does not match active brawler count (${activeCount})`);
  }

  const matchupResultRows = await rankingRepo.countMatchupResults(pool, rankingRunId);
  if (matchupResultRows === 0) {
    throw new ApprovalError("incomplete candidate: no matchup_results rows for the run (missing matchup child set)");
  }

  const publishable = overallRows.filter((r) => r.meetsFloor && r.metaScore !== null && r.tier);
  if (publishable.length === 0) {
    throw new ApprovalError("candidate not representative: no brawler meets the sample floor with an assigned tier (nothing publishable)");
  }
  // Defensive: a publishable row with a null tier/score would corrupt the snapshot.
  for (const r of publishable) {
    if (!r.tier || r.metaScore === null) {
      throw new ApprovalError(`internal: publishable row for ${r.brawlerId} has null tier/score`);
    }
  }

  const qualifyingMatchups = await rankingRepo.getQualifyingMatchupResults(pool, rankingRunId);
  const evidence = buildEvidenceFromParts(run, {
    activeBrawlers: activeCount,
    overallCandidateRows: overallRows.length,
    modeCandidateRows: modeRows.length,
    matchupResultRows,
    qualifyingMatchups: qualifyingMatchups.length,
    publishableBrawlers: publishable.length,
  });

  if (opts.dryRun) {
    logSafeInfo("ranking-approval", "validated", { rankingRunId, publishable: publishable.length, evidenceHash: evidence.evidenceHash });
    return {
      outcome: "validated",
      rankingRunId,
      workflowRunId: run.workflowRunId,
      brawlersPublished: 0,
      approvedBy,
      reason,
      approvedAt,
      evidence,
    };
  }

  // 7. Publish transactionally through the shared publication function, recording
  //    the approval evidence step inside the SAME transaction.
  const published = await publishRankingRunFromCandidates(
    pool,
    {
      rankingRunId,
      patchId: cursor.patchId ?? run.patchId,
      patchVersionLabel: cursor.patchVersionLabel ?? null,
      calculatedAt,
      tierMoveRatio: run.tierMoveRatio,
      brawlersEvaluated: activeCount,
      holdReason: REQUIRED_HOLD_REASON, // preserve that this run WAS held
    },
    async (c, ctx) => {
      await recordWorkflowStep(c, run.workflowRunId, APPROVAL_STEP_NAME, APPROVAL_STEP_ORDER, "succeeded", {
        approvedBy,
        reason,
        approvedAt,
        rankingRunId,
        snapshotId: ctx.snapshotId,
        brawlersPublished: ctx.brawlersPublished,
        heldReason: REQUIRED_HOLD_REASON,
        evidence,
      });
    }
  );

  logSafeInfo("ranking-approval", "published", {
    rankingRunId,
    workflowRunId: run.workflowRunId,
    snapshotId: published.snapshotId,
    brawlersPublished: published.brawlersPublished,
    approvedBy,
    evidenceHash: evidence.evidenceHash,
  });

  return {
    outcome: "published",
    rankingRunId,
    workflowRunId: run.workflowRunId,
    snapshotId: published.snapshotId,
    brawlersPublished: published.brawlersPublished,
    approvedBy,
    reason,
    approvedAt,
    evidence,
  };
}

/** Evidence for the already-published no-op path (counts read fresh from the DB). */
async function buildEvidence(pool: Pool, run: rankingRepo.RankingRunRow): Promise<ApproveEvidence> {
  const activeBrawlerIds = await rankingRepo.getActiveBrawlerIds(pool);
  const candidateRows = await rankingRepo.getRankingResultsForRun(pool, run.id);
  const overallRows = candidateRows.filter((r) => r.gameModeId === null);
  const modeRows = candidateRows.filter((r) => r.gameModeId !== null);
  const matchupResultRows = await rankingRepo.countMatchupResults(pool, run.id);
  const qualifyingMatchups = await rankingRepo.getQualifyingMatchupResults(pool, run.id);
  const publishable = overallRows.filter((r) => r.meetsFloor && r.metaScore !== null && r.tier);
  return buildEvidenceFromParts(run, {
    activeBrawlers: activeBrawlerIds.length,
    overallCandidateRows: overallRows.length,
    modeCandidateRows: modeRows.length,
    matchupResultRows,
    qualifyingMatchups: qualifyingMatchups.length,
    publishableBrawlers: publishable.length,
  });
}

function buildEvidenceFromParts(
  run: rankingRepo.RankingRunRow,
  parts: {
    activeBrawlers: number;
    overallCandidateRows: number;
    modeCandidateRows: number;
    matchupResultRows: number;
    qualifyingMatchups: number;
    publishableBrawlers: number;
  }
): ApproveEvidence {
  const aggregationRunIds = {
    mode: run.modeAggregationRunId,
    overall: run.overallAggregationRunId,
    matchup: run.matchupAggregationRunId,
  };
  // Deterministic evidence hash over the identifying run + count fields — a
  // stable fingerprint recorded with the approval (DATASET "hashes/counts").
  const canonical = JSON.stringify({
    rankingRunId: run.id,
    ruleSetId: run.rankingRuleSetId,
    aggregationRunIds,
    activeBrawlers: parts.activeBrawlers,
    overallCandidateRows: parts.overallCandidateRows,
    modeCandidateRows: parts.modeCandidateRows,
    matchupResultRows: parts.matchupResultRows,
    qualifyingMatchups: parts.qualifyingMatchups,
    publishableBrawlers: parts.publishableBrawlers,
    tierMoveRatio: run.tierMoveRatio,
  });
  const evidenceHash = createHash("sha256").update(canonical).digest("hex");
  return {
    ...parts,
    tierMoveRatio: run.tierMoveRatio,
    massMovementThreshold: MASS_MOVEMENT_THRESHOLD,
    guardWouldHold: exceedsMassMovementGuard(run.tierMoveRatio ?? 0, false),
    aggregationRunIds,
    ruleSetId: run.rankingRuleSetId,
    evidenceHash,
  };
}
