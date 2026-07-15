import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { syncOnePlayerProfile } from "@/lib/ingestion/sync/playerProfileSync";

export const runtime = "nodejs";

const MAX_TAGS_PER_REQUEST = 25;

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("player-crawl-batch", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const tags = Array.isArray(body?.tags) ? body.tags.filter((t: unknown): t is string => typeof t === "string") : [];

  if (tags.length === 0) {
    return NextResponse.json(errorBody("SERVER_MISCONFIGURED", "Request body must include a non-empty 'tags' array."), {
      status: 400,
    });
  }
  if (tags.length > MAX_TAGS_PER_REQUEST) {
    return NextResponse.json(
      errorBody("SERVER_MISCONFIGURED", `At most ${MAX_TAGS_PER_REQUEST} tags may be requested per batch.`),
      { status: 400 }
    );
  }

  try {
    const results = [];
    for (const tag of tags) {
      results.push(await syncOnePlayerProfile(tag, "api", null));
    }
    return NextResponse.json({ ok: true, results });
  } catch (error) {
    logSafeError("player-crawl-batch", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Player crawl batch failed unexpectedly."), { status: 500 });
  }
}
