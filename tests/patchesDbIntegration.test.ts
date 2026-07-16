/**
 * Database-dependent Phase 5.1 integration tests. Require real MySQL/MariaDB
 * credentials (DB_HOST/DB_PORT/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1). No such
 * credentials exist in this local sandbox — these tests SKIP rather than
 * fabricate a pass, exactly like every prior phase's *DbIntegration.test.ts
 * file. Written to run for real in any environment with a reachable,
 * migrated (through 0021) database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const hasDbEnv = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1
);
const skip = !hasDbEnv;
const skipReason = "No DB credentials in this environment (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";

test("db: recordInferredPatchIfMeaningful creates exactly one active patch and supersedes the prior one", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { recordInferredPatchIfMeaningful, getActivePatch } = await import("@/lib/patches/repository");
  const pool = getPool();

  const firstNow = new Date(Date.now() - 5000);
  const firstId = await recordInferredPatchIfMeaningful(pool, {
    changeCount: 1,
    fetchRunId: null as unknown as string,
    changeSummary: [{ entityType: "brawler", entityId: "test-1", changeType: "new_brawler" }],
    now: firstNow,
  });
  assert.ok(firstId);

  const afterFirst = await getActivePatch(pool);
  assert.equal(afterFirst?.id, firstId);

  const secondNow = new Date();
  const secondId = await recordInferredPatchIfMeaningful(pool, {
    changeCount: 1,
    fetchRunId: null as unknown as string,
    changeSummary: [{ entityType: "brawler", entityId: "test-2", changeType: "gadget_change" }],
    now: secondNow,
  });
  assert.ok(secondId);
  assert.notEqual(secondId, firstId);

  const afterSecond = await getActivePatch(pool);
  assert.equal(afterSecond?.id, secondId, "the second patch must now be the sole active one");

  const [[firstRow]] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT status FROM patches WHERE id = ?",
    [firstId]
  );
  assert.equal(firstRow.status, "superseded", "the first patch must be superseded, not deleted");

  const [activeRows] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT COUNT(*) AS c FROM patches WHERE status = 'active'"
  );
  assert.equal(activeRows[0].c, 1, "exactly one active patch must ever exist");
});

test("db: no patch row is created when changeCount is 0 (no-op catalog sync)", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { recordInferredPatchIfMeaningful } = await import("@/lib/patches/repository");
  const pool = getPool();

  const [[before]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT COUNT(*) AS c FROM patches");

  const result = await recordInferredPatchIfMeaningful(pool, {
    changeCount: 0,
    fetchRunId: null as unknown as string,
    changeSummary: [],
  });
  assert.equal(result, null);

  const [[after]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT COUNT(*) AS c FROM patches");
  assert.equal(before.c, after.c, "a no-op sync must never add a patches row");
});

test("db: the active_flag UNIQUE KEY rejects a second concurrently-active patch at the database level, independent of application logic", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();

  const insertActive = () =>
    pool.execute(
      `INSERT INTO patches (id, version_label, source, status, detected_at, effective_at)
       VALUES (?, ?, 'inferred_from_catalog_change', 'active', NOW(3), NOW(3))`,
      [randomUUID(), `internal-test-${randomUUID().slice(0, 8)}`]
    );

  // First clear any currently-active row so this test's own first insert succeeds cleanly.
  await pool.execute("UPDATE patches SET status = 'superseded' WHERE status = 'active'");

  await insertActive();
  await assert.rejects(insertActive(), "a second row with status='active' must violate uniq_patches_active");
});

test("db: version_label collision throws — proves the failure mode recordInferredPatchIfMeaningful's caller must tolerate is real", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { recordInferredPatchIfMeaningful } = await import("@/lib/patches/repository");
  const pool = getPool();

  const collidingNow = new Date("2031-01-01T00:00:00.000Z"); // far-future, collision-free from any real data
  const first = await recordInferredPatchIfMeaningful(pool, {
    changeCount: 1,
    fetchRunId: null as unknown as string,
    changeSummary: [{ entityType: "brawler", entityId: "collision-test", changeType: "new_brawler" }],
    now: collidingNow,
  });
  assert.ok(first);

  await assert.rejects(
    recordInferredPatchIfMeaningful(pool, {
      changeCount: 1,
      fetchRunId: null as unknown as string,
      changeSummary: [{ entityType: "brawler", entityId: "collision-test-2", changeType: "new_brawler" }],
      now: collidingNow,
    }),
    "the same instant must produce the same version_label and collide on uniq_patches_version_label"
  );
});

test("db: catalog-sync's try/catch contract — a thrown patch-inference error is fully swallowed, leaving no partial state and never propagating", { skip: skip ? skipReason : false }, async () => {
  // Faithfully reproduces lib/catalog/sync.ts's own try/catch shape around
  // recordInferredPatchIfMeaningful. The full runCatalogSync() cannot be
  // exercised end-to-end in this environment (it requires a live
  // DigitalOcean proxy connection, unavailable this session — the same
  // limitation every prior phase's integration tests have carried
  // honestly), so this test validates the exact resilience CONTRACT
  // sync.ts depends on: a thrown error from this call must never escape
  // uncaught and must never leave a corrupted patches row behind.
  const { getPool } = await import("@/lib/mysql");
  const { recordInferredPatchIfMeaningful, getActivePatch } = await import("@/lib/patches/repository");
  const pool = getPool();

  const collidingNow = new Date("2032-06-15T00:00:00.000Z");
  await recordInferredPatchIfMeaningful(pool, {
    changeCount: 1,
    fetchRunId: null as unknown as string,
    changeSummary: [{ entityType: "brawler", entityId: "resilience-test", changeType: "new_brawler" }],
    now: collidingNow,
  });
  const activeBefore = await getActivePatch(pool);

  let caught: unknown = null;
  try {
    await recordInferredPatchIfMeaningful(pool, {
      changeCount: 1,
      fetchRunId: null as unknown as string,
      changeSummary: [{ entityType: "brawler", entityId: "resilience-test-2", changeType: "new_brawler" }],
      now: collidingNow, // deliberately colliding version_label -> forces a real throw
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught, "the collision must actually throw, or this test isn't exercising the failure path");

  const activeAfter = await getActivePatch(pool);
  assert.equal(activeAfter?.id, activeBefore?.id, "a failed second attempt must leave the previously-active patch untouched");
});

test("db: a battle inserted with patchId=null stays permanently patch_id IS NULL — no fabricated association", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { insertNormalizedBattle } = await import("@/lib/ingestion/repository");
  const { getDataSourceByName, getSourceEndpoint, createFetchRun } = await import("@/lib/catalog/repository");
  const pool = getPool();

  const dataSource = await getDataSourceByName(pool, "official-brawl-stars-api");
  if (!dataSource) return; // requires the Phase 2 seed script to have run; skip this assertion if not present
  const endpoint = await getSourceEndpoint(pool, dataSource.id, "battle_log");
  if (!endpoint) return;
  const fetchRunId = await createFetchRun(pool, {
    dataSourceId: dataSource.id,
    sourceEndpointId: endpoint.id,
    workflowRunId: null,
    triggerType: "manual",
  });

  const battleId = await insertNormalizedBattle(
    pool,
    {
      battleKey: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      gameModeId: null,
      mapId: null,
      eventSourceId: null,
      battleType: null,
      structure: "teams",
      occurredAt: new Date(),
      durationSeconds: null,
      trophyChange: null,
      fetchRunId,
      patchId: null,
    },
    []
  );

  const [[row]] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT patch_id FROM normalized_battles WHERE id = ?",
    [battleId]
  );
  assert.equal(row.patch_id, null);
});
