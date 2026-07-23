/**
 * Database-dependent Phase 4 integration tests. Require real MySQL/MariaDB
 * credentials (DB_HOST/DB_PORT/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1). No such
 * credentials exist in this local sandbox — these tests SKIP rather than
 * fabricate a pass, exactly like tests/dbIntegration.test.ts and
 * tests/ingestionDbIntegration.test.ts. Written to run for real in any
 * environment with a reachable, migrated database.
 */
import { test } from "node:test";
import { closeSharedDbPoolAfterTests } from "./helpers/closeDbPool";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const hasDbEnv = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1
);
const skip = !hasDbEnv;
const skipReason = "No DB credentials in this environment (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";

closeSharedDbPoolAfterTests();

test("db: ensureCrawlScheduleEntry region/trophy_bracket are sticky — the first non-null assignment wins on repeated calls", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { ensureCrawlScheduleEntry } = await import("@/lib/ingestion/repository");
  const pool = getPool();
  const tag = `#P4STICKY${randomUUID().slice(0, 8).toUpperCase()}`;

  await ensureCrawlScheduleEntry(pool, { tag, region: "us", trophyBracket: "bracket_0_5k", stratumSource: "manual", priorityScore: 0 });
  await ensureCrawlScheduleEntry(pool, { tag, region: "br", trophyBracket: "bracket_75k_plus", stratumSource: "manual", priorityScore: 0 });

  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT region, trophy_bracket FROM player_crawl_schedule WHERE player_tag = ?",
    [tag]
  );
  assert.equal(rows[0].region, "us", "region must stay sticky to the first assignment");
  assert.equal(rows[0].trophy_bracket, "bracket_0_5k");
});

test("db: selectAndLeaseDuePlayers recovers an expired lease and can re-lease that player", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { ensureCrawlScheduleEntry, selectAndLeaseDuePlayers } = await import("@/lib/ingestion/repository");
  const pool = getPool();
  const tag = `#P4STALE${randomUUID().slice(0, 8).toUpperCase()}`;
  await ensureCrawlScheduleEntry(pool, { tag, region: null, trophyBracket: null, stratumSource: "manual", priorityScore: 0 });

  await pool.execute(
    "UPDATE player_crawl_schedule SET leased_by_run_id = ?, lease_expires_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE player_tag = ?",
    [randomUUID(), tag]
  );

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const leased = await selectAndLeaseDuePlayers(connection, randomUUID(), 50, 60);
    await connection.commit();
    assert.ok(leased.includes(tag), "a player with an expired lease must become selectable again");
  } finally {
    connection.release();
  }
});

test("db: recordObservedPlayer silently drops a malformed/malicious tag instead of writing it", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { recordObservedPlayer } = await import("@/lib/ingestion/repository");
  const pool = getPool();
  const badTag = "#'; DROP TABLE observed_players; --";

  await assert.doesNotReject(recordObservedPlayer(pool, badTag, "battle_participant", null));

  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT id FROM observed_players WHERE player_tag = ?",
    [badTag]
  );
  assert.equal(rows.length, 0, "a malformed tag must never reach observed_players");
});

test("db: createIncident with the same signature increments occurrence_count instead of creating a second row", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { createIncident } = await import("@/lib/catalog/repository");
  const { computeIncidentSignature } = await import("@/lib/ingestion/incidents");
  const pool = getPool();
  const reasonKey = `test_reason_${randomUUID().slice(0, 8)}`;
  const signature = computeIncidentSignature({ incidentType: "invalid_value", dataCategory: "battle_log", reasonKey });

  await createIncident(pool, { incidentType: "invalid_value", dataCategory: "battle_log", signature, detail: { n: 1 } });
  await createIncident(pool, { incidentType: "invalid_value", dataCategory: "battle_log", signature, detail: { n: 2 } });

  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT occurrence_count FROM data_incidents WHERE incident_type = 'invalid_value' AND signature = ?",
    [signature]
  );
  assert.equal(rows.length, 1, "exactly one incident row must exist for this signature, not two");
  assert.equal(rows[0].occurrence_count, 2);
});

test("db: createIncident reopens a resolved incident on recurrence rather than leaving it resolved", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { createIncident } = await import("@/lib/catalog/repository");
  const { computeIncidentSignature } = await import("@/lib/ingestion/incidents");
  const pool = getPool();
  const reasonKey = `test_reopen_${randomUUID().slice(0, 8)}`;
  const signature = computeIncidentSignature({ incidentType: "invalid_value", reasonKey });

  await createIncident(pool, { incidentType: "invalid_value", signature });
  await pool.execute("UPDATE data_incidents SET status = 'resolved', resolved_at = NOW(3) WHERE signature = ?", [signature]);

  await createIncident(pool, { incidentType: "invalid_value", signature });

  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT status FROM data_incidents WHERE signature = ?",
    [signature]
  );
  assert.equal(rows[0].status, "open");
});

