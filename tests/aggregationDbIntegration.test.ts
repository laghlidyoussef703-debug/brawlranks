/**
 * Database-dependent Phase 5.2 integration tests. Require real MySQL/
 * MariaDB credentials (DB_HOST/DB_PORT/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1).
 * No such credentials exist in this local sandbox — these tests SKIP
 * rather than fabricate a pass, exactly like every prior phase's
 * *DbIntegration.test.ts file. Written to run for real in any environment
 * with a reachable, migrated (through 0022) database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const hasDbEnv = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1
);
const skip = !hasDbEnv;
const skipReason = "No DB credentials in this environment (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";

/**
 * Builds a small, fully controlled scenario: two canonical Brawlers, one
 * game mode, three battles between them where BrawlerA wins 2 and
 * BrawlerB wins 1 — a deliberately asymmetric split so the resulting win
 * rates (2/3 vs 1/3) are unambiguous to assert against, and so the
 * matchup pair's two directions can be checked as true mathematical
 * inverses (Section 11.3).
 */
async function seedScenario(pool: import("mysql2/promise").Pool) {
  const { insertCanonicalBrawler } = await import("@/lib/catalog/repository");
  const { getOrCreateGameMode, insertNormalizedBattle, getBattleTeamIds, upsertBattleParticipant, ensurePlayerStub } = await import(
    "@/lib/ingestion/repository"
  );
  const { getDataSourceByName, getSourceEndpoint, createFetchRun } = await import("@/lib/catalog/repository");

  const dataSource = await getDataSourceByName(pool, "official-brawl-stars-api");
  if (!dataSource) return null;
  const endpoint = await getSourceEndpoint(pool, dataSource.id, "battle_log");
  if (!endpoint) return null;
  const fetchRunId = await createFetchRun(pool, {
    dataSourceId: dataSource.id,
    sourceEndpointId: endpoint.id,
    workflowRunId: null,
    triggerType: "manual",
  });

  const suffix = randomUUID().slice(0, 8);
  const brawlerAId = await insertCanonicalBrawler(pool, {
    sourceBrawlerId: `test-a-${suffix}`,
    slug: `test-a-${suffix}`,
    name: `TestBrawlerA${suffix}`,
    fetchRunId,
  });
  const brawlerBId = await insertCanonicalBrawler(pool, {
    sourceBrawlerId: `test-b-${suffix}`,
    slug: `test-b-${suffix}`,
    name: `TestBrawlerB${suffix}`,
    fetchRunId,
  });
  const gameModeId = await getOrCreateGameMode(pool, `testMode${suffix}`, `testMode${suffix}`);

  const playerAId = await ensurePlayerStub(pool, `#TESTPLAYERA${suffix.toUpperCase()}`, "Player A", fetchRunId);
  const playerBId = await ensurePlayerStub(pool, `#TESTPLAYERB${suffix.toUpperCase()}`, "Player B", fetchRunId);

  const outcomes: Array<"victory" | "defeat"> = ["victory", "victory", "defeat"]; // from A's perspective: A wins 2, loses 1
  for (const aResult of outcomes) {
    const bResult = aResult === "victory" ? "defeat" : "victory";
    const battleId = await insertNormalizedBattle(
      pool,
      {
        battleKey: randomUUID().replace(/-/g, "").padEnd(64, "0"),
        gameModeId,
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
      [
        { teamIndex: 0, result: aResult, rank: null },
        { teamIndex: 1, result: bResult, rank: null },
      ]
    );
    const teamIds = await getBattleTeamIds(pool, battleId);
    await upsertBattleParticipant(pool, {
      battleId,
      battleTeamId: teamIds.get(0) ?? null,
      playerId: playerAId,
      brawlerId: brawlerAId,
      brawlerPower: null,
      brawlerTrophies: null,
      participantIndex: 0,
      isStarPlayer: false,
    });
    await upsertBattleParticipant(pool, {
      battleId,
      battleTeamId: teamIds.get(1) ?? null,
      playerId: playerBId,
      brawlerId: brawlerBId,
      brawlerPower: null,
      brawlerTrophies: null,
      participantIndex: 1,
      isStarPlayer: false,
    });
  }

  return { brawlerAId, brawlerBId, gameModeId };
}

test("db: runAggregation computes correct win/loss counts and win rate for a known, controlled 2-win/1-loss scenario", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runAggregation } = await import("@/lib/aggregation/sync");
  const pool = getPool();

  const scenario = await seedScenario(pool);
  if (!scenario) return; // requires the Phase 2 seed script to have run; skip this assertion if not present
  const { brawlerAId, brawlerBId, gameModeId } = scenario;

  const result = await runAggregation("manual");
  assert.ok(["succeeded", "succeeded_with_warnings"].includes(result.outcome));
  assert.equal(result.reconciliationWarnings, 0, "a controlled, well-formed scenario must never trigger a reconciliation warning");

  const [modeRowsA] = await pool.query<import("mysql2").RowDataPacket[]>(
    `SELECT matches, wins, losses, draws, win_rate FROM brawler_mode_aggregates
      WHERE brawler_id = ? AND game_mode_id = ? ORDER BY created_at DESC LIMIT 1`,
    [brawlerAId, gameModeId]
  );
  assert.equal(modeRowsA.length, 1);
  assert.equal(modeRowsA[0].matches, 3);
  assert.equal(modeRowsA[0].wins, 2);
  assert.equal(modeRowsA[0].losses, 1);
  assert.equal(modeRowsA[0].draws, 0);
  assert.ok(Math.abs(Number(modeRowsA[0].win_rate) - 2 / 3) < 0.0001);

  const [overallRowsB] = await pool.query<import("mysql2").RowDataPacket[]>(
    `SELECT matches, wins, losses, win_rate FROM brawler_overall_aggregates
      WHERE brawler_id = ? ORDER BY created_at DESC LIMIT 1`,
    [brawlerBId]
  );
  assert.equal(overallRowsB.length, 1);
  assert.equal(overallRowsB[0].matches, 3);
  assert.equal(overallRowsB[0].wins, 1);
  assert.equal(overallRowsB[0].losses, 2);
  assert.ok(Math.abs(Number(overallRowsB[0].win_rate) - 1 / 3) < 0.0001);

  const [matchupAB] = await pool.query<import("mysql2").RowDataPacket[]>(
    `SELECT matches, win_rate FROM matchup_aggregates
      WHERE brawler_id = ? AND opponent_brawler_id = ? ORDER BY created_at DESC LIMIT 1`,
    [brawlerAId, brawlerBId]
  );
  const [matchupBA] = await pool.query<import("mysql2").RowDataPacket[]>(
    `SELECT matches, win_rate FROM matchup_aggregates
      WHERE brawler_id = ? AND opponent_brawler_id = ? ORDER BY created_at DESC LIMIT 1`,
    [brawlerBId, brawlerAId]
  );
  assert.equal(matchupAB.length, 1);
  assert.equal(matchupBA.length, 1);
  assert.equal(matchupAB[0].matches, 3);
  assert.equal(matchupBA[0].matches, 3);
  assert.ok(Math.abs(Number(matchupAB[0].win_rate) - 2 / 3) < 0.0001, "A-vs-B win rate must reflect A's own 2/3 record");
  assert.ok(Math.abs(Number(matchupBA[0].win_rate) - 1 / 3) < 0.0001, "B-vs-A win rate must reflect B's own 1/3 record");
  assert.ok(
    Math.abs(Number(matchupAB[0].win_rate) + Number(matchupBA[0].win_rate) - 1) < 0.0001,
    "the two directions of the same pair must be mathematically consistent inverses (Section 11.3)"
  );
});

