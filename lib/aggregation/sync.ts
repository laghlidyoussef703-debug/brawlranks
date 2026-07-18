/**
 * Statistical aggregation orchestrator (Phase 5.2 — BRAWLRANKS_WEBSITE_SPEC.md
 * Section 7.8, workflow cadence per Section 7.22/15's "Statistical
 * aggregation | Every 6-12 hours"). Computes only the metrics defined with
 * a concrete formula and no outstanding owner decision — see migration
 * 0022's header for the full scope explanation. Reads normalized_battles/
 * battle_participants/battle_teams only — never mutates Phase 3/4
 * collection tables.
 *
 * DURABLE, RESUMABLE EXECUTION (Phase 5 timeout fix — see PHASE5.md
 * "Durable batched execution"): the previous monolithic "one HTTP request,
 * one transaction, compute-then-insert-every-row" design had a runtime that
 * grew with the dataset and eventually exceeded the ~60s Hostinger request
 * limit (production 504). It is replaced by a bounded-batch state machine:
 *
 *   - A job spans MANY short HTTP calls. Each call does ONE small slice —
 *     a set-based `INSERT ... SELECT` for a bounded batch of brawler_ids in
 *     one of the phases (mode -> overall -> matchup -> finalize) — inside a
 *     single transaction, then advances a resume cursor persisted in the
 *     job's workflow_steps row. Every call returns well under the limit.
 *   - `stepAggregation` is the per-call HTTP entry point (returns
 *     started/in_progress/completed). `runAggregation` is a run-to-completion
 *     driver (used by tests/manual/CLI where no request limit applies) that
 *     holds the lock once and loops every slice; its return shape is
 *     unchanged, so existing behavior and callers stay compatible.
 *
 * Idempotency/failure-safety model: each slice's INSERT and its cursor
 * advance commit together in one transaction, so an interrupted slice rolls
 * back atomically and the next call re-runs exactly that batch — never a
 * partial or double write. Every write is append-only (a fresh
 * aggregation_runs id per job, never an update to a prior run's rows —
 * Section 7.20's "Append-only per patch/window"). An aggregation is only
 * ever visible to the ranking layer once its workflow_run is 'succeeded'
 * AND all three scoped aggregation_runs are 'succeeded', so a half-finished
 * (still-'running') job is never read as the latest valid aggregation.
 * Overlapping calls are serialized by this workflow's workflow_locks entry;
 * abandoned jobs are reclaimed by reconcileStaleWorkflowRuns.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection } from "mysql2/promise";
import { getPool } from "@/lib/mysql";
import * as aggRepo from "@/lib/aggregation/repository";
import { logSafeInfo } from "@/lib/errors";
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

const WORKFLOW_SLUG = "statistical-aggregation";

export const DEFAULT_AGGREGATION_BATCH_SIZE = 8;
export const MAX_AGGREGATION_BATCH_SIZE = 50;

/** Per-HTTP-call lock TTL: comfortably longer than one bounded slice, shorter than the scheduled resume interval so an abandoned lock frees itself quickly. */
const SLICE_LOCK_TTL_MS = 2 * 60_000;
/** Driver (run-to-completion) lock TTL: covers a whole in-process loop over all slices; used only where no request limit applies. */
const DRIVER_LOCK_TTL_MS = 15 * 60_000;
/** A 'running' job whose heartbeat is older than this is treated as abandoned and reclaimed so a fresh job can start. Longer than any realistic gap between scheduled resume calls. */
const STALE_JOB_SECONDS = 15 * 60;
/** Sanity cap on driver loop iterations — bounded work can never legitimately exceed this. */
const MAX_DRIVER_SLICES = 1_000_000;

type AggregationPhase = "mode" | "overall" | "matchup" | "finalize" | "done";

interface AggregationCursor {
  phase: AggregationPhase;
  runIds: { mode: string; overall: string; matchup: string };
  /** Last processed brawler_id within the current phase (null = start of phase). */
  brawlerCursor: string | null;
}

export type AggregationRunStatus = "succeeded" | "succeeded_with_warnings";

export interface AggregationResult {
  outcome: AggregationRunStatus | "lock_not_acquired";
  workflowRunId?: string;
  modeAggregateCount: number;
  overallAggregateCount: number;
  matchupAggregateCount: number;
  reconciliationWarnings: number;
}

export interface AggregationStepResult {
  status: "started" | "in_progress" | "completed" | "lock_not_acquired";
  phase: AggregationPhase;
  workflowRunId?: string;
  outcome?: AggregationRunStatus;
  modeAggregateCount?: number;
  overallAggregateCount?: number;
  matchupAggregateCount?: number;
  reconciliationWarnings?: number;
}

