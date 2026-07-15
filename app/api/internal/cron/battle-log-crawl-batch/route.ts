import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { runBattleLogCrawlBatch } from "@/lib/ingestion/sync/battleLogCrawlSync";
import { DEFAULT_CRAWL_BATCH_SIZE } from "@/lib/ingestion/config";

export const runtime = "nodejs";

const MAX_BATCH_SIZE = 100;

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
    const result = await runBattleLogCrawlBatch("cron", batchSize);
    const status = result.outcome === "lock_not_acquired" || result.outcome === "prerequisites_missing" ? 409 : 200;
    return NextResponse.json({ ok: status === 200, ...result }, { status });
  } catch (error) {
    logSafeError("battle-log-crawl-batch", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Battle-log crawl batch failed unexpectedly."), { status: 500 });
  }
}