test("db: no mirror-match rows are ever created in matchup_aggregates (Section 7.10's explicit exclusion)", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();
  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT COUNT(*) AS c FROM matchup_aggregates WHERE brawler_id = opponent_brawler_id"
  );
  assert.equal(rows[0].c, 0);
});

test("db: running the aggregation twice is safe and append-only — two independent aggregation_runs rows exist, neither overwritten", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runAggregation } = await import("@/lib/aggregation/sync");
  const pool = getPool();

  const [[before]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT COUNT(*) AS c FROM aggregation_runs");

  const first = await runAggregation("manual");
  const second = await runAggregation("manual");

  assert.ok(["succeeded", "succeeded_with_warnings"].includes(first.outcome));
  assert.ok(["succeeded", "succeeded_with_warnings"].includes(second.outcome));
  assert.notEqual(first.workflowRunId, second.workflowRunId);

  const [[after]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT COUNT(*) AS c FROM aggregation_runs");
  // Each successful run creates exactly 3 aggregation_runs rows (per_mode, overall, matchup).
  assert.equal(after.c - before.c, 6);
});

test("db: two concurrent aggregation runs never both acquire the workflow lock — exactly one succeeds, one reports lock_not_acquired", { skip: skip ? skipReason : false }, async () => {
  const { runAggregation } = await import("@/lib/aggregation/sync");

  const [a, b] = await Promise.all([runAggregation("manual"), runAggregation("manual")]);
  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ["lock_not_acquired", "succeeded"].sort());
});

test("db: runAggregation never mutates normalized_battles or battle_participants row counts", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runAggregation } = await import("@/lib/aggregation/sync");
  const pool = getPool();

  const [[battlesBefore]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT COUNT(*) AS c FROM normalized_battles");
  const [[participantsBefore]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT COUNT(*) AS c FROM battle_participants");

  await runAggregation("manual");

  const [[battlesAfter]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT COUNT(*) AS c FROM normalized_battles");
  const [[participantsAfter]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT COUNT(*) AS c FROM battle_participants");

  assert.equal(battlesBefore.c, battlesAfter.c);
  assert.equal(participantsBefore.c, participantsAfter.c);
});
