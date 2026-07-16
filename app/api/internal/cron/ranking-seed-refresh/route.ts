import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { runRankingSeedSync } from "@/lib/ingestion/sync/rankingSeedSync";
import { INITIAL_RANKING_REGIONS, MAX_REGIONS_PER_REQUEST } from "@/lib/ingestion/config";
import { isValidCountryCodeShape, normalizeCountryCode } from "@/lib/ingestion/regions";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("ranking-seed-refresh", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  let regions: string[] = INITIAL_RANKING_REGIONS;
  try {
    const body = await request.json().catch(() => null);
    if (body && Array.isArray(body.regions)) {
      const rawRegions: unknown[] = body.regions;
      const candidateRegions: string[] = [];
      for (const raw of rawRegions) {
        if (typeof raw !== "string" || !isValidCountryCodeShape(raw)) continue;
        const normalized = normalizeCountryCode(raw);
        if (normalized !== null) candidateRegions.push(normalized);
      }
      if (candidateRegions.length > 0) {
        regions = [...new Set(candidateRegions)].slice(0, MAX_REGIONS_PER_REQUEST);
      }
    }
  } catch {
    // No body / invalid JSON — fall back to the default region set.
  }

  try {
    const result = await runRankingSeedSync("cron", regions);
    const status = result.outcome === "prerequisites_missing" || result.outcome === "lock_not_acquired" ? 409 : 200;
    return NextResponse.json({ ok: status === 200, ...result }, { status });
  } catch (error) {
    logSafeError("ranking-seed-refresh", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Ranking seed refresh failed unexpectedly."), { status: 500 });
  }
}