interface SliceOutcome {
  freshStart: boolean;
  done: boolean;
  phase: AggregationPhase;
  workflowRunId: string;
  outcome?: AggregationRunStatus;
  modeAggregateCount?: number;
  overallAggregateCount?: number;
  matchupAggregateCount?: number;
  reconciliationWarnings?: number;
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

/**
 * Executes exactly one bounded slice of the aggregation job and returns its
 * result. The caller MUST already hold this workflow's lock (both entry
 * points below do) — this function never acquires or releases it, so it can
 * be reused by both the per-call HTTP path and the run-to-completion driver.
 */
async function executeNextAggregationSlice(
  pool: Pool,
  workflowDefinitionId: string,
  triggeredBy: "manual" | "cron",
  batchSize: number
): Promise<SliceOutcome> {
  const running = await findLatestRunningRun(pool, workflowDefinitionId);

  // --- Fresh start: create the run, its three scoped aggregation_runs, and the initial cursor atomically. ---
  if (!running) {
    const workflowRunId = await withTransaction(pool, async (c) => {
      const runId = await startWorkflowRun(c, workflowDefinitionId, triggeredBy === "cron" ? "schedule" : "manual");
      const mode = await aggRepo.createAggregationRun(c, { workflowRunId: runId, scope: "per_mode" });
      const overall = await aggRepo.createAggregationRun(c, { workflowRunId: runId, scope: "overall" });
      const matchup = await aggRepo.createAggregationRun(c, { workflowRunId: runId, scope: "matchup" });
      const cursor: AggregationCursor = { phase: "mode", runIds: { mode, overall, matchup }, brawlerCursor: null };
      await writeJobCursor(c, runId, cursor);
      return runId;
    });
    logSafeInfo("aggregation-run", "job_started", { workflowRunId, batchSize });
    return { freshStart: true, done: false, phase: "mode", workflowRunId, ...emptyCounts() };
  }

  const workflowRunId = running.id;
  const cursor = await readJobCursor<AggregationCursor>(pool, workflowRunId);
  if (!cursor) {
    // A run that started but never wrote its cursor (crashed in the tiny init
    // window). Fail it so the next call starts a clean job; do not attempt a
    // guess-based resume without the scoped run ids.
    await completeWorkflowRun(pool, workflowRunId, "failed", "missing_cursor");
    logSafeInfo("aggregation-run", "job_failed_missing_cursor", { workflowRunId });
    return { freshStart: false, done: false, phase: "mode", workflowRunId, ...emptyCounts() };
  }

  if (cursor.phase === "finalize") {
    return finalizeAggregation(pool, workflowRunId, cursor);
  }
  if (cursor.phase === "done") {
    // Defensive: a 'done' cursor on a still-'running' run should not happen;
    // treat as finalize to converge.
    return finalizeAggregation(pool, workflowRunId, cursor);
  }

  // --- Per-brawler-batch phases: mode -> overall -> matchup ---
  const batch = await aggRepo.getActiveBrawlerIdBatch(pool, cursor.brawlerCursor, batchSize);
  if (batch.length === 0) {
    const nextPhase: AggregationPhase = cursor.phase === "mode" ? "overall" : cursor.phase === "overall" ? "matchup" : "finalize";
    const advanced: AggregationCursor = { ...cursor, phase: nextPhase, brawlerCursor: null };
    await withTransaction(pool, (c) => writeJobCursor(c, workflowRunId, advanced));
    logSafeInfo("aggregation-run", "phase_advance", { workflowRunId, from: cursor.phase, to: nextPhase });
    return { freshStart: false, done: false, phase: nextPhase, workflowRunId, ...emptyCounts() };
  }

  await withTransaction(pool, async (c) => {
    if (cursor.phase === "mode") await aggRepo.insertModeAggregatesForBrawlers(c, cursor.runIds.mode, batch);
    else if (cursor.phase === "overall") await aggRepo.insertOverallAggregatesForBrawlers(c, cursor.runIds.overall, batch);
    else await aggRepo.insertMatchupAggregatesForBrawlers(c, cursor.runIds.matchup, batch);
    const advanced: AggregationCursor = { ...cursor, brawlerCursor: batch[batch.length - 1] };
    await writeJobCursor(c, workflowRunId, advanced);
  });
  logSafeInfo("aggregation-run", "batch_processed", { workflowRunId, phase: cursor.phase, brawlers: batch.length, cursor: batch[batch.length - 1] });
  return { freshStart: false, done: false, phase: cursor.phase, workflowRunId, ...emptyCounts() };
}

async function finalizeAggregation(pool: Pool, workflowRunId: string, cursor: AggregationCursor): Promise<SliceOutcome> {
  const modeCount = await aggRepo.countAggregateRows(pool, "brawler_mode_aggregates", cursor.runIds.mode);
  const overallCount = await aggRepo.countAggregateRows(pool, "brawler_overall_aggregates", cursor.runIds.overall);
  const matchupCount = await aggRepo.countAggregateRows(pool, "matchup_aggregates", cursor.runIds.matchup);

  const modeWarnings = await aggRepo.countReconciliationWarnings(pool, "battle", "brawler_mode_aggregates", cursor.runIds.mode);
  const overallWarnings = await aggRepo.countReconciliationWarnings(pool, "battle", "brawler_overall_aggregates", cursor.runIds.overall);
  const matchupWarnings = await aggRepo.countReconciliationWarnings(pool, "matchup", "matchup_aggregates", cursor.runIds.matchup);
  const totalWarnings = modeWarnings + overallWarnings + matchupWarnings;
  const runStatus: AggregationRunStatus = totalWarnings > 0 ? "succeeded_with_warnings" : "succeeded";

  await withTransaction(pool, async (c) => {
    await aggRepo.completeAggregationRun(c, cursor.runIds.mode, runStatus, modeCount);
    await aggRepo.completeAggregationRun(c, cursor.runIds.overall, runStatus, overallCount);
    await aggRepo.completeAggregationRun(c, cursor.runIds.matchup, runStatus, matchupCount);
    await writeJobCursor(c, workflowRunId, { ...cursor, phase: "done" } as AggregationCursor);
    await completeWorkflowRun(c, workflowRunId, runStatus);
  });
  logSafeInfo("aggregation-run", "job_completed", { workflowRunId, outcome: runStatus, modeCount, overallCount, matchupCount, reconciliationWarnings: totalWarnings });

  return {
    freshStart: false,
    done: true,
    phase: "done",
    workflowRunId,
    outcome: runStatus,
    modeAggregateCount: modeCount,
    overallAggregateCount: overallCount,
    matchupAggregateCount: matchupCount,
    reconciliationWarnings: totalWarnings,
  };
}

function emptyCounts() {
  return { modeAggregateCount: 0, overallAggregateCount: 0, matchupAggregateCount: 0, reconciliationWarnings: 0 };
}

/**
 * Per-HTTP-call entry point (the cron route calls this). Acquires the lock,
 * runs exactly one bounded slice, releases the lock, and reports honest
 * progress. A subsequent scheduled call resumes from the persisted cursor;
 * `completed` signals the job is done and the aggregation is now a valid
 * input for ranking.
 */
export async function stepAggregation(
  triggeredBy: "manual" | "cron",
  batchSize: number = DEFAULT_AGGREGATION_BATCH_SIZE
): Promise<AggregationStepResult> {
  const pool = getPool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
  await reconcileStaleWorkflowRuns(pool, workflowDefinitionId, STALE_JOB_SECONDS);

  const lockRunId = randomUUID();
  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, lockRunId, SLICE_LOCK_TTL_MS);
  if (!lock.acquired) {
    return { status: "lock_not_acquired", phase: "mode" };
  }

