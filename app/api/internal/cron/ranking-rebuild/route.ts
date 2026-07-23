import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";

/**
 * RETIRED HTTP trigger for the ranking-rebuild workflow (Phase 11).
 *
 * Ranking rebuild is no longer executed inside the Hostinger Next.js process.
 * The route only ever advanced ONE bounded slice of the resumable ranking state
 * machine per call and returned; triggered once by Hostinger it did only the
 * fresh-start CLAIM slice (status=started, phase=brawlers, brawlerCursor=null)
 * and the request ended — NOTHING drove the remaining slices, so the workflow
 * stalled with workflow_runs.status=running / ranking_runs.status=running and
 * brawlers_evaluated=NULL (observed: workflowRunId=c789b82c-…,
 * rankingRunId=c15fc8bd-…). There is no durable in-process driver that survives
 * the HTTP response.
 *
 * Ranking now runs OUT-OF-PROCESS in a standalone DigitalOcean systemd worker
 * (scripts/worker/ranking-worker.ts) that connects directly to DigitalOcean
 * MySQL with the writer role + TLS and drives the SAME workflow/cursor/lock
 * engine (lib/ranking/sync.ts `stepRankingRebuild`) through every phase:
 * brawlers -> matchups -> finalize -> publish -> completed. The stalled run is
 * reclaimed by the engine's own `reconcileStaleWorkflowRuns` — nothing here
 * touches those rows manually.
 *
 * This endpoint therefore runs NO ranking. Auth is still checked first (so it
 * never leaks that it exists to unauthenticated callers), then it returns 410
 * Gone with a structured pointer to the worker. Keeping the route as an explicit
 * 410 (rather than deleting it) means that if a Hostinger timer is ever
 * re-enabled by mistake it does NOTHING on the request thread instead of
 * re-introducing the stalled-run behavior.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("ranking-rebuild", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  return NextResponse.json(
    {
      ok: false,
      state: "delegated",
      message:
        "Ranking rebuild is executed by the DigitalOcean systemd worker (brawlranks-ranking-worker), " +
        "not via HTTP. This endpoint runs no ranking and is retained only to fail closed.",
      runner: "scripts/worker/ranking-worker.ts",
    },
    { status: 410 }
  );
}
