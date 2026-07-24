#!/usr/bin/env -S tsx
/**
 * Operator command to approve and publish a ranking run that the mass-movement
 * guard has HELD (Phase 11 controlled bootstrap approval — DATASET.md "Ranking
 * sequence"). It runs on the DigitalOcean droplet with the writer-role env
 * (same WRITE_DB_* / TLS resolution as the workers, via lib/mysql getWritePool),
 * so "authenticated" = it can only run where the writer credentials are present.
 *
 * It targets ONE explicit rankingRunId, refuses anything that is not a
 * mass_movement_guard hold, re-runs every completeness/quality check, and
 * publishes transactionally through the SAME publication path the scheduled
 * ranking uses. It never re-runs aggregation/ranking and never edits thresholds.
 *
 * USAGE
 *   # Pre-flight: validate the held candidate and print evidence, publish nothing
 *   npx tsx scripts/ranking/approve-held-ranking.ts \
 *     --ranking-run-id=<uuid> --approved-by="you@brawlranks" --reason="bootstrap: first DO snapshot" --dry-run
 *
 *   # Approve + publish (requires --confirm so it cannot fire accidentally)
 *   npx tsx scripts/ranking/approve-held-ranking.ts \
 *     --ranking-run-id=<uuid> --approved-by="you@brawlranks" --reason="bootstrap: first DO snapshot" --confirm
 *
 * EXIT CODES
 *   0  published, already_published (idempotent no-op), or a successful --dry-run
 *   2  operator/validation error (bad input, wrong state, incomplete candidate)
 *   1  unexpected failure
 */

import { getWritePool } from "../../lib/mysql";
import { approveHeldRanking, ApprovalError } from "../../lib/ranking/approval";

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((v) => v.startsWith(prefix));
  return hit?.slice(prefix.length);
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ tool: "ranking-approval", event, time: new Date().toISOString(), ...fields }));
}

async function main(): Promise<number> {
  const rankingRunId = flag("ranking-run-id") ?? "";
  const approvedBy = flag("approved-by") ?? "";
  const reason = flag("reason") ?? "";
  const dryRun = hasFlag("dry-run");
  const confirm = hasFlag("confirm");

  log("start", { rankingRunId, approvedBy, dryRun, confirm });

  // A real publish must be explicitly confirmed — a dry-run never publishes.
  if (!dryRun && !confirm) {
    log("refused", { reason: "missing_confirm", message: "add --confirm to publish, or --dry-run to validate only" });
    return 2;
  }

  try {
    const result = await approveHeldRanking({ rankingRunId, approvedBy, reason }, { dryRun });
    log("result", {
      outcome: result.outcome,
      rankingRunId: result.rankingRunId,
      workflowRunId: result.workflowRunId,
      snapshotId: result.snapshotId,
      brawlersPublished: result.brawlersPublished,
      approvedBy: result.approvedBy,
      approvedAt: result.approvedAt,
      evidence: result.evidence,
    });
    log("exit", { code: 0, outcome: result.outcome });
    return 0;
  } catch (error) {
    if (error instanceof ApprovalError) {
      // Expected operator/validation failure — clear message, no stack, exit 2.
      log("rejected", { message: error.message });
      log("exit", { code: 2, reason: "validation_error" });
      return 2;
    }
    throw error;
  }
}

async function closePoolQuietly(): Promise<void> {
  try {
    await getWritePool().end();
  } catch {
    // never created / already closed
  }
}

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
