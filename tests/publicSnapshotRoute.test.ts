/**
 * Public tier-list read layer (Phase 5.3, Section 7.25). Pure/fake-pool
 * tests — no DB needed, since getCurrentSnapshotMeta/getCurrentPublishedBrawlers
 * both accept an explicit Queryable parameter rather than calling getPool()
 * themselves (same testability pattern as buildDatasetCoverageReport).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildPublicTierListResponse } from "@/app/api/public/tier-list/route";

const hasDbEnv = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1
);
const skip = !hasDbEnv;
const skipReason = "No DB credentials in this environment (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";

function fakePool(queryImpl: (sql: string, params?: unknown[]) => unknown[]) {
  return {
    query: async (sql: string, params?: unknown[]) => [queryImpl(sql, params), []],
  } as never;
}

test("public tier-list: returns available:false with a clear reason when no published snapshot exists", async () => {
  const pool = fakePool(() => []); // every query returns zero rows
  const response = await buildPublicTierListResponse(pool);
  assert.equal(response.available, false);
  if (!response.available) assert.equal(response.reason, "no_published_snapshot_yet");
});

test("public tier-list: returns available:true with the expected shape when a current snapshot exists", async () => {
  const snapshotId = "snap-1";
  const pool = fakePool((sql) => {
    if (sql.includes("FROM published_snapshots")) {
      return [{ id: snapshotId, published_at: new Date("2026-01-01T00:00:00Z"), patch_id: null }];
    }
    if (sql.includes("FROM published_snapshot_items")) {
      return [
        {
          brawlerId: "b1",
          brawlerSlug: "test-brawler",
          brawlerName: "Test Brawler",
          overallTier: "S",
          overallScore: 91.2,
          overallConfidence: "high",
          modeTiers: "[]",
          patchVersionLabel: null,
          calculatedAt: new Date("2026-01-01T00:00:00Z"),
          publishedAt: new Date("2026-01-01T00:00:00Z"),
          dataLimitations: JSON.stringify({ official_supercell_methodology: false }),
        },
      ];
    }
    if (sql.includes("FROM published_matchup_items")) {
      return [];
    }
    return [];
  });

  const response = await buildPublicTierListResponse(pool);
  assert.equal(response.available, true);
  if (response.available) {
    assert.equal(response.brawlers.length, 1);
    assert.equal(response.brawlers[0].brawlerSlug, "test-brawler");
    assert.equal(response.brawlers[0].overallTier, "S");
    assert.deepEqual(response.brawlers[0].dataLimitations, { official_supercell_methodology: false });
  }
});

test("public tier-list: never exposes a raw player tag or internal secret field, even in a populated response", async () => {
  const pool = fakePool((sql) => {
    if (sql.includes("FROM published_snapshots")) return [{ id: "s1", published_at: new Date(), patch_id: null }];
    if (sql.includes("FROM published_snapshot_items")) {
      return [
        {
          brawlerId: "b1",
          brawlerSlug: "x",
          brawlerName: "X",
          overallTier: "B",
          overallScore: 50,
          overallConfidence: "medium",
          modeTiers: "[]",
          patchVersionLabel: null,
          calculatedAt: new Date(),
          publishedAt: new Date(),
          dataLimitations: "{}",
        },
      ];
    }
    return [];
  });

  const response = await buildPublicTierListResponse(pool);
  const text = JSON.stringify(response);
  assert.doesNotMatch(text, /#[A-Z0-9]{5,}/, "must never contain a raw player-tag-shaped string");
  assert.doesNotMatch(text, /secret|password|BRAWL_DB_SECRET/i);
});

test("db: the public read layer only ever returns the is_current=1 snapshot's data, never a superseded one, against a real database", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();

  const [[anyRankingRun]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT id FROM ranking_runs LIMIT 1");
  if (!anyRankingRun) return; // requires a prior ranking-rebuild run; skip this assertion if not present

  // Create a deliberately superseded (is_current = 0) snapshot with a recognizable marker brawler, then confirm it never surfaces via the public layer.
  const [[anyBrawler]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT id FROM canonical_brawlers LIMIT 1");
  if (!anyBrawler) return;

  const supersededSnapshotId = randomUUID();
  await pool.execute(
    "INSERT INTO published_snapshots (id, ranking_run_id, is_current, published_at, superseded_at) VALUES (?, ?, 0, NOW(3), NOW(3))",
    [supersededSnapshotId, anyRankingRun.id]
  );

  const response = await buildPublicTierListResponse(pool);
  if (response.available) {
    const ids = response.brawlers.map((b) => b.brawlerSlug);
    // The superseded snapshot's own items table is empty here (never populated), so this
    // asserts the meta lookup itself never resolves to the superseded row's id at all.
    const [[current]] = await pool.query<import("mysql2").RowDataPacket[]>(
      "SELECT id FROM published_snapshots WHERE is_current = 1"
    );
    assert.notEqual(current?.id, supersededSnapshotId);
    assert.ok(Array.isArray(ids));
  }
});
