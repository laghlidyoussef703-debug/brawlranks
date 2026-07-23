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
 *     job's workflow_steps row.
 *   - `stepAggregation` is the per-call HTTP entry point. It NEVER runs the
 *     heavy set-based aggregate SQL on the request thread (that query scans
 *     the whole battle history and, even for a small brawler batch, can exceed
 *     the ~55s Hostinger/nginx gateway timeout — the original 504). Instead it
 *     returns within a few seconds with an honest state:
 *       * fresh job        -> claim only (create run + scoped runs + cursor) -> `started`
 *       * mode/overall/matchup phase -> hand the lock to an INTENTIONAL,
 *         OBSERVABLE background continuation (`runBackgroundBatch`) that runs
 *         one bounded slice, advances the cursor heartbeat, and always releases
 *         the lock -> `in_progress`
 *       * finalize (bounded by aggregate-row counts, not battle history; light)
 *         -> run inline and complete the run -> `completed`
 *       * a slice already in flight (lock held) -> `already_running` (safe
 *         non-error; NEVER a second run)
 *     The scheduler simply calls this endpoint repeatedly until `completed`.
 *   - `runAggregation` is a run-to-completion driver (used by tests/manual/CLI
 *     where no request limit applies) that holds the lock once and loops every
 *     slice on the calling thread; its return shape is unchanged, so existing
 *     behavior and callers stay compatible.
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
import { getWritePool } from "@/lib/mysql";
import * as aggRepo from "@/lib/aggregation/repository";
import { logSafeInfo, logSafeError } from "@/lib/errors";
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

/**
 * Lock TTL for a HELD slice. It must comfortably exceed the wall-clock time of
 * ONE bounded unit of work — a single background aggregate batch on the HTTP
 * path, or a whole run-to-completion driver loop — so the lock can NEVER expire
 * mid-slice and let a concurrent call clear it and start a second batch on the
 * same run (which would double-write that run's rows). A bounded batch (<= MAX
 * brawlers) always completes well inside this. It is also short enough that a
 * crashed holder frees the lock within the stale-reclaim window below, so the
 * workflow self-heals instead of wedging.
 */
const HELD_LOCK_TTL_MS = 15 * 60_000;
/** A 'running' job whose heartbeat is older than this is treated as abandoned and reclaimed so a fresh job can start. Longer than any realistic gap between scheduled resume calls, and >= one bounded slice's runtime. */
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
  /** The honest, HTTP-safe state of the job after this call. */
  status: "started" | "in_progress" | "already_running" | "completed" | "failed";
  phase: AggregationPhase;
  workflowRunId?: string;
  /** Present on `already_running`: the id of the run whose slice currently holds the lock (overlap guard; read-only, never a second run). */
  activeWorkflowRunId?: string;
  outcome?: AggregationRunStatus;
  modeAggregateCount?: number;
  overallAggregateCount?: number;
  matchupAggregateCount?: number;
  reconciliationWarnings?: number;
  /**
   * Detached background-continuation promise, present ONLY when
   * status === "in_progress" and a heavy slice was dispatched. The HTTP route
   * MUST NOT await this (that is the whole point — the request returns while
   * the slice runs). Tests await it to drive the state machine deterministically.
   * Never rejects.
   */
  backgroundSlice?: Promise<void>;
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
 * Fresh-start CLAIM: create the workflow_run, its three scoped
 * aggregation_runs, and the initial cursor atomically, then return the new
 * run id. This is the ONLY synchronous work the HTTP trigger does for a fresh
 * job — no heavy aggregate SQL runs here, so the trigger returns `started`
 * within milliseconds. The caller MUST already hold the workflow lock (so the
 * fresh-vs-resume decision cannot race a concurrent call).
 */
async function claimFreshJob(
  pool: Pool,
  workflowDefinitionId: string,
  triggeredBy: "manual" | "cron"
): Promise<string> {
  const workflowRunId = await withTransaction(pool, async (c) => {
    const runId = await startWorkflowRun(c, workflowDefinitionId, triggeredBy === "cron" ? "schedule" : "manual");
    const mode = await aggRepo.createAggregationRun(c, { workflowRunId: runId, scope: "per_mode" });
    const overall = await aggRepo.createAggregationRun(c, { workflowRunId: runId, scope: "overall" });
    const matchup = await aggRepo.createAggregationRun(c, { workflowRunId: runId, scope: "matchup" });
    const cursor: AggregationCursor = { phase: "mode", runIds: { mode, overall, matchup }, brawlerCursor: null };
    await writeJobCursor(c, runId, cursor);
    return runId;
  });
  logSafeInfo("aggregation-run", "job_started", { workflowRunId });
  return workflowRunId;
}