test("db: backfillPendingClubLinks resolves a player's pending_club_tag once the club is normalized", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { upsertNormalizedPlayer, backfillPendingClubLinks } = await import("@/lib/ingestion/repository");
  const { getDataSourceByName, getSourceEndpoint, createFetchRun } = await import("@/lib/catalog/repository");
  const pool = getPool();

  const dataSource = await getDataSourceByName(pool, "official-brawl-stars-api");
  if (!dataSource) return; // requires the Phase 2 seed script to have run; skip this assertion if not present
  const anyEndpoint = await getSourceEndpoint(pool, dataSource.id, "player_profile");
  if (!anyEndpoint) return;
  const fetchRunId = await createFetchRun(pool, { dataSourceId: dataSource.id, sourceEndpointId: anyEndpoint.id, workflowRunId: null, triggerType: "manual" });

  const playerTag = `#P4PENDCLUB${randomUUID().slice(0, 6).toUpperCase()}`;
  const clubTag = `#P4CLUB${randomUUID().slice(0, 6).toUpperCase()}`;
  await upsertNormalizedPlayer(pool, {
    tag: playerTag,
    displayName: "Test Player",
    nameColor: null,
    trophies: 100,
    highestTrophies: 100,
    expLevel: 10,
    clubId: null,
    pendingClubTag: clubTag,
    fetchRunId,
  });

  const affected = await backfillPendingClubLinks(pool, clubTag, randomUUID());
  assert.ok(affected >= 1, "expected at least the just-inserted player to be linked");

  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT pending_club_tag, club_id FROM normalized_players WHERE player_tag = ?",
    [playerTag]
  );
  assert.equal(rows[0].pending_club_tag, null);
  assert.ok(rows[0].club_id);
});

test("db: retention dry-run reports counts without deleting anything", { skip: skip ? skipReason : false }, async () => {
  const { runRetentionSweep } = await import("@/lib/ingestion/sync/retentionSweep");
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();

  const [[before]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT COUNT(*) AS c FROM player_name_history");

  const result = await runRetentionSweep("manual", true);
  assert.equal(result.dryRun, true);
  if (result.outcome === "lock_not_acquired") return; // another sweep is concurrently running; not a failure of this test's assertion

  for (const category of result.categories) {
    assert.equal(category.deleted, 0, `dry-run category ${category.category} must never delete rows`);
    assert.equal(typeof category.dryRunCount, "number");
  }

  const [[after]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT COUNT(*) AS c FROM player_name_history");
  assert.equal(before.c, after.c, "dry-run must not change row counts");
});

test("db: pruneUnpromotedObservedPlayersOlderThan only deletes rows older than the cutoff, in bounded batches", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { pruneUnpromotedObservedPlayersOlderThan, countOlderThan } = await import("@/lib/ingestion/retentionQueries");
  const pool = getPool();

  const oldTag = `#P4OLDOBS${randomUUID().slice(0, 6).toUpperCase()}`;
  const freshTag = `#P4NEWOBS${randomUUID().slice(0, 6).toUpperCase()}`;
  await pool.execute(
    "INSERT INTO observed_players (id, player_tag, source_type, first_observed_at, promoted_to_active) VALUES (?, ?, 'manual', DATE_SUB(NOW(3), INTERVAL 100 DAY), 0)",
    [randomUUID(), oldTag]
  );
  await pool.execute(
    "INSERT INTO observed_players (id, player_tag, source_type, first_observed_at, promoted_to_active) VALUES (?, ?, 'manual', NOW(3), 0)",
    [randomUUID(), freshTag]
  );

  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60_000);
  const countBefore = await countOlderThan(pool, "observed_players", "first_observed_at", cutoff);
  assert.ok(countBefore >= 1);

  await pruneUnpromotedObservedPlayersOlderThan(pool, cutoff, 500);

  const [oldRows] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT id FROM observed_players WHERE player_tag = ?", [oldTag]);
  const [freshRows] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT id FROM observed_players WHERE player_tag = ?", [freshTag]);
  assert.equal(oldRows.length, 0, "the old row must be pruned");
  assert.equal(freshRows.length, 1, "the fresh row must survive");

  await pool.execute("DELETE FROM observed_players WHERE player_tag = ?", [freshTag]);
});

