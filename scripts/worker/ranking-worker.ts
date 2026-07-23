#!/usr/bin/env -S tsx
/**
 * Phase 11 ranking-rebuild worker — a standalone Node CLI that runs on the
 * DigitalOcean droplet under systemd and executes the ranking rebuild OUT of the
 * Hostinger Next.js process, following the same architecture as the statistical
 * aggregation worker (scripts/worker/aggregation-worker.ts).
 *
 * WHY THIS EXISTS
 *   The Hostinger HTTP route (app/api/internal/cron/ranking-rebuild) executed
 *   exactly ONE bounded slice of the resumable ranking state machine per call
 *   and returned; triggered once by Hostinger it did only the fresh-start CLAIM
 *   slice (status=started, phase=brawlers, brawlerCursor=null) and the request
 *   ended — NOTHING drove the remaining slices. So the workflow stalled with
 *   workflow_runs.status=running, ranking_runs.status=running, the cursor pinned
 *   at phase=brawlers / brawlerCursor=null, and brawlers_evaluated=NULL
 *   (observed: workflowRunId=c789b82c-…, rankingRunId=c15fc8bd-…). There is no
 *   durable in-process driver that survives the HTTP response.
 *
 *   Execution therefore moves to this worker, which connects DIRECTLY to
 *   DigitalOcean MySQL (writer role + TLS via WRITE_DB_* / WRITE_DB_CA_PATH,
 *   resolved by lib/mysql `getWritePool`) and drives the EXISTING ranking
 *   workflow/cursor/lock engine (lib/ranking/sync `stepRankingRebuild`) through
 *   every phase: brawlers -> matchups -> finalize -> publish -> completed. No
 *   parallel implementation, no HTTP, no nginx, no fire-and-forget. Ranking
 *   formulas, tier thresholds, hold rules, publication safeguards, and snapshot
 *   semantics are untouched — this worker only CALLS the existing engine.
 *
 * MODES
 *   (default) single slice : one `stepRankingRebuild` call — reconcile stale
 *       runs, claim/resume the one ranking-rebuild workflow, run exactly one
 *       bounded slice, persist cursor atomically, release the lock in finally.
 *       Exits 0 for started/in_progress/completed/lock_not_acquired; exits
 *       nonzero only for a real (thrown) failure.
 *   --drive : loop single slices (each with its own per-slice lock, so a process
 *       restart BETWEEN slices safely resumes from the persisted cursor) until
 *       the workflow reaches `completed` (brawlers -> matchups -> finalize ->
 *       publish -> completed), or another worker is already driving it
 *       (`lock_not_acquired`), or a slice throws. This is the systemd/canary
 *       entry point.
 *
 * SAFETY
 *   - Never deletes locks or edits the stuck workflow/ranking rows directly;
 *     only the engine's own reconcile/lock/cursor code touches those. The stuck
 *     run from the incident is reclaimed by `reconcileStaleWorkflowRuns` (called
 *     inside every `stepRankingRebuild`) once its heartbeat is stale.
 *   - Never runs aggregation (that is a separate, gated workflow) — this worker
 *     imports only the ranking engine.
 *   - Idempotent + resumable: fresh vs resume is decided under the lock, so it
 *     never creates duplicate ranking_runs.
 *   - Concurrency: the workflow_locks per-slice lock serializes overlapping
 *     workers (a loser gets `lock_not_acquired` and exits 0 without a second
 *     run); the systemd unit additionally `Conflicts` with the aggregation unit.
 *
 * FLAGS / ENV
 *   --drive | RANKING_WORKER_MODE=drive          enable driver mode
 *   --batch-size=<n> | RANKING_WORKER_BATCH_SIZE  brawlers per slice (engine-clamped 1..50)
 *   --max-slices=<n> | RANKING_WORKER_MAX_SLICES  driver safety cap (default 1000000)
 *   --pause-ms=<n>   | RANKING_WORKER_PAUSE_MS    pause between driver slices (default 200)
 */

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { getWritePool } from "../../lib/mysql";
import {
  stepRankingRebuild,
  DEFAULT_RANKING_BATCH_SIZE,
  type RankingStepResult,
} from "../../lib/ranking/sync";

type LogFn = (event: string, fields?: Record<string, unknown>) => void;
type StepFn = (triggeredBy: "manual" | "cron", batchSize: number) => Promise<RankingStepResult>;

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((v) => v.startsWith(prefix));
  return hit?.slice(prefix.length);
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function intOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  // Single-line JSON to stdout -> captured verbatim by the systemd journal.
  console.log(JSON.stringify({ worker: "ranking", event, time: new Date().toISOString(), ...fields }));
}

