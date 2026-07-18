import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { stepAggregation, DEFAULT_AGGREGATION_BATCH_SIZE, MAX_AGGREGATION_BATCH_SIZE } from "@/lib/aggregation/sync";

/**
 * Protected trigger for the statistical-aggregation workflow (Phase 5.2).
 * Cadence per Section 7.22/15: "Statistical aggregation | Every 6-12 hours."
 *
 * DURABLE BATCHED EXECUTION (Phase 5 timeout fix): this route no longer runs
 * the whole aggregation in one request (which grew past the ~60s Hostinger
 * request limit and 504'd). It advances ONE bounded slice of the resumable
 * aggregation state machine per call and returns an honest status —
 * `started` / `in_progress` / `completed`. The scheduler simply calls this
 * endpoint repeatedly (see PHASE5.md "Production rollout"); each call returns
 * well under the limit, and the job resumes safely from its persisted cursor
 * until `completed`. The DigitalOcean scheduler/proxy are not touched here.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("aggregation-run", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  let batchSize = DEFAULT_AGGREGATION_BATCH_SIZE;
  const body = await request.json().catch(() => null);
  if (body && typeof body.batchSize === "number" && Number.isInteger(body.batchSize) && body.batchSize > 0) {
    batchSize = Math.min(body.batchSize, MAX_AGGREGATION_BATCH_SIZE);
  }

  try {
    const result = await stepAggregation("cron", batchSize);
    const status = result.status === "lock_not_acquired" ? 409 : 200;
    return NextResponse.json({ ok: status === 200, ...result }, { status });
  } catch (error) {
    logSafeError("aggregation-run", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Aggregation run failed unexpectedly."), { status: 500 });
  }
}
