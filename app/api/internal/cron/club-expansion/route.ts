import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { runClubSync } from "@/lib/ingestion/sync/clubSync";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("club-expansion", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const clubTag = typeof body?.clubTag === "string" ? body.clubTag : null;
  if (!clubTag) {
    return NextResponse.json(errorBody("SERVER_MISCONFIGURED", "Request body must include a 'clubTag' string."), {
      status: 400,
    });
  }

  try {
    const result = await runClubSync(clubTag, "api");
    const status = result.outcome === "succeeded" ? 200 : result.outcome === "invalid_tag" ? 400 : 502;
    return NextResponse.json({ ok: result.outcome === "succeeded", ...result }, { status });
  } catch (error) {
    logSafeError("club-expansion", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Club expansion failed unexpectedly."), { status: 500 });
  }
}
