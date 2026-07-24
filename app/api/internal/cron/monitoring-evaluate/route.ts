import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { getWritePool } from "@/lib/mysql";
import { runEvaluate } from "@/lib/monitoring/runner";

/**
 * DATASET Phase 15: protected cron trigger that EVALUATES alert rules against the
 * latest snapshots and reconciles them (dedupe/increment/auto-resolve). Pass
 * `{"dryRun":true}` to compute firing conditions without writing any alert;
 * `{"idempotencyKey":"..."}` makes a retried invocation a safe no-op.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("monitoring-evaluate", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
  const dryRun = body.dryRun === true;
  try {
    const result = await runEvaluate(getWritePool(), { idempotencyKey, dryRun });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logSafeError("monitoring-evaluate", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Monitoring evaluate failed."), { status: 500 });
  }
}
