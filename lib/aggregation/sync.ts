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
 *   - `stepAggregation` executes exactly ONE bounded slice synchronously and
 *     returns an honest state (started / in_progress / already_running /
 *     completed / failed), ALWAYS releasing its lock in `finally`. As of
 *     Phase 11 this is driven OUT-OF-PROCESS by a standalone DigitalOcean
 *     systemd worker (scripts/worker/aggregation-worker.ts), NOT by the
 *     Hostinger Next.js request thread — the heavy `INSERT ... SELECT` scans
 *     the whole battle history and would exceed the ~55s Hostinger/nginx
 *     gateway limit (the original 504), and an in-Next background continuation
 *     did not survive the response reliably (commit 52e1a83's stalled workflow
 *     + stale lock). In the worker there is no request limit: the slice simply
 *     runs to completion and the lock is released in the same call. The worker
 *     calls this repeatedly (per-slice lock) until `completed`, so a process
 *     restart BETWEEN slices safely resumes from the persisted cursor.
 *   - `runAggregation` is a run-to-completion driver (used by tests/manual/CLI)
 *     that holds the lock once and loops every slice on the calling thread; its
 *     return shape is unchanged, so existing behavior and callers stay
 *     compatible.
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
 * Executes EXACTLY ONE bounded aggregation slice, synchronously, and reports an
 * honest state. This is the single unit of work a DigitalOcean systemd worker
 * invocation performs (Phase 11): reconcile stale runs, acquire the workflow
 * lock, claim/resume the one statistical-aggregation workflow, run one bounded
 * slice inline (awaited to completion — the worker is a standalone process with
 * NO ~55s gateway limit), persist the cursor + counts atomically, and ALWAYS
 * release the lock in `finally`.
 *
 * This deliberately does NOT use any Next.js fire-and-forget / detached promise
 * / request-thread trick. Commit 52e1a83's in-Next background continuation did
 * not survive reliably after the HTTP response (workflow
 * 0ead2ee0-…-69fe841d9d52 stalled at 16:35:47 with an unreleased lock and no
 * SQL running), so heavy execution is moved out-of-process to the worker. Here
 * the slice runs and the lock is released within the SAME synchronous call, so
 * there is nothing to "survive" a response.
 *
 * States:
 *   - fresh job                -> CLAIM (run + 3 scoped runs + cursor) -> `started`
 *   - mode/overall/matchup      -> run one bounded batch (or advance a phase)  -> `in_progress`
 *   - finalize / done           -> complete the run                            -> `completed`
 *   - a slice already in flight -> `already_running` (safe; never a second run)
 *   - a run with a missing cursor -> mark failed -> `failed`
 * A thrown error from the slice propagates to the caller AFTER the lock is
 * released (so the worker can exit nonzero); the slice's own transaction has
 * already rolled back atomically, so the next call re-runs exactly that batch.
 *
 * `deps.pool` is an injection seam for tests (default: the DigitalOcean write
 * pool via WRITE_DB_* / writer-role TLS); production/worker never pass it.
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
    // Another worker invocation holds the lock. Surface the in-flight run id
    // (read-only) so the caller reports a safe already_running — never a second
    // run.
    const active = await findLatestRunningRun(pool, workflowDefinitionId);
    return { status: "already_running", phase: "mode", workflowRunId: active?.id, activeWorkflowRunId: active?.id };
  }

  // We hold the lock; it is ALWAYS released in the finally below — on success,
  // on a thrown slice error, and on every early return.
  try {
    const running = await findLatestRunningRun(pool, workflowDefinitionId);

    // Fresh job: claim (create run + scoped runs + cursor). No aggregate SQL.
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

    // finalize (or, defensively, a 'done' cursor on a still-'running' run)
    // completes the run — THIS is the call that reports `completed`.
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

    // Heavy per-batch phase (mode/overall/matchup): run exactly ONE bounded
    // slice inline, to completion. Safe here because this is the standalone
    // worker process, not the request-limited Next.js route.
    const out = await runOneBatchOrAdvance(pool, workflowRunId, cursor, clampBatch(batchSize));
    return {
      status: "in_progress",
      phase: out.phase,
      workflowRunId,
      modeAggregateCount: out.modeAggregateCount,
      overallAggregateCount: out.overallAggregateCount,
      matchupAggregateCount: out.matchupAggregateCount,
      reconciliationWarnings: out.reconciliationWarnings,
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
