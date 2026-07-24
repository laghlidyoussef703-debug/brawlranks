import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { getWritePool } from "@/lib/mysql";
import { runSnapshot } from "@/lib/monitoring/runner";

/**
 * DATASET Phase 15: protected cron trigger that COLLECTS a capacity + health
 * snapshot (read-only against operational tables; writes only monitoring rows).
 * Supply `{"idempotencyKey":"..."}` so a retried invocation is a safe no-op.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("monitoring-snapshot", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
  try {
    const result = await runSnapshot(getWritePool(), { idempotencyKey });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logSafeError("monitoring-snapshot", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Monitoring snapshot failed."), { status: 500 });
  }
}
