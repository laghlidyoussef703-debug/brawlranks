import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { runPlayerDiscovery } from "@/lib/ingestion/sync/playerDiscoverySync";
import { DEFAULT_DISCOVERY_PROMOTION_BATCH_SIZE } from "@/lib/ingestion/config";

export const runtime = "nodejs";

const MAX_BATCH_SIZE = 200;

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("player-discovery", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  let batchSize = DEFAULT_DISCOVERY_PROMOTION_BATCH_SIZE;
  try {
    const body = await request.json().catch(() => null);
    if (body && typeof body.batchSize === "number" && Number.isInteger(body.batchSize) && body.batchSize > 0) {
      batchSize = Math.min(body.batchSize, MAX_BATCH_SIZE);
    }
  } catch {
    // No body — use the default.
  }

  try {
    const result = await runPlayerDiscovery("cron", batchSize);
    const status = result.outcome === "lock_not_acquired" ? 409 : 200;
    return NextResponse.json({ ok: status === 200, ...result }, { status });
  } catch (error) {
    logSafeError("player-discovery", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Player discovery failed unexpectedly."), { status: 500 });
  }
}