/**
 * One bounded per-brawler-batch slice for the mode -> overall -> matchup
 * phases: process the next `batchSize` active brawlers of the current phase,
 * or — when the phase's brawlers are exhausted — advance the cursor to the
 * next phase. The HEAVY set-based `INSERT ... SELECT` lives here; on the HTTP
 * path this only ever runs inside the background continuation, never the
 * request thread. The INSERT and the cursor advance commit together, so an
 * interrupted slice rolls back atomically and the next call re-runs exactly
 * this batch — never a partial or double write. The caller MUST hold the lock.
 */
async function runOneBatchOrAdvance(
  pool: Pool,
  workflowRunId: string,
  cursor: AggregationCursor,
  batchSize: number
): Promise<SliceOutcome> {
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

/**
 * Executes exactly one bounded slice of the aggregation job and returns its
 * result — the run-to-completion driver's per-iteration step. The caller MUST
 * already hold this workflow's lock; this never acquires or releases it. The
 * HTTP path does NOT use this (it dispatches slices individually so it can keep
 * the heavy batch off the request thread); only `runAggregation` calls it.
 */
async function executeNextAggregationSlice(
  pool: Pool,
  workflowDefinitionId: string,
  triggeredBy: "manual" | "cron",
  batchSize: number
): Promise<SliceOutcome> {
  const running = await findLatestRunningRun(pool, workflowDefinitionId);
  if (!running) {
    const workflowRunId = await claimFreshJob(pool, workflowDefinitionId, triggeredBy);
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

  // finalize (or, defensively, a 'done' cursor on a still-'running' run) -> converge.
  if (cursor.phase === "finalize" || cursor.phase === "done") {
    return finalizeAggregation(pool, workflowRunId, cursor);
  }

  return runOneBatchOrAdvance(pool, workflowRunId, cursor, batchSize);
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
 * INTENTIONAL, OBSERVABLE background continuation of exactly ONE bounded
 * aggregate slice. It OWNS the workflow lock handed to it by stepAggregation
 * and ALWAYS releases it — after a successful slice, after a slice error (whose
 * own transaction has already rolled back atomically, so no partial write
 * survives and the next call re-runs the same batch), or after marking the run
 * failed. It NEVER rejects: a detached continuation must not surface an
 * unhandled rejection that could crash the process. Progress is observable via
 * the cursor heartbeat (workflow_steps) the slice advances; a failure is
 * observable via workflow_runs.error_summary. This is what makes the aggregate
 * SQL that used to run "accidentally" past the 504 into deliberate, tracked
 * work off the request thread.
 */
async function runBackgroundBatch(
  pool: Pool,
  workflowDefinitionId: string,
  lockRunId: string,
  workflowRunId: string,
  cursor: AggregationCursor,
  batchSize: number
): Promise<void> {
  try {
    await runOneBatchOrAdvance(pool, workflowRunId, cursor, batchSize);
  } catch (error) {
    logSafeError("aggregation-run", "BACKGROUND_SLICE_FAILED", error);
    try {
      await completeWorkflowRun(pool, workflowRunId, "failed", "background_slice_error");
    } catch (markError) {
      logSafeError("aggregation-run", "BACKGROUND_SLICE_MARK_FAILED", markError);
    }
  } finally {
    try {
      await releaseWorkflowLock(pool, workflowDefinitionId, lockRunId);
    } catch (releaseError) {
      logSafeError("aggregation-run", "BACKGROUND_SLICE_LOCK_RELEASE_FAILED", releaseError);
    }
  }
}

/**
 * Per-HTTP-call entry point (the cron route calls this). Returns within a few
 * seconds with an honest state and NEVER runs the heavy set-based aggregate SQL
 * on the request thread:
 *   - a fresh job is CLAIMED only (fast) -> `started`;
 *   - a mode/overall/matchup slice is dispatched to an intentional background
 *     continuation that owns the lock -> `in_progress`;
 *   - the light `finalize` step runs inline and completes the run -> `completed`;
 *   - a slice already in flight (lock held) -> `already_running` (safe
 *     non-error; never a second run);
 *   - a run with a missing cursor is failed -> `failed`.
 * A subsequent scheduled call resumes from the persisted cursor until
 * `completed`, at which point the aggregation is a valid input for ranking.
 *
 * `deps.pool` is an injection seam for tests (default: the DigitalOcean write
 * pool); production never passes it.
 */
export async function stepAggregation(
  triggeredBy: "manual" | "cron",
  batchSize: number = DEFAULT_AGGREGATION_BATCH_SIZE,
  deps: { pool?: Pool } = {}
): Promise<AggregationStepResult> {
  const pool = deps.pool ?? getWritePool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
  await reconcileStaleWorkflowRuns(pool, workflowDefinitionId, STALE_JOB_SECONDS);

  const lockRunId = randomUUID();
  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, lockRunId, HELD_LOCK_TTL_MS);
  if (!lock.acquired) {
    // A slice is executing (foreground finalize/claim or a background batch).
    // Surface the in-flight run id (read-only) so the caller returns a safe
    // already_running — never a second run, never a 504-masquerading failure.
    const active = await findLatestRunningRun(pool, workflowDefinitionId);
    return { status: "already_running", phase: "mode", workflowRunId: active?.id, activeWorkflowRunId: active?.id };
  }

  // We hold the lock. Only QUICK work runs synchronously here; any heavy slice
  // is handed off to a background continuation that takes over lock ownership.
  let lockHandedOff = false;
  try {
    const running = await findLatestRunningRun(pool, workflowDefinitionId);

    // Fresh job: claim only (create run + scoped runs + cursor) and return fast.
    if (!running) {
      const workflowRunId = await claimFreshJob(pool, workflowDefinitionId, triggeredBy);
      return { status: "started", phase: "mode", workflowRunId, ...emptyCounts() };
    }

    const workflowRunId = running.id;
    const cursor = await readJobCursor<AggregationCursor>(pool, workflowRunId);
    if (!cursor) {
      // Started but never wrote its cursor (crashed in the tiny init window).
      // Fail it so the next call starts a clean job.
      await completeWorkflowRun(pool, workflowRunId, "failed", "missing_cursor");
      logSafeInfo("aggregation-run", "job_failed_missing_cursor", { workflowRunId });
      return { status: "failed", phase: "mode", workflowRunId, ...emptyCounts() };
    }

    // finalize (or, defensively, a 'done' cursor on a still-'running' run):
    // bounded by aggregate-row counts, not battle history, so it is light
    // enough to run inline — and it completes the run, so THIS is the call that
    // reports `completed`.
    if (cursor.phase === "finalize" || cursor.phase === "done") {
      const out = await finalizeAggregation(pool, workflowRunId, cursor);
      return {
        status: "completed",
        phase: "done",
        workflowRunId,
        outcome: out.outcome,
        modeAggregateCount: out.modeAggregateCount,
        overallAggregateCount: out.overallAggregateCount,
        matchupAggregateCount: out.matchupAggregateCount,
        reconciliationWarnings: out.reconciliationWarnings,
      };
    }

    // Heavy per-batch phase (mode/overall/matchup): do NOT run the set-based
    // aggregate SQL on the request thread. Hand the lock to the background
    // continuation and return `in_progress` immediately.
    lockHandedOff = true;
    const backgroundSlice = runBackgroundBatch(
      pool,
      workflowDefinitionId,
      lockRunId,
      workflowRunId,
      cursor,
      clampBatch(batchSize)
    );
    // Defense in depth: the promise is designed never to reject, but attach a
    // catch so an unexpected throw can never become an unhandledRejection.
    void backgroundSlice.catch(() => {});
    return { status: "in_progress", phase: cursor.phase, workflowRunId, backgroundSlice, ...emptyCounts() };
  } finally {
    if (!lockHandedOff) await releaseWorkflowLock(pool, workflowDefinitionId, lockRunId);
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
  const pool = getWritePool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
  await reconcileStaleWorkflowRuns(pool, workflowDefinitionId, STALE_JOB_SECONDS);

  const lockRunId = randomUUID();
  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, lockRunId, HELD_LOCK_TTL_MS);
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
