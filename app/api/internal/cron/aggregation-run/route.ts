import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { runAggregation } from "@/lib/aggregation/sync";

/**
 * Protected trigger for the statistical-aggregation workflow (Phase 5.2).
 * Cadence per Section 7.22/15: "Statistical aggregation | Every 6-12
 * hours." Not yet wired into any scheduler by this change — per the task's
 * explicit instruction, the DigitalOcean scheduler/proxy are not touched
 * here; adding a systemd timer entry for this route is a follow-up
 * infrastructure step outside this repository, mirroring exactly how every
 * Phase 4 cron job was rolled out.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("aggregation-run", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  try {
    const result = await runAggregation("cron");
    const status = result.outcome === "lock_not_acquired" ? 409 : 200;
    return NextResponse.json({ ok: status === 200, ...result }, { status });
  } catch (error) {
    logSafeError("aggregation-run", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Aggregation run failed unexpectedly."), { status: 500 });
  }
}
