import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { getWritePool } from "@/lib/mysql";
import { readCapacitySummary } from "@/lib/monitoring/runner";

/** DATASET Phase 15: protected, read-only latest capacity snapshot + persisted 30/90/365 forecasts. */
export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("monitoring-capacity", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }
  try {
    return NextResponse.json(await readCapacitySummary(getWritePool()));
  } catch (error) {
    logSafeError("monitoring-capacity", "MYSQL_ERROR", error);
    return NextResponse.json(errorBody("MYSQL_ERROR", "Failed to read capacity summary."), { status: 500 });
  }
}
