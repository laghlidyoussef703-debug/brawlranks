import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { getWritePool } from "@/lib/mysql";
import { readHealthSummary } from "@/lib/monitoring/runner";

/** DATASET Phase 15: protected, read-only latest operational health summary. No secrets, no mutation. */
export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("monitoring-health", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }
  try {
    return NextResponse.json(await readHealthSummary(getWritePool()));
  } catch (error) {
    logSafeError("monitoring-health", "MYSQL_ERROR", error);
    return NextResponse.json(errorBody("MYSQL_ERROR", "Failed to read monitoring health."), { status: 500 });
  }
}