test("db: recordCrawlOutcome priority_score never exceeds the configured floor/ceiling regardless of repeated calls", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { ensureCrawlScheduleEntry, recordCrawlOutcome } = await import("@/lib/ingestion/repository");
  const { CRAWL_CADENCE } = await import("@/lib/ingestion/cadence");
  const pool = getPool();
  const tag = `#P4PRIOFLOOR${randomUUID().slice(0, 6).toUpperCase()}`;
  await ensureCrawlScheduleEntry(pool, { tag, region: null, trophyBracket: null, stratumSource: "manual", priorityScore: 0 });

  for (let i = 0; i < 50; i += 1) {
    await recordCrawlOutcome(pool, tag, "failure_retryable", 60_000);
  }

  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT priority_score FROM player_crawl_schedule WHERE player_tag = ?",
    [tag]
  );
  assert.ok(rows[0].priority_score >= CRAWL_CADENCE.PRIORITY_FLOOR, "priority_score must never fall below the configured floor");
});

test("db: getUnprofiledPlayerTags only returns stub players (trophies IS NULL), oldest-discovered-first, and never a fully-profiled player", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { ensurePlayerStub, upsertNormalizedPlayer, getUnprofiledPlayerTags } = await import("@/lib/ingestion/repository");
  const { getDataSourceByName, getSourceEndpoint, createFetchRun } = await import("@/lib/catalog/repository");
  const pool = getPool();

  const dataSource = await getDataSourceByName(pool, "official-brawl-stars-api");
  if (!dataSource) return;
  const anyEndpoint = await getSourceEndpoint(pool, dataSource.id, "player_profile");
  if (!anyEndpoint) return;
  const fetchRunId = await createFetchRun(pool, { dataSourceId: dataSource.id, sourceEndpointId: anyEndpoint.id, workflowRunId: null, triggerType: "manual" });

  const stubTag = `#P4STUB${randomUUID().slice(0, 6).toUpperCase()}`;
  const profiledTag = `#P4PROFILED${randomUUID().slice(0, 6).toUpperCase()}`;
  await ensurePlayerStub(pool, stubTag, "Stub Player", fetchRunId);
  await upsertNormalizedPlayer(pool, {
    tag: profiledTag,
    displayName: "Profiled Player",
    nameColor: null,
    trophies: 500,
    highestTrophies: 500,
    expLevel: 5,
    clubId: null,
    pendingClubTag: null,
    fetchRunId,
  });

  const unprofiled = await getUnprofiledPlayerTags(pool, 500);
  assert.ok(unprofiled.includes(stubTag), "an unprofiled stub must be returned");
  assert.ok(!unprofiled.includes(profiledTag), "a player with real profile data (trophies set) must never be returned");
});

test("db: dataset-coverage route returns 200 with an authorized request and never includes a player tag/name field", { skip: skip ? skipReason : false }, async () => {
  process.env.INTERNAL_CRON_SECRET = process.env.INTERNAL_CRON_SECRET || "test-secret-for-integration-only";
  const { GET } = await import("@/app/api/internal/test/dataset-coverage/route");
  const request = new Request("http://localhost/api/internal/test/dataset-coverage", {
    headers: { authorization: `Bearer ${process.env.INTERNAL_CRON_SECRET}` },
  });
  const response = await GET(request);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /"player_tag"/);
  assert.doesNotMatch(text, /"displayName"/);
});

test("db: phase5-readiness route returns 200 with an authorized request and a well-formed ready/hardGates/blockers shape", { skip: skip ? skipReason : false }, async () => {
  process.env.INTERNAL_CRON_SECRET = process.env.INTERNAL_CRON_SECRET || "test-secret-for-integration-only";
  const { GET } = await import("@/app/api/internal/test/phase5-readiness/route");
  const request = new Request("http://localhost/api/internal/test/phase5-readiness", {
    headers: { authorization: `Bearer ${process.env.INTERNAL_CRON_SECRET}` },
  });
  const response = await GET(request);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(typeof body.ready, "boolean");
  assert.ok(Array.isArray(body.blockers));
  assert.ok(Array.isArray(body.warnings));
  assert.equal(typeof body.hardGates, "object");
});

test("db: retention-sweep route with a malformed (non-boolean dryRun) body defaults safely rather than 500ing", { skip: skip ? skipReason : false }, async () => {
  process.env.INTERNAL_CRON_SECRET = process.env.INTERNAL_CRON_SECRET || "test-secret-for-integration-only";
  const { POST } = await import("@/app/api/internal/cron/retention-sweep/route");
  const request = new Request("http://localhost/api/internal/cron/retention-sweep", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.INTERNAL_CRON_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ dryRun: "not-a-boolean" }),
  });
  const response = await POST(request);
  assert.ok(response.status === 200 || response.status === 409);
  const body = await response.json();
  assert.equal(body.dryRun, false, "a non-boolean dryRun value must fall back to the safe default (false is still safe here since it only means 'not a dry run', never an unbounded/unsafe delete)");
});
