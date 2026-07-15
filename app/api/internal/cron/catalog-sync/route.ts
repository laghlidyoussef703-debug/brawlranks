import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { runCatalogSync } from "@/lib/catalog/sync";

/**
 * Protected internal route that runs the canonical Brawler catalog sync
 * pipeline (BRAWLRANKS_WEBSITE_SPEC.md Section 7 vertical slice). Never
 * reachable from client code or the public site — Bearer-authenticated
 * against INTERNAL_CRON_SECRET only, timing-safe (lib/auth.ts).
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("catalog-sync", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), {
      status: 401,
    });
  }

  try {
    const result = await runCatalogSync("cron");
    const status =
      result.outcome === "failed" || result.outcome === "prerequisites_missing" ? 500 : 200;
    return NextResponse.json({ ok: status === 200, ...result }, { status });
  } catch (error) {
    logSafeError("catalog-sync", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Catalog sync failed unexpectedly."), {
      status: 500,
    });
  }
}
