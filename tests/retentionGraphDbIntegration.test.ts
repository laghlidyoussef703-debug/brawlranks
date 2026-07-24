/**
 * DATASET Phase 14 — battle-graph lifecycle ISOLATED-DB proof (restore / replay /
 * FK + FK-safe deletion). This mutates real tables, so it is DOUBLE-gated and
 * NEVER runs by accident:
 *
 *   - requires RETENTION_GRAPH_DB_TEST === "1"  (explicit operator opt-in), AND
 *   - requires DB credentials, AND
 *   - requires RETENTION_ENVIRONMENT === "isolated_staging" (the production
 *     guard — refuses to run anywhere not explicitly marked disposable).
 *
 * It also needs the isolated DB to be BOOTSTRAPPED (a data source, endpoint,
 * brawler, and player already present, plus migrations through 0031); it SKIPS
 * cleanly otherwise. It seeds only a small, self-contained battle graph
 * (occurred_at 400 days old), runs plan -> archive -> verify -> reimport ->
 * delete against a real InMemory object store, asserts the restore/replay/FK
 * proof and FK-safe deletion, then cleans up everything it created.
 *
 * Run it ONLY against a disposable copy:
 *   RETENTION_GRAPH_DB_TEST=1 RETENTION_ENVIRONMENT=isolated_staging \
 *   DB_HOST=... DB_NAME=... DB_USER=... BRAWL_DB_SECRET_V1=... \
 *   npx tsx --test tests/retentionGraphDbIntegration.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { InMemoryObjectStorage } from "@/lib/archive/provider";
import { closeSharedDbPoolAfterTests } from "./helpers/closeDbPool";

const enabled =
  process.env.RETENTION_GRAPH_DB_TEST === "1" &&
  process.env.RETENTION_ENVIRONMENT === "isolated_staging" &&
  Boolean(process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1);
const skipReason = "Set RETENTION_GRAPH_DB_TEST=1 + RETENTION_ENVIRONMENT=isolated_staging + DB creds to run against a DISPOSABLE db.";

closeSharedDbPoolAfterTests();

const BUCKET = "graph-it";
const DAY = 86_400_000;
const created = { battleIds: [] as string[], fetchRunId: "", envId: "" };

async function firstId(pool: Pool, sql: string): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>(sql);
  return rows[0]?.id ?? null;
}

before(async () => {
  if (!enabled) return;
  process.env.RETENTION_DESTRUCTIVE_ENABLED = "true";
});

after(async () => {
  if (!enabled) return;
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();
  // Best-effort cleanup in FK-safe order.
  for (const bid of created.battleIds) {
    await pool.query("DELETE FROM battle_participants WHERE battle_id = ?", [bid]).catch(() => {});
    await pool.query("DELETE FROM battle_teams WHERE battle_id = ?", [bid]).catch(() => {});
    await pool.query("DELETE FROM battle_observations WHERE battle_id = ?", [bid]).catch(() => {});
    await pool.query("DELETE FROM normalized_battles WHERE id = ?", [bid]).catch(() => {});
  }
  if (created.fetchRunId) await pool.query("DELETE FROM data_fetch_runs WHERE id = ?", [created.fetchRunId]).catch(() => {});
  if (created.envId) await pool.query("DELETE FROM retention_environment_attestations WHERE environment_id = ?", [created.envId]).catch(() => {});
});

test("db(isolated): battle graph archive -> verify -> reimport(restore/replay/FK) -> FK-safe delete", { skip: enabled ? false : skipReason }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const graph = await import("@/lib/retention/graph");
  const pool = getPool();

  // Reuse existing bootstrap FK parents; skip if the isolated DB is empty.
  const sourceId = await firstId(pool, "SELECT id FROM data_sources LIMIT 1");
  const endpointId = await firstId(pool, "SELECT id FROM source_endpoints LIMIT 1");
  const brawlerId = await firstId(pool, "SELECT id FROM canonical_brawlers LIMIT 1");
  const playerId = await firstId(pool, "SELECT id FROM normalized_players LIMIT 1");
  if (!sourceId || !endpointId || !brawlerId || !playerId) {
    // Not bootstrapped — nothing to safely seed against.
    return;
  }

  // Seed a self-contained, 400-day-old battle graph.
  const fetchRunId = randomUUID();
  created.fetchRunId = fetchRunId;
  await pool.query(
    "INSERT INTO data_fetch_runs (id, data_source_id, source_endpoint_id, trigger_type, status, started_at) VALUES (?, ?, ?, 'manual', 'success', NOW(3) - INTERVAL 400 DAY)",
    [fetchRunId, sourceId, endpointId]
  );
  const battleIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const bid = randomUUID();
    battleIds.push(bid);
    created.battleIds.push(bid);
    await pool.query(
      "INSERT INTO normalized_battles (id, battle_key, structure, occurred_at, first_observed_fetch_run_id) VALUES (?, ?, 'teams', NOW(3) - INTERVAL 400 DAY, ?)",
      [bid, `it-${bid}`.slice(0, 64), fetchRunId]
    );
    const teamId = randomUUID();
    await pool.query("INSERT INTO battle_teams (id, battle_id, team_index, result) VALUES (?, ?, 0, 'victory')", [teamId, bid]);
    await pool.query(
      "INSERT INTO battle_participants (id, battle_id, battle_team_id, player_id, brawler_id, participant_index) VALUES (?, ?, ?, ?, ?, 0)",
      [randomUUID(), bid, teamId, playerId, brawlerId]
    );
    await pool.query(
      "INSERT INTO battle_observations (id, battle_id, data_fetch_run_id, observed_via_player_tag) VALUES (?, ?, ?, '#IT')",
      [randomUUID(), bid, fetchRunId]
    );
  }

  // Isolated-staging attestation for reimport/delete.
  const envId = randomUUID();
  created.envId = envId;
  await pool.query(
    "INSERT INTO retention_environment_attestations (environment_id, purpose, confirmed_by, evidence_reference, expires_at) VALUES (?, 'isolated_staging', 'graph-it', 'test', NOW(3) + INTERVAL 1 HOUR)",
    [envId]
  );

  const store = new InMemoryObjectStorage();
  const archive = await graph.archiveGraphBatch(pool, store, graph.BATTLE_GRAPH, battleIds, { bucket: BUCKET });
  assert.equal(archive.rowCountsByTable.normalized_battles, 2);
  assert.equal(archive.rowCountsByTable.battle_participants, 2);

  const verify = await graph.verifyGraphArchive(pool, store, "battle_graph", archive.archiveKey);
  assert.equal(verify.verified, true, "archive double-verifies");

  const reimport = await graph.reimportGraphArchive(pool, store, "battle_graph", archive.archiveKey);
  assert.equal(reimport.ok, true, "restore + replay + FK closure proof passed");
  for (const t of Object.values(reimport.perTable)) {
    assert.equal(t.rowCountMatch, true);
    assert.equal(t.contentChecksumMatch, true);
    assert.equal(t.fkClosure, true);
  }

  const del = await graph.deleteGraphBatch(pool, graph.BATTLE_GRAPH, archive.archiveKey, { allowlist: battleIds, dryRun: false });
  assert.equal(del.proceeded, true);
  assert.equal(del.deletedByTable.normalized_battles, 2);

  const [[left]] = await pool.query<RowDataPacket[]>(
    `SELECT (SELECT COUNT(*) FROM normalized_battles WHERE id IN (?, ?)) b,
            (SELECT COUNT(*) FROM battle_participants WHERE battle_id IN (?, ?)) p`,
    [battleIds[0], battleIds[1], battleIds[0], battleIds[1]]
  );
  assert.equal(Number(left.b), 0, "all battles deleted");
  assert.equal(Number(left.p), 0, "all participants deleted (FK-safe)");
  created.battleIds = []; // already gone
});
