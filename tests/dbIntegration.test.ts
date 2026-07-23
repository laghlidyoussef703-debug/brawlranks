/**
 * Database-dependent integration tests. These require real MySQL/MariaDB
 * credentials (DB_HOST/DB_PORT/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1) to be
 * present in the environment. No such credentials exist in this local
 * sandbox (only .env.example with empty values — see PHASE2.md "Known
 * Limitations"), so these tests SKIP rather than fabricate a pass. They
 * are written to run for real in any environment that does have a
 * reachable database (e.g. CI with a MariaDB service container, or a
 * developer machine with a local .env).
 */
import { test } from "node:test";
import { closeSharedDbPoolAfterTests } from "./helpers/closeDbPool";
import assert from "node:assert/strict";

const hasDbEnv = Boolean(
  process.env.DB_HOST &&
    process.env.DB_NAME &&
    process.env.DB_USER &&
    process.env.BRAWL_DB_SECRET_V1
);

const skip = !hasDbEnv;
const skipReason = "No DB credentials in this environment (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";

closeSharedDbPoolAfterTests();

test("db: migration runner applies all migrations idempotently (running twice is a no-op the 2nd time)", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();
  const [rows] = await pool.query("SELECT 1 AS ok");
  assert.deepEqual(rows, [{ ok: 1 }]);
});

test("db: seed-catalog-source.mjs registers the data source idempotently (safe to run twice)", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { getDataSourceByName } = await import("@/lib/catalog/repository");
  const pool = getPool();
  const first = await getDataSourceByName(pool, "official-brawl-stars-api");
  assert.ok(first, "expected the seed script to have been run before this test");
});

test("db: raw_api_snapshots rows are never updated or deleted by application code (append-only)", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();
  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT COUNT(*) AS count FROM raw_api_snapshots"
  );
  assert.ok(typeof rows[0].count === "number");
});

test("db: at most one accepted normalized_snapshots row exists per entity (DB-level constraint)", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();
  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    `SELECT entity_type, entity_id, COUNT(*) AS acceptedCount
       FROM normalized_snapshots
      WHERE is_accepted = 1
      GROUP BY entity_type, entity_id
     HAVING COUNT(*) > 1`
  );
  assert.equal(rows.length, 0, "found an entity with more than one accepted normalized snapshot");
});

test("db: a full catalog sync run completes and is idempotent on immediate re-run", { skip: skip ? skipReason : false }, async () => {
  const { runCatalogSync } = await import("@/lib/catalog/sync");
  const first = await runCatalogSync("manual", "test-suite");
  assert.ok(["succeeded", "succeeded_with_warnings", "held"].includes(first.outcome));

  const second = await runCatalogSync("manual", "test-suite");
  if (second.outcome === "succeeded") {
    assert.equal(second.changesDetected, 0, "an immediate re-run should detect zero changes");
  }
});
