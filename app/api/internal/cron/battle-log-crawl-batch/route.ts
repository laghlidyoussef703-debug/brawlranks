import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { stepBattleLogCrawl } from "@/lib/ingestion/sync/battleLogCrawlSync";
import { DEFAULT_CRAWL_BATCH_SIZE } from "@/lib/ingestion/config";

export const runtime = "nodejs";

const MAX_BATCH_SIZE = 100;

/**
 * Protected trigger for the battle-log crawl (Phase 10 timeout fix).
 *
 * DURABLE BATCHED EXECUTION: this route no longer runs the whole batch in one
 * request. Each player is a live proxy round-trip to the official API (~18s),
 * so a batch of 25 ran ~7m47s — long past Hostinger/nginx's ~55s gateway
 * timeout, producing a false 504 at the client while the server-side work kept
 * running (false failures + overlap risk). It now advances ONE bounded slice of
 * the resumable battle-log state machine per call — the same durable mechanism
 * aggregation-run and ranking-rebuild use (lib/workflow.ts job cursor + short
 * per-slice lock + stale-run recovery). The FIRST call claims the job and
 * returns `started` + workflowRunId within milliseconds; the scheduler simply
 * calls this endpoint repeatedly until `completed`. `batchSize` is preserved as
 * the total players one job drains. The DigitalOcean scheduler/proxy are not
 * touched here.
 *
 * Response contract (always HTTP 2xx on a handled outcome — a slow batch can no
 * longer masquerade as a gateway failure, and an overlapping trigger is a safe
 * non-error, never a second run):
 *   - started      -> 202  { accepted: true,  state: "started",         workflowRunId }
 *   - in_progress  -> 202  { accepted: true,  state: "in_progress",     workflowRunId }
 *   - completed    -> 200  { accepted: true,  state: "completed",       workflowRunId, outcome, counts }
 *   - already_running (a slice is mid-flight) -> 200 { accepted: false, state: "already_running", workflowRunId }
 *   - prerequisites_missing (source/endpoint disabled) -> 409 { ok: false, state: "prerequisites_missing" }
 */
export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("battle-log-crawl-batch", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  let batchSize = DEFAULT_CRAWL_BATCH_SIZE;
  try {
    const body = await request.json().catch(() => null);
    if (body && typeof body.batchSize === "number" && Number.isInteger(body.batchSize) && body.batchSize > 0) {
      batchSize = Math.min(body.batchSize, MAX_BATCH_SIZE);
    }
  } catch {
    // No body — use the default, deliberately small, bounded batch size.
  }

  try {
    const result = await stepBattleLogCrawl("cron", batchSize);

    if (result.status === "lock_not_acquired") {
      // A slice is already executing: return a safe non-error so the scheduler
      // simply retries on the next tick, never starting a second run.
      return NextResponse.json(
        { ok: true, accepted: false, state: "already_running", workflowRunId: result.activeWorkflowRunId },
        { status: 200 }
      );
    }
    if (result.status === "prerequisites_missing") {
      return NextResponse.json(
        { ok: false, state: "prerequisites_missing", workflowRunId: result.workflowRunId },
        { status: 409 }
      );
    }

    const httpStatus = result.status === "completed" ? 200 : 202;
    return NextResponse.json(
      {
        ok: true,
        accepted: true,
        state: result.status,
        workflowRunId: result.workflowRunId,
        outcome: result.outcome,
        playersProcessed: result.playersProcessed,
        battlesIngested: result.battlesIngested,
        battlesDeduplicated: result.battlesDeduplicated,
        battlesQuarantined: result.battlesQuarantined,
      },
      { status: httpStatus }
    );
  } catch (error) {
    logSafeError("battle-log-crawl-batch", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Battle-log crawl batch failed unexpectedly."), { status: 500 });
  }
}
