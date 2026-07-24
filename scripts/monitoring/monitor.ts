#!/usr/bin/env -S tsx
/**
 * DATASET Phase 15 — monitoring CLI (read-only against operational tables;
 * writes only monitoring rows). Safe subcommands:
 *
 *   snapshot   — collect a capacity + health snapshot (persist)
 *   evaluate   — evaluate + reconcile alerts (add --dry-run to write nothing)
 *   health     — print the latest health summary
 *   forecast   — print the latest capacity snapshot + 30/90/365 forecasts
 *   alerts     — print open alerts
 *   verify     — snapshot, evaluate twice, and report dedupe/resolution behavior
 *
 * Nothing here performs a destructive action. Timers are NOT enabled by this CLI.
 */

import { getWritePool } from "../../lib/mysql";
import { runSnapshot, runEvaluate, readHealthSummary, readCapacitySummary, readAlerts } from "../../lib/monitoring/runner";

function log(o: unknown): void { console.log(JSON.stringify(o)); }
function has(flag: string): boolean { return process.argv.includes(`--${flag}`); }
function flag(name: string): string | undefined {
  const hit = process.argv.find((v) => v.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main(): Promise<number> {
  const cmd = process.argv[2] ?? "help";
  const pool = getWritePool();
  const key = flag("idempotency-key") ?? null;

  switch (cmd) {
    case "snapshot": log({ cmd, result: await runSnapshot(pool, { idempotencyKey: key }) }); return 0;
    case "evaluate": log({ cmd, result: await runEvaluate(pool, { idempotencyKey: key, dryRun: has("dry-run") }) }); return 0;
    case "health": log({ cmd, ...(await readHealthSummary(pool) as object) }); return 0;
    case "forecast": log({ cmd, ...(await readCapacitySummary(pool) as object) }); return 0;
    case "alerts": log({ cmd, ...(await readAlerts(pool) as object) }); return 0;
    case "verify": {
      await runSnapshot(pool, {});
      const first = await runEvaluate(pool, {});
      const second = await runEvaluate(pool, {});
      log({ cmd, firstReconcile: first.reconcile, secondReconcile: second.reconcile, note: "second run should update (dedupe) not open duplicates" });
      return 0;
    }
    default:
      log({ error: "unknown command", usage: "snapshot|evaluate|health|forecast|alerts|verify [--dry-run] [--idempotency-key=...]" });
      return 2;
  }
}

main()
  .then(async (code) => { await getWritePool().end().catch(() => {}); process.exit(code); })
  .catch(async (error) => { log({ error: error instanceof Error ? error.message : String(error) }); await getWritePool().end().catch(() => {}); process.exit(1); });
