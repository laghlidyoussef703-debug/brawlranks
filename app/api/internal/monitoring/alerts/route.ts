import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { getWritePool } from "@/lib/mysql";
import { readAlerts } from "@/lib/monitoring/runner";

/** DATASET Phase 15: protected, read-only list of OPEN operational alerts (deduped). No private incident detail. */
export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("monitoring-alerts", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }
  try {
    return NextResponse.json(await readAlerts(getWritePool()));
  } catch (error) {
    logSafeError("monitoring-alerts", "MYSQL_ERROR", error);
    return NextResponse.json(errorBody("MYSQL_ERROR", "Failed to read alerts."), { status: 500 });
  }
}