  try {
    const r = await executeNextAggregationSlice(pool, workflowDefinitionId, triggeredBy, clampBatch(batchSize));
    const status: AggregationStepResult["status"] = r.freshStart ? "started" : r.done ? "completed" : "in_progress";
    return {
      status,
      phase: r.phase,
      workflowRunId: r.workflowRunId,
      outcome: r.outcome,
      modeAggregateCount: r.modeAggregateCount,
      overallAggregateCount: r.overallAggregateCount,
      matchupAggregateCount: r.matchupAggregateCount,
      reconciliationWarnings: r.reconciliationWarnings,
    };
  } finally {
    await releaseWorkflowLock(pool, workflowDefinitionId, lockRunId);
  }
}

/**
 * Run-to-completion driver: holds the lock once and loops every slice until
 * the job is done. Intended for tests, manual invocation, and CLI — NOT for
 * the request-limited HTTP path (use stepAggregation there). Return shape is
 * unchanged from the original monolithic implementation, so existing callers
 * and integration tests remain compatible.
 */
export async function runAggregation(
  triggeredBy: "manual" | "cron",
  batchSize: number = DEFAULT_AGGREGATION_BATCH_SIZE
): Promise<AggregationResult> {
  const pool = getPool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
  await reconcileStaleWorkflowRuns(pool, workflowDefinitionId, STALE_JOB_SECONDS);

  const lockRunId = randomUUID();
  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, lockRunId, DRIVER_LOCK_TTL_MS);
  if (!lock.acquired) {
    return { outcome: "lock_not_acquired", ...emptyCounts() };
  }

  try {
    let last: SliceOutcome | null = null;
    for (let i = 0; i < MAX_DRIVER_SLICES; i += 1) {
      last = await executeNextAggregationSlice(pool, workflowDefinitionId, triggeredBy, clampBatch(batchSize));
      if (last.done) break;
    }
    if (!last || !last.done || !last.outcome) {
      throw new Error("aggregation driver did not converge");
    }
    return {
      outcome: last.outcome,
      workflowRunId: last.workflowRunId,
      modeAggregateCount: last.modeAggregateCount ?? 0,
      overallAggregateCount: last.overallAggregateCount ?? 0,
      matchupAggregateCount: last.matchupAggregateCount ?? 0,
      reconciliationWarnings: last.reconciliationWarnings ?? 0,
    };
  } finally {
    await releaseWorkflowLock(pool, workflowDefinitionId, lockRunId);
  }
}

function clampBatch(batchSize: number): number {
  if (!Number.isInteger(batchSize) || batchSize <= 0) return DEFAULT_AGGREGATION_BATCH_SIZE;
  return Math.min(batchSize, MAX_AGGREGATION_BATCH_SIZE);
}