/** Progress/identity fields common to every slice log line. */
function sliceFields(result: RankingStepResult): Record<string, unknown> {
  return {
    status: result.status,
    phase: result.phase,
    workflowRunId: result.workflowRunId,
    rankingRunId: result.rankingRunId,
    outcome: result.outcome,
    brawlersEvaluated: result.brawlersEvaluated,
    brawlersPublished: result.brawlersPublished,
    tierMoveRatio: result.tierMoveRatio,
  };
}

/**
 * Drive bounded ranking slices until the workflow reaches `completed`, another
 * worker is already driving it (`lock_not_acquired`), or a slice throws (a real
 * failure — the error propagates so the caller exits nonzero). Returns the
 * process exit code (0 = completed / already-driven / safe no-op; 1 = the
 * driver cap was hit without converging). `step` is injectable for tests.
 */
export async function driveRankingToCompletion(
  step: StepFn,
  opts: { batchSize: number; maxSlices: number; pauseMs: number; log?: LogFn }
): Promise<number> {
  const emit = opts.log ?? log;
  let prevPhase: string | null = null;
  let last: RankingStepResult | null = null;

  for (let i = 1; i <= opts.maxSlices; i += 1) {
    const result = await step("cron", opts.batchSize);
    last = result;
    emit("slice", { i, ...sliceFields(result) });

    // Emit a distinct phase_advance line whenever the state machine moves phase.
    if (prevPhase !== null && result.phase !== prevPhase) {
      emit("phase_advance", { i, from: prevPhase, to: result.phase, workflowRunId: result.workflowRunId, rankingRunId: result.rankingRunId });
    }
    prevPhase = result.phase;

    if (result.status === "completed") {
      emit("completed", sliceFields(result));
      return 0;
    }
    if (result.status === "lock_not_acquired") {
      // Another worker holds the lock and is progressing the job. Do not fight
      // for it; let the other invocation finish. Safe no-op, exit 0.
      emit("lock_not_acquired", { activeWorkflowRunId: result.activeWorkflowRunId, workflowRunId: result.workflowRunId });
      return 0;
    }
    // started / in_progress -> keep driving.
    if (opts.pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, opts.pauseMs));
  }

  emit("max_slices_exhausted", { lastStatus: last?.status, lastPhase: last?.phase });
  return 1;
}

async function main(): Promise<number> {
  const drive = hasFlag("drive") || (process.env.RANKING_WORKER_MODE ?? "").toLowerCase() === "drive";
  const batchSize = intOr(flag("batch-size") ?? process.env.RANKING_WORKER_BATCH_SIZE, DEFAULT_RANKING_BATCH_SIZE);
  const maxSlices = intOr(flag("max-slices") ?? process.env.RANKING_WORKER_MAX_SLICES, 1_000_000);
  const pauseMs = intOr(flag("pause-ms") ?? process.env.RANKING_WORKER_PAUSE_MS, 200);

  log("start", { mode: drive ? "drive" : "single", batchSize, maxSlices, pauseMs });

  if (!drive) {
    // Single bounded slice. `stepRankingRebuild` throws on a real failure (the
    // finally still releases the lock); that propagates to `main().catch`.
    const result = await stepRankingRebuild("cron", batchSize);
    log("slice", sliceFields(result));
    if (result.status === "completed") log("completed", sliceFields(result));
    log("exit", { code: 0, status: result.status, outcome: result.outcome });
    return 0;
  }

  const code = await driveRankingToCompletion(stepRankingRebuild, { batchSize, maxSlices, pauseMs });
  log("exit", { code, mode: "drive" });
  return code;
}

/** Close the write pool without ever throwing — it may never have been built (e.g. missing DB config). */
async function closePoolQuietly(): Promise<void> {
  try {
    await getWritePool().end();
  } catch {
    // Pool was never created, or is already closed. Nothing to clean up.
  }
}

/**
 * Only auto-run when this file is the process entrypoint (systemd/CLI), so a
 * test can `import` the module — e.g. to exercise `driveRankingToCompletion`
 * with a fake stepper — WITHOUT triggering `process.exit`.
 */
function isDirectRun(): boolean {
  try {
    const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
    const self = realpathSync(fileURLToPath(import.meta.url));
    return invoked === self;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main()
    .then(async (code) => {
      await closePoolQuietly();
      process.exit(code);
    })
    .catch(async (error) => {
      log("error", { message: error instanceof Error ? error.message : String(error) });
      log("exit", { code: 1, reason: "unhandled_error" });
      await closePoolQuietly();
      process.exit(1);
    });
}
