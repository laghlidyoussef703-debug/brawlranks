import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { runRankingRebuild } from "@/lib/ranking/sync";

/**
 * Protected trigger for the ranking-rebuild workflow (Phase 5.3). Reads the
 * latest successful aggregation run, computes candidate ranking/matchup
 * results, and — only if the mass-movement guard and no-change rule allow
 * it — publishes a new current snapshot. No admin approval step exists;
 * a held or no-change outcome simply leaves the previous snapshot live and
 * lets the next scheduled run try again with fresher data.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("ranking-rebuild", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  try {
    const result = await runRankingRebuild("cron");
    const status = result.outcome === "lock_not_acquired" ? 409 : 200;
    return NextResponse.json({ ok: status === 200, ...result }, { status });
  } catch (error) {
    logSafeError("ranking-rebuild", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Ranking rebuild failed unexpectedly."), { status: 500 });
  }
}
