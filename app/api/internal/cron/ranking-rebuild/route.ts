import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { stepRankingRebuild, DEFAULT_RANKING_BATCH_SIZE, MAX_RANKING_BATCH_SIZE } from "@/lib/ranking/sync";

/**
 * Protected trigger for the ranking-rebuild workflow (Phase 5.3). Reads the
 * latest fully-successful aggregation run, computes candidate ranking/matchup
 * results, and — only if the mass-movement guard and no-change rule allow it
 * — publishes a new current snapshot. A held or no-change outcome leaves the
 * previous snapshot live and lets the next scheduled run try again.
 *
 * DURABLE BATCHED EXECUTION (Phase 5 timeout fix): like aggregation-run, this
 * advances ONE bounded slice of the resumable ranking state machine per call
 * (brawlers -> matchups -> finalize -> publish) and returns `started` /
 * `in_progress` / `completed`. Ranking never runs against an incomplete
 * aggregation: the state machine's precondition only accepts a fully
 * 'succeeded' aggregation run. The scheduler calls this repeatedly until
 * `completed` — see PHASE5.md "Production rollout".
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("ranking-rebuild", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  let batchSize = DEFAULT_RANKING_BATCH_SIZE;
  const body = await request.json().catch(() => null);
  if (body && typeof body.batchSize === "number" && Number.isInteger(body.batchSize) && body.batchSize > 0) {
    batchSize = Math.min(body.batchSize, MAX_RANKING_BATCH_SIZE);
  }

  try {
    const result = await stepRankingRebuild("cron", batchSize);
    const status = result.status === "lock_not_acquired" ? 409 : 200;
    return NextResponse.json({ ok: status === 200, ...result }, { status });
  } catch (error) {
    logSafeError("ranking-rebuild", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Ranking rebuild failed unexpectedly."), { status: 500 });
  }
}
