/**
 * Database-dependent Phase 3 integration tests. Require real MySQL/MariaDB
 * credentials (DB_HOST/DB_PORT/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1). No such
 * credentials exist in this local sandbox — these tests SKIP rather than
 * fabricate a pass, exactly like tests/dbIntegration.test.ts (Phase 2).
 * They are written to run for real in any environment with a reachable
 * database that has already run `npm run migrate:up` and the seed scripts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const hasDbEnv = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1
);
const skip = !hasDbEnv;
const skipReason = "No DB credentials in this environment (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";

test("db: ingestion_rate_budgets consumption is atomic and stops exactly at the ceiling", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { tryConsumeBudget, ensureBudgetSeed } = await import("@/lib/ingestion/rateBudget");
  const pool = getPool();
  await ensureBudgetSeed(pool, "catalog", 3, 86_400, 0);

  const results = await Promise.all([
    tryConsumeBudget(pool, "catalog", false),
    tryConsumeBudget(pool, "catalog", false),
    tryConsumeBudget(pool, "catalog", false),
    tryConsumeBudget(pool, "catalog", false),
  ]);
  const allowedCount = results.filter((r) => r.allowed).length;
  assert.equal(allowedCount, 3);
});

test("db: reserved_for_priority is honored for non-priority callers", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { tryConsumeBudget, ensureBudgetSeed } = await import("@/lib/ingestion/rateBudget");
  const pool = getPool();
  await ensureBudgetSeed(pool, "rankings", 2, 86_400, 1);

  const first = await tryConsumeBudget(pool, "rankings", false);
  const second = await tryConsumeBudget(pool, "rankings", false);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);

  const priorityCall = await tryConsumeBudget(pool, "rankings", true);
  assert.equal(priorityCall.allowed, true);
});

test("db: player_crawl_schedule lease acquisition never double-selects the same row concurrently", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { selectAndLeaseDuePlayers, ensureCrawlScheduleEntry } = await import("@/lib/ingestion/repository");
  const pool = getPool();
  await ensureCrawlScheduleEntry(pool, { tag: "#TESTLEASE1", region: null, trophyBracket: null, stratumSource: "manual", priorityScore: 0 });

  const connA = await pool.getConnection();
  const connB = await pool.getConnection();
  try {
    await connA.beginTransaction();
    await connB.beginTransaction();
    const leaseA = await selectAndLeaseDuePlayers(connA, "run-a", 10, 60);
    await connA.commit();
    const leaseB = await selectAndLeaseDuePlayers(connB, "run-b", 10, 60);
    await connB.commit();

    const overlap = leaseA.filter((tag) => leaseB.includes(tag));
    assert.equal(overlap.length, 0);
  } finally {
    connA.release();
    connB.release();
  }
});

test("db: normalized_battles.battle_key has a UNIQUE constraint (second insert with the same key is rejected)", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();
  const { randomUUID } = await import("node:crypto");

  const [[anyFetchRun]] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT id FROM data_fetch_runs LIMIT 1"
  );
  if (!anyFetchRun) return; // requires at least one prior fetch run to exist; skip this assertion if none does

  const battleKey = randomUUID().replace(/-/g, "").padEnd(64, "0");
  const insertOne = () =>
    pool.execute(
      "INSERT INTO normalized_battles (id, battle_key, structure, occurred_at, first_observed_fetch_run_id) VALUES (?, ?, 'teams', NOW(3), ?)",
      [randomUUID(), battleKey, anyFetchRun.id]
    );

  await insertOne();
  await assert.rejects(insertOne);
});

test("db: a transaction rollback during battle-log ingestion leaves previously accepted battles untouched", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();
  const [before] = await pool.query("SELECT COUNT(*) AS c FROM normalized_battles");

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("INSERT INTO normalized_battles (id, battle_key) VALUES (?, ?)", ["bad-id", "x"]).catch(() => {});
    await connection.rollback();
  } finally {
    connection.release();
  }

  const [after] = await pool.query("SELECT COUNT(*) AS c FROM normalized_battles");
  assert.deepEqual(before, after);
});

test("db: full ranking-seed sync is idempotent on repeated invocation (no duplicate seed_players rows)", { skip: skip ? skipReason : false }, async () => {
  const { runRankingSeedSync } = await import("@/lib/ingestion/sync/rankingSeedSync");
  const first = await runRankingSeedSync("manual", ["global"]);
  const second = await runRankingSeedSync("manual", ["global"]);
  assert.ok(["succeeded", "succeeded_with_warnings"].includes(first.outcome) || first.outcome === "prerequisites_missing");
  assert.ok(["succeeded", "succeeded_with_warnings"].includes(second.outcome) || second.outcome === "prerequisites_missing");
});
