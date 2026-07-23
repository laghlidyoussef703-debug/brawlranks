import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";

/**
 * RETIRED HTTP trigger for the statistical-aggregation workflow (Phase 11).
 *
 * Statistical aggregation is no longer executed inside the Hostinger Next.js
 * process. The heavy set-based `INSERT ... SELECT` scans the whole battle
 * history and exceeds Hostinger/nginx's ~55s gateway timeout (the original
 * 504), and the in-Next background continuation from commit 52e1a83 did not
 * survive the HTTP response reliably (workflow 0ead2ee0-…-69fe841d9d52 stalled
 * with an unreleased lock and no SQL running). Aggregation now runs OUT-OF-
 * PROCESS in a standalone DigitalOcean systemd worker
 * (scripts/worker/aggregation-worker.ts) that connects directly to DigitalOcean
 * MySQL with the writer role + TLS and drives the same workflow/cursor/lock
 * engine (lib/aggregation/sync.ts `stepAggregation`).
 *
 * This endpoint therefore runs NO aggregation SQL. Auth is still checked first
 * (so it never leaks that it exists to unauthenticated callers), then it
 * returns 410 Gone with a structured pointer to the worker. Keeping the route
 * as an explicit 410 (rather than deleting it) means that if a Hostinger timer
 * is ever re-enabled by mistake it does NOTHING on the request thread instead
 * of re-introducing the 504.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("aggregation-run", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  return NextResponse.json(
    {
      ok: false,
      state: "delegated",
      message:
        "Statistical aggregation is executed by the DigitalOcean systemd worker (brawlranks-aggregation-worker), " +
        "not via HTTP. This endpoint runs no aggregation and is retained only to fail closed.",
      runner: "scripts/worker/aggregation-worker.ts",
    },
    { status: 410 }
  );
}
