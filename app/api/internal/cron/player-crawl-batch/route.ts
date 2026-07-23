import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { syncOnePlayerProfile } from "@/lib/ingestion/sync/playerProfileSync";
import { runClubSync } from "@/lib/ingestion/sync/clubSync";
import { getUnprofiledPlayerTags } from "@/lib/ingestion/repository";
import { getWritePool } from "@/lib/mysql";

export const runtime = "nodejs";

const MAX_TAGS_PER_REQUEST = 25;

/**
 * Bounds how many newly-discovered, not-yet-normalized clubs this single
 * request will auto-fetch (Phase 4.6). Deliberately small and separate
 * from MAX_TAGS_PER_REQUEST: up to 25 players could each reference a
 * distinct unknown club, and fetching all 25 inline would risk this one
 * Hostinger-invoked request running long (Section 24.6's "the trigger
 * endpoint returns quickly" rule). Any club not resolved within this cap
 * stays recorded on the affected players' pending_club_tag and is picked
 * up whenever club-expansion next runs for that tag (manually, or via a
 * future request that happens to reference it again).
 */
const MAX_AUTO_CLUB_TRIGGERS_PER_REQUEST = 3;

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("player-crawl-batch", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const explicitTags = Array.isArray(body?.tags) ? body.tags.filter((t: unknown): t is string => typeof t === "string") : [];

  if (explicitTags.length > MAX_TAGS_PER_REQUEST) {
    return NextResponse.json(
      errorBody("SERVER_MISCONFIGURED", `At most ${MAX_TAGS_PER_REQUEST} tags may be requested per batch.`),
      { status: 400 }
    );
  }

  try {
    // Self-driving fallback (Phase 4.4): with no explicit tags supplied —
    // the normal case for a scheduled Hostinger cron hit, which can only
    // send a fixed body — fairly select a bounded, oldest-discovered-first
    // batch of battle-participant stubs that have never had a real profile
    // fetch (repository.ts#getUnprofiledPlayerTags). This is what actually
    // closes the loop between organic discovery (battle-log participants,
    // club members) and real profile data (trophies/region/club), without
    // which those players' region/trophy_bracket could never be populated.
    const tags = explicitTags.length > 0 ? explicitTags : await getUnprofiledPlayerTags(getWritePool(), MAX_TAGS_PER_REQUEST);

    if (tags.length === 0) {
      return NextResponse.json({ ok: true, results: [], autoClubExpansion: [], outcome: "no_unprofiled_players" });
    }

    const results = [];
    for (const tag of tags) {
      results.push(await syncOnePlayerProfile(tag, "api", null));
    }

    const pendingClubTags = [
      ...new Set(
        results
          .map((r) => r.pendingClubTag)
          .filter((tag): tag is string => typeof tag === "string")
      ),
    ].slice(0, MAX_AUTO_CLUB_TRIGGERS_PER_REQUEST);

    const clubResults = [];
    for (const clubTag of pendingClubTags) {
      clubResults.push({ clubTag, result: await runClubSync(clubTag, "api") });
    }

    return NextResponse.json({ ok: true, results, autoClubExpansion: clubResults });
  } catch (error) {
    logSafeError("player-crawl-batch", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Player crawl batch failed unexpectedly."), { status: 500 });
  }
}
