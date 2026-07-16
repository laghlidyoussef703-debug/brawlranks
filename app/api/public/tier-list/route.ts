import { NextResponse } from "next/server";
import type { Pool } from "mysql2/promise";
import { getPool } from "@/lib/mysql";
import { getCurrentSnapshotMeta, getCurrentPublishedBrawlers } from "@/lib/publishedSnapshots/repository";
import { logSafeError, errorBody } from "@/lib/errors";

/**
 * Public, unauthenticated read route (Phase 5.3, Section 7.25/24.7) — the
 * sanctioned server-side path a future public page will call, reading
 * exclusively from the current published snapshot. Deliberately not
 * protected by INTERNAL_CRON_SECRET: this is public tier-list data by
 * design, the same data a future `/tier-list` page will render. No
 * visual/UI component exists yet — this is the backend read layer only.
 */
export const runtime = "nodejs";

export type PublicTierListResponse =
  | { available: false; reason: "no_published_snapshot_yet" }
  | { available: true; publishedAt: string; patchVersion: string | null; brawlers: Awaited<ReturnType<typeof getCurrentPublishedBrawlers>> };

/** Core logic, separated from the route handler for direct testability against a fake pool (tests/publicSnapshotRoute.test.ts) without a real database. */
export async function buildPublicTierListResponse(pool: Pool): Promise<PublicTierListResponse> {
  const meta = await getCurrentSnapshotMeta(pool);
  if (!meta) {
    return { available: false, reason: "no_published_snapshot_yet" };
  }

  const brawlers = await getCurrentPublishedBrawlers(pool, meta.snapshotId);
  return { available: true, publishedAt: meta.publishedAt, patchVersion: meta.patchVersionLabel, brawlers };
}

export async function GET() {
  try {
    const response = await buildPublicTierListResponse(getPool());
    return NextResponse.json(response);
  } catch (error) {
    logSafeError("public-tier-list", "MYSQL_ERROR", error);
    return NextResponse.json(errorBody("MYSQL_ERROR", "Failed to read the published tier list."), { status: 500 });
  }
}
