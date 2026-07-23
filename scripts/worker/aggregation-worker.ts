#!/usr/bin/env -S tsx
/**
 * Phase 11 statistical-aggregation worker — a standalone Node CLI that runs on
 * the DigitalOcean droplet under systemd and executes aggregation OUT of the
 * Hostinger Next.js process.
 *
 * WHY THIS EXISTS
 *   The heavy set-based aggregate `INSERT ... SELECT` scans the whole battle
 *   history and exceeds Hostinger/nginx's ~55s gateway timeout (the original
 *   504). Commit 52e1a83 made the HTTP route return fast via an in-Next
 *   background continuation, but that continuation did NOT survive the response
 *   reliably: workflow 0ead2ee0-6c7d-4556-9bdb-69fe841d9d52 stalled at
 *   2026-07-23 16:35:47.578 with its lock unreleased (until TTL) and no
 *   aggregation SQL running. So execution moves to this worker, which connects
 *   DIRECTLY to DigitalOcean MySQL (writer role + TLS via WRITE_DB_* /
 *   WRITE_DB_CA_PATH, resolved by lib/mysql `getWritePool`) and drives the
 *   EXISTING workflow/cursor/lock engine (lib/aggregation/sync `stepAggregation`
 *   and `runAggregation`). No parallel implementation, no HTTP, no nginx, no
 *   fire-and-forget.
 *
 * MODES
 *   (default) single slice : one `stepAggregation` call — reconcile stale runs,
 *       claim/resume the one statistical-aggregation workflow, run exactly one
 *       bounded slice, persist cursor + counts atomically, release the lock in
 *       finally. Exits 0 for started/in_progress/already_running/completed;
 *       exits nonzero only for a real failure.
 *   --drive : loop single slices (each with its own per-slice lock, so a process
 *       restart BETWEEN slices safely resumes) until the workflow reaches
 *       `completed` (mode -> overall -> matchup -> finalize -> completed), or
 *       another worker is already driving it (`already_running`), or a slice
 *       fails. This is the steady-state and canary entry point.
 *
 * SAFETY
 *   - Never deletes locks or edits workflow rows; only the engine's own
 *     reconcile/lock/cursor code touches those.
 *   - Never runs ranking (that is a separate, gated workflow).
 *   - Idempotent + resumable: fresh vs resume is decided under the lock, so it
 *     never creates duplicate aggregation_runs.
 *
 * FLAGS / ENV
 *   --drive | AGG_WORKER_MODE=drive            enable driver mode
 *   --batch-size=<n> | AGG_WORKER_BATCH_SIZE   brawlers per slice (engine-clamped)
 *   --max-slices=<n> | AGG_WORKER_MAX_SLICES   driver safety cap (default 100000)
 *   --pause-ms=<n>   | AGG_WORKER_PAUSE_MS     pause between driver slices (default 200)
 */

import { getWritePool } from "../../lib/mysql";
import {
  stepAggregation,
  DEFAULT_AGGREGATION_BATCH_SIZE,
  type AggregationStepResult,
} from "../../lib/aggregation/sync";

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
  console.log(JSON.stringify({ worker: "aggregation", event, time: new Date().toISOString(), ...fields }));
}

async function main(): Promise<number> {
  const drive = hasFlag("drive") || (process.env.AGG_WORKER_MODE ?? "").toLowerCase() === "drive";
  const batchSize = intOr(flag("batch-size") ?? process.env.AGG_WORKER_BATCH_SIZE, DEFAULT_AGGREGATION_BATCH_SIZE);
  const maxSlices = intOr(flag("max-slices") ?? process.env.AGG_WORKER_MAX_SLICES, 100_000);
  const pauseMs = intOr(flag("pause-ms") ?? process.env.AGG_WORKER_PAUSE_MS, 200);

  log("start", { mode: drive ? "drive" : "single", batchSize, maxSlices, pauseMs });

  if (!drive) {
    // Single bounded slice.
    const result = await stepAggregation("cron", batchSize);
    log("slice", { status: result.status, phase: result.phase, workflowRunId: result.workflowRunId });
    if (result.status === "failed") {
      log("exit", { code: 1, reason: "slice_failed" });
      return 1;
    }
    log("exit", { code: 0, status: result.status });
    return 0;
  }

  // Driver: continue safe slices until completion.
  let last: AggregationStepResult | null = null;
  for (let i = 1; i <= maxSlices; i += 1) {
    const result = await stepAggregation("cron", batchSize);
    last = result;
    log("slice", {
      i,
      status: result.status,
      phase: result.phase,
      workflowRunId: result.workflowRunId,
      modeAggregateCount: result.modeAggregateCount,
      overallAggregateCount: result.overallAggregateCount,
      matchupAggregateCount: result.matchupAggregateCount,
    });

    if (result.status === "failed") {
      log("exit", { code: 1, reason: "slice_failed", workflowRunId: result.workflowRunId });
      return 1;
    }
    if (result.status === "completed") {
      log("completed", {
        workflowRunId: result.workflowRunId,
        outcome: result.outcome,
        modeAggregateCount: result.modeAggregateCount,
        overallAggregateCount: result.overallAggregateCount,
        matchupAggregateCount: result.matchupAggregateCount,
        reconciliationWarnings: result.reconciliationWarnings,
      });
      log("exit", { code: 0, status: "completed" });
      return 0;
    }
    if (result.status === "already_running") {
      // Another worker holds the lock and is progressing the job. Do not fight
      // for it; let the other invocation finish.
      log("exit", { code: 0, status: "already_running", workflowRunId: result.workflowRunId });
      return 0;
    }
    // started / in_progress -> keep driving.
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }

  log("exit", { code: 1, reason: "max_slices_exhausted", lastStatus: last?.status });
  return 1;
}

/** Close the write pool without ever throwing — it may never have been built (e.g. missing DB config). */
async function closePoolQuietly(): Promise<void> {
  try {
    await getWritePool().end();
  } catch {
    // Pool was never created, or is already closed. Nothing to clean up.
  }
}

main()
  .then(async (code) => {
    await closePoolQuietly();
    process.exit(code);
  })
  .catch(async (error) => {
    log("error", { message: error instanceof Error ? error.message : String(error) });
    await closePoolQuietly();
    process.exit(1);
  });
