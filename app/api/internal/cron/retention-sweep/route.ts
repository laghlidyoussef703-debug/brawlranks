import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { runRetentionSweep } from "@/lib/ingestion/sync/retentionSweep";

/**
 * Protected retention/cleanup route (Phase 4.8). Pass `{"dryRun": true}` to
 * report counts without deleting anything — no admin interface, just a
 * request-body flag on the same protected route.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("retention-sweep", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  let dryRun = false;
  try {
    const body = await request.json().catch(() => null);
    if (body && typeof body.dryRun === "boolean") dryRun = body.dryRun;
  } catch {
    // No body — defaults to a real (non-dry-run) sweep.
  }

  try {
    const result = await runRetentionSweep("cron", dryRun);
    const status = result.outcome === "lock_not_acquired" ? 409 : 200;
    return NextResponse.json({ ok: status === 200, ...result }, { status });
  } catch (error) {
    logSafeError("retention-sweep", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Retention sweep failed unexpectedly."), { status: 500 });
  }
}
