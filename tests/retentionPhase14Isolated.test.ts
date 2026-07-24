/**
 * DATASET Phase 14 — COMPREHENSIVE isolated-DB validation.
 *
 * Seeds a self-contained fixture on a DISPOSABLE MySQL and drives every
 * archive-gated family + the maintenance paths through their full lifecycle,
 * proving the safety contract end-to-end against real MySQL. TRIPLE-gated so it
 * never runs by accident or against production:
 *   RETENTION_GRAPH_DB_TEST=1 + RETENTION_ENVIRONMENT=isolated_staging + DB creds.
 *
 * Run (against the disposable container only):
 *   DB_HOST=127.0.0.1 DB_PORT=13306 DB_NAME=brawlranks_test DB_USER=brawl_test \
 *   BRAWL_DB_SECRET_V1=... RETENTION_GRAPH_DB_TEST=1 \
 *   RETENTION_ENVIRONMENT=isolated_staging RETENTION_DESTRUCTIVE_ENABLED=true \
 *   npx tsx --test tests/retentionPhase14Isolated.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { InMemoryObjectStorage } from "@/lib/archive/provider";
import { gzipPayload } from "@/lib/archive/codec";

const enabled =
  process.env.RETENTION_GRAPH_DB_TEST === "1" &&
  process.env.RETENTION_ENVIRONMENT === "isolated_staging" &&
  Boolean(process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1);
const skipReason = "isolated-DB only: set RETENTION_GRAPH_DB_TEST=1 + RETENTION_ENVIRONMENT=isolated_staging + DB creds.";
const opt = { skip: enabled ? false : skipReason };

const BUCKET = "p14-it";
const ns = "p14it_" + Date.now().toString(36);
const uid = (): string => randomUUID();
const battles: string[] = [uid(), uid(), uid()];
const ids: Record<string, string> = {
  source: uid(), endpoint: uid(), wfDef: "", wfRun: uid(), fetchRun: uid(),
  brawler: uid(), player: uid(),
  rawSnap: uid(),
  obsUnpromotedOld: uid(), obsPromotedOld: uid(), obsHot: uid(), obsActiveCrawl: uid(),
  crawlBatchOld: uid(), crawlBatchActive: uid(),
  detChangeOld: uid(),
  incidentResolvedOld: uid(), incidentOpen: uid(),
  snapSuperseded: uid(), snapAccepted: uid(),
  nameHist: uid(),
  lockStale: uid(), lockActive: uid(), lockActiveOwner: "",
  envAttest: uid(),
};

async function q(pool: Pool, sql: string, params: unknown[] = []): Promise<void> { await pool.query(sql, params); }

before(async () => {
  if (!enabled) return;
  const { getPool } = await import("@/lib/mysql");
  const { ensureWorkflowDefinition } = await import("@/lib/workflow");
  const pool = getPool();

  await q(pool, "INSERT INTO data_sources (id, name, source_type) VALUES (?, ?, 'official_api')", [ids.source, `${ns}-src`]);
  await q(pool, "INSERT INTO source_endpoints (id, data_source_id, endpoint_category, path) VALUES (?, ?, 'battlelog', '/x')", [ids.endpoint, ids.source]);
  ids.wfDef = await ensureWorkflowDefinition(pool, `${ns}-wf`, "scheduled_sync");
  await q(pool, "INSERT INTO workflow_runs (id, workflow_definition_id, status, triggered_by, started_at) VALUES (?, ?, 'succeeded', 'manual', NOW(3) - INTERVAL 400 DAY)", [ids.wfRun, ids.wfDef]);
  await q(pool, "INSERT INTO data_fetch_runs (id, data_source_id, source_endpoint_id, workflow_run_id, trigger_type, status, started_at) VALUES (?, ?, ?, ?, 'manual', 'success', NOW(3) - INTERVAL 400 DAY)", [ids.fetchRun, ids.source, ids.endpoint, ids.wfRun]);
  await q(pool, "INSERT INTO canonical_brawlers (id, source_brawler_id, slug, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'X', NOW(3), NOW(3))", [ids.brawler, `${ns}-b`, `${ns}-b`]);
  await q(pool, "INSERT INTO normalized_players (id, player_tag, display_name, first_seen_at, last_seen_at) VALUES (?, ?, 'P', NOW(3), NOW(3))", [ids.player, `#${ns.slice(0, 8)}`]);

  // Battle graph (400d old).
  for (const bid of battles) {
    await q(pool, "INSERT INTO normalized_battles (id, battle_key, structure, occurred_at, first_observed_fetch_run_id) VALUES (?, ?, 'teams', NOW(3) - INTERVAL 400 DAY, ?)", [bid, `${bid}`.slice(0, 64), ids.fetchRun]);
    const teamId = randomUUID();
    await q(pool, "INSERT INTO battle_teams (id, battle_id, team_index, result) VALUES (?, ?, 0, 'victory')", [teamId, bid]);
    await q(pool, "INSERT INTO battle_participants (id, battle_id, battle_team_id, player_id, brawler_id, participant_index) VALUES (?, ?, ?, ?, ?, 0)", [randomUUID(), bid, teamId, ids.player, ids.brawler]);
    await q(pool, "INSERT INTO battle_observations (id, battle_id, data_fetch_run_id, observed_via_player_tag, observed_at) VALUES (?, ?, ?, '#IT', NOW(3) - INTERVAL 400 DAY)", [randomUUID(), bid, ids.fetchRun]);
  }

  // Raw payload lifecycle: a raw snapshot with a VERIFIED archive whose verified_at is 30 days old (past 7d grace).
  const payload = JSON.stringify({ hello: "world", ns });
  const gz = gzipPayload(payload);
  await q(pool, "INSERT INTO raw_api_snapshots (id, data_fetch_run_id, endpoint_category, payload, checksum, received_at) VALUES (?, ?, 'battlelog', ?, ?, NOW(3))", [ids.rawSnap, ids.fetchRun, payload, gz.originalChecksum]);
  await q(pool, "INSERT INTO raw_snapshot_archives (raw_snapshot_id, object_provider, object_bucket, object_key, compression, original_size_bytes, object_size_bytes, original_checksum, object_checksum, archive_status, verified_at, archived_at) VALUES (?, 'memory', ?, ?, 'gzip', ?, ?, ?, ?, 'verified', NOW(3) - INTERVAL 30 DAY, NOW(3) - INTERVAL 30 DAY)", [ids.rawSnap, BUCKET, `raw/${ids.rawSnap}.gz`, gz.originalSize, gz.objectSize, gz.originalChecksum, gz.objectChecksum]);

  // observed_players: unpromoted-old (90d), promoted-old (60d), hot (10d), active-crawl.
  await q(pool, "INSERT INTO observed_players (id, player_tag, source_type, promoted_to_active, first_observed_at) VALUES (?, ?, 'battle_participant', 0, NOW(3) - INTERVAL 90 DAY)", [ids.obsUnpromotedOld, `#${ns}u`]);
  await q(pool, "INSERT INTO observed_players (id, player_tag, source_type, promoted_to_active, promoted_at, first_observed_at) VALUES (?, ?, 'battle_participant', 1, NOW(3) - INTERVAL 60 DAY, NOW(3) - INTERVAL 120 DAY)", [ids.obsPromotedOld, `#${ns}p`]);
  await q(pool, "INSERT INTO observed_players (id, player_tag, source_type, promoted_to_active, first_observed_at) VALUES (?, ?, 'battle_participant', 0, NOW(3) - INTERVAL 10 DAY)", [ids.obsHot, `#${ns}h`]);
  await q(pool, "INSERT INTO observed_players (id, player_tag, source_type, promoted_to_active, first_observed_at) VALUES (?, ?, 'battle_participant', 0, NOW(3) - INTERVAL 90 DAY)", [ids.obsActiveCrawl, `#${ns}a`]);
  await q(pool, "INSERT INTO player_crawl_schedule (id, player_tag, next_due_at, is_active) VALUES (?, ?, NOW(3), 1)", [randomUUID(), `#${ns}a`]);

  // crawl_batches: completed 120d, and an active (not completed) one.
  await q(pool, "INSERT INTO crawl_batches (id, workflow_run_id, batch_type, requested_size, started_at, completed_at) VALUES (?, ?, 'battle_log', 10, NOW(3) - INTERVAL 120 DAY, NOW(3) - INTERVAL 120 DAY)", [ids.crawlBatchOld, ids.wfRun]);
  await q(pool, "INSERT INTO crawl_batches (id, workflow_run_id, batch_type, requested_size, started_at, completed_at) VALUES (?, ?, 'battle_log', 10, NOW(3) - INTERVAL 120 DAY, NULL)", [ids.crawlBatchActive, ids.wfRun]);

  // detected_changes: 400d old (12mo boundary).
  await q(pool, "INSERT INTO detected_changes (id, data_fetch_run_id, entity_type, entity_id, change_type, created_at) VALUES (?, ?, 'brawler', 'x', 'stat_change', NOW(3) - INTERVAL 400 DAY)", [ids.detChangeOld, ids.fetchRun]);

  // data_incidents: resolved 400d ago; and an open one referencing the same fetch run.
  await q(pool, "INSERT INTO data_incidents (id, incident_type, related_fetch_run_id, status, resolved_at, created_at) VALUES (?, 'invalid_value', ?, 'resolved', NOW(3) - INTERVAL 400 DAY, NOW(3) - INTERVAL 410 DAY)", [ids.incidentResolvedOld, ids.fetchRun]);
  await q(pool, "INSERT INTO data_incidents (id, incident_type, related_fetch_run_id, status, created_at) VALUES (?, 'invalid_value', ?, 'open', NOW(3) - INTERVAL 400 DAY)", [ids.incidentOpen, ids.fetchRun]);

  // normalized_snapshots: superseded 400d, and an accepted current one.
  await q(pool, "INSERT INTO normalized_snapshots (id, data_fetch_run_id, entity_type, entity_id, normalized_payload, payload_checksum, is_accepted, created_at) VALUES (?, ?, 'brawler', 'sup', '{}', REPEAT('a',64), 0, NOW(3) - INTERVAL 400 DAY)", [ids.snapSuperseded, ids.fetchRun]);
  await q(pool, "INSERT INTO normalized_snapshots (id, data_fetch_run_id, entity_type, entity_id, normalized_payload, payload_checksum, is_accepted, created_at) VALUES (?, ?, 'brawler', 'acc', '{}', REPEAT('b',64), 1, NOW(3) - INTERVAL 400 DAY)", [ids.snapAccepted, ids.fetchRun]);

  // player_name_history: 400d old.
  await q(pool, "INSERT INTO player_name_history (id, player_id, previous_name, recorded_at) VALUES (?, ?, 'OldName', NOW(3) - INTERVAL 400 DAY)", [ids.nameHist, ids.player]);

  // workflow_locks: stale (expired, owner terminal) on wfDef; active (owner
  // running) on a SEPARATE definition (uniq_workflow_locks_active is one active
  // lock per definition).
  const runningWf = randomUUID();
  const wfDef2 = await ensureWorkflowDefinition(pool, `${ns}-wf2`, "scheduled_sync");
  await q(pool, "INSERT INTO workflow_runs (id, workflow_definition_id, status, triggered_by, started_at) VALUES (?, ?, 'running', 'manual', NOW(3))", [runningWf, wfDef2]);
  await q(pool, "INSERT INTO workflow_locks (id, workflow_definition_id, locked_by_run_id, locked_at, expires_at) VALUES (?, ?, ?, NOW(3) - INTERVAL 1 HOUR, NOW(3) - INTERVAL 30 MINUTE)", [ids.lockStale, ids.wfDef, ids.wfRun]);
  await q(pool, "INSERT INTO workflow_locks (id, workflow_definition_id, locked_by_run_id, locked_at, expires_at) VALUES (?, ?, ?, NOW(3), NOW(3) + INTERVAL 1 HOUR)", [ids.lockActive, wfDef2, runningWf]);
  ids.lockActiveOwner = runningWf;

  // Isolated-staging attestation.
  await q(pool, "INSERT INTO retention_environment_attestations (environment_id, purpose, confirmed_by, evidence_reference, expires_at) VALUES (?, 'isolated_staging', 'p14it', 'test', NOW(3) + INTERVAL 1 HOUR)", [ids.envAttest]);
});

after(async () => {
  if (!enabled) return;
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();
  const swallow = (p: Promise<unknown>) => p.catch(() => {});
  for (const bid of battles) {
    await swallow(q(pool, "DELETE FROM battle_participants WHERE battle_id=?", [bid]));
    await swallow(q(pool, "DELETE FROM battle_teams WHERE battle_id=?", [bid]));
    await swallow(q(pool, "DELETE FROM battle_observations WHERE battle_id=?", [bid]));
    await swallow(q(pool, "DELETE FROM normalized_battles WHERE id=?", [bid]));
  }
  await swallow(q(pool, "DELETE FROM raw_snapshot_archives WHERE raw_snapshot_id=?", [ids.rawSnap]));
  await swallow(q(pool, "DELETE FROM raw_api_snapshots WHERE id=?", [ids.rawSnap]));
  await swallow(q(pool, "DELETE FROM observed_players WHERE id IN (?,?,?,?)", [ids.obsUnpromotedOld, ids.obsPromotedOld, ids.obsHot, ids.obsActiveCrawl]));
  await swallow(q(pool, "DELETE FROM player_crawl_schedule WHERE player_tag=?", [`#${ns}a`]));
  await swallow(q(pool, "DELETE FROM crawl_batches WHERE id IN (?,?)", [ids.crawlBatchOld, ids.crawlBatchActive]));
  await swallow(q(pool, "DELETE FROM detected_changes WHERE id=?", [ids.detChangeOld]));
  await swallow(q(pool, "DELETE FROM data_incidents WHERE id IN (?,?)", [ids.incidentResolvedOld, ids.incidentOpen]));
  await swallow(q(pool, "DELETE FROM normalized_snapshots WHERE id IN (?,?)", [ids.snapSuperseded, ids.snapAccepted]));
  await swallow(q(pool, "DELETE FROM player_name_history WHERE id=?", [ids.nameHist]));
  await swallow(q(pool, "DELETE FROM workflow_locks WHERE id IN (?,?)", [ids.lockStale, ids.lockActive]));
  await swallow(q(pool, "DELETE FROM data_fetch_runs WHERE id=?", [ids.fetchRun]));
  await swallow(q(pool, "DELETE FROM workflow_runs WHERE id IN (?,?)", [ids.wfRun, ids.lockActiveOwner]));
  await swallow(q(pool, "DELETE FROM battle_participants WHERE player_id=?", [ids.player]));
  await swallow(q(pool, "DELETE FROM normalized_players WHERE id=?", [ids.player]));
  await swallow(q(pool, "DELETE FROM canonical_brawlers WHERE id=?", [ids.brawler]));
  await swallow(q(pool, "DELETE FROM source_endpoints WHERE id=?", [ids.endpoint]));
  await swallow(q(pool, "DELETE FROM data_sources WHERE id=?", [ids.source]));
  await swallow(q(pool, "DELETE FROM retention_environment_attestations WHERE environment_id=?", [ids.envAttest]));
  await swallow(q(pool, "DELETE FROM workflow_definitions WHERE slug IN (?, ?)", [`${ns}-wf`, `${ns}-wf2`]));
  // Close the shared pool LAST so the process can exit (cleanup queries needed it).
  await pool.end().catch(() => {});
  (globalThis as Record<string, unknown>).__brawlranksMysqlPool = undefined;
});

test("battle_graph: full archive -> verify -> reimport(restore/replay/FK) -> gated FK-safe delete + idempotency", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const g = await import("@/lib/retention/graph");
  const pool = getPool();
  const store = new InMemoryObjectStorage();

  const plan = await g.planFamily(pool, g.BATTLE_GRAPH, {});
  const mine = plan.candidates.filter((c) => battles.includes(c.anchorId)).map((c) => c.anchorId).sort();
  assert.equal(mine.length, 3, "all 3 seeded battles are eligible at 365d");

  // dry-run delete BEFORE any archive -> no manifest, blocked.
  const before = await countTable(pool, "normalized_battles", battles);
  assert.equal(before, 3);

  const archive = await g.archiveGraphBatch(pool, store, g.BATTLE_GRAPH, mine, { bucket: BUCKET });
  assert.equal(archive.rowCountsByTable.normalized_battles, 3);
  assert.equal(archive.rowCountsByTable.battle_participants, 3);
  assert.equal(archive.rowCountsByTable.battle_teams, 3);
  assert.equal(archive.rowCountsByTable.battle_observations, 3);
  assert.match(archive.originalSha256, /^[0-9a-f]{64}$/);
  assert.ok(archive.archiveBytes > 0 && archive.uncompressedBytes > 0);

  // Delete blocked before verification.
  const blockedPreVerify = await g.deleteGraphBatch(pool, g.BATTLE_GRAPH, archive.archiveKey, { allowlist: mine, dryRun: false });
  assert.equal(blockedPreVerify.blockedReason, "not_verified");
  assert.equal(await countTable(pool, "normalized_battles", battles), 3, "nothing deleted pre-verify");

  const verify = await g.verifyGraphArchive(pool, store, "battle_graph", archive.archiveKey);
  assert.equal(verify.verified, true);

  // Still blocked until reimport proof passes.
  const blockedPreReimport = await g.deleteGraphBatch(pool, g.BATTLE_GRAPH, archive.archiveKey, { allowlist: mine, dryRun: false });
  assert.equal(blockedPreReimport.blockedReason, "reimport_not_passed");

  const reimport = await g.reimportGraphArchive(pool, store, "battle_graph", archive.archiveKey);
  assert.equal(reimport.ok, true, "restore + replay + FK closure proof passed");
  for (const t of Object.values(reimport.perTable)) {
    assert.equal(t.rowCountMatch, true);
    assert.equal(t.contentChecksumMatch, true);
    assert.equal(t.fkClosure, true);
  }

  // dry-run delete: zero mutation even when fully gated.
  const dry = await g.deleteGraphBatch(pool, g.BATTLE_GRAPH, archive.archiveKey, { allowlist: mine, dryRun: true });
  assert.equal(dry.proceeded, true);
  assert.equal(await countTable(pool, "normalized_battles", battles), 3, "dry-run deleted nothing");

  // real delete: FK-safe, bounded.
  const del = await g.deleteGraphBatch(pool, g.BATTLE_GRAPH, archive.archiveKey, { allowlist: mine, dryRun: false, deleteBatchSize: 2 });
  assert.equal(del.proceeded, true);
  assert.equal(del.deletedByTable.normalized_battles, 3);
  assert.equal(await countTable(pool, "normalized_battles", battles), 0);
  assert.equal(await countTable(pool, "battle_participants", battles, "battle_id"), 0);

  // idempotent rerun: anchors gone -> eligibility_changed, no crash.
  const rerun = await g.deleteGraphBatch(pool, g.BATTLE_GRAPH, archive.archiveKey, { allowlist: mine, dryRun: false });
  assert.equal(rerun.blockedReason, "eligibility_changed");
});

test("new families: boundary eligibility (observed 60/30, crawl 90, detected 12mo, incidents resolved 12mo, snapshots superseded 12mo)", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const g = await import("@/lib/retention/graph");
  const pool = getPool();

  const op = await g.planFamily(pool, g.OBSERVED_PLAYERS, {});
  const opEligible = new Set(op.candidates.map((c) => c.anchorId));
  assert.ok(opEligible.has(ids.obsUnpromotedOld), "unpromoted >60d eligible");
  assert.ok(opEligible.has(ids.obsPromotedOld), "promoted >30d eligible");
  assert.equal(opEligible.has(ids.obsHot), false);
  assert.equal(opEligible.has(ids.obsActiveCrawl), false, "active crawl dependency preserved");

  const cb = await g.planFamily(pool, g.CRAWL_BATCHES, {});
  const cbEligible = new Set(cb.candidates.map((c) => c.anchorId));
  assert.ok(cbEligible.has(ids.crawlBatchOld));
  assert.equal(cbEligible.has(ids.crawlBatchActive), false, "active (uncompleted) batch preserved");

  const dc = await g.planFamily(pool, g.DETECTED_CHANGES, {});
  // Our detected_change shares a fetch run with an OPEN incident -> skipped.
  assert.equal(dc.candidates.some((c) => c.anchorId === ids.detChangeOld), false, "open incident dependency blocks");

  const di = await g.planFamily(pool, g.DATA_INCIDENTS, {});
  const diEligible = new Set(di.candidates.map((c) => c.anchorId));
  assert.ok(diEligible.has(ids.incidentResolvedOld), "resolved >12mo eligible");
  assert.equal(diEligible.has(ids.incidentOpen), false, "unresolved kept forever");

  const sn = await g.planFamily(pool, g.NORMALIZED_SNAPSHOTS, {});
  const snEligible = new Set(sn.candidates.map((c) => c.anchorId));
  assert.ok(snEligible.has(ids.snapSuperseded), "superseded >12mo eligible");
  assert.equal(snEligible.has(ids.snapAccepted), false, "accepted/current never eligible");
});

test("player_name_history is archive-only (delete refused, boundaries preserved)", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const g = await import("@/lib/retention/graph");
  const pool = getPool();
  const store = new InMemoryObjectStorage();
  const plan = await g.planFamily(pool, g.PLAYER_NAME_HISTORY, {});
  const mine = plan.candidates.filter((c) => c.anchorId === ids.nameHist).map((c) => c.anchorId);
  assert.equal(mine.length, 1, "old name-history row is archivable");
  const archive = await g.archiveGraphBatch(pool, store, g.PLAYER_NAME_HISTORY, mine, { bucket: BUCKET });
  await g.verifyGraphArchive(pool, store, "player_name_history", archive.archiveKey);
  const del = await g.deleteGraphBatch(pool, g.PLAYER_NAME_HISTORY, archive.archiveKey, { allowlist: mine, dryRun: false });
  assert.equal(del.blockedReason, "archive_only_no_deletion");
  const [[still]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) n FROM player_name_history WHERE id=?", [ids.nameHist]);
  assert.equal(Number(still.n), 1, "name-history boundary preserved");
});

test("raw payload: dry-run no-op, then verified+grace archive allows payload NULL (metadata preserved)", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runRawPayloadSweep } = await import("@/lib/retention/rawPayload");
  const pool = getPool();
  const store = new InMemoryObjectStorage();
  // Put the archived object where the sweep's re-verify will find it.
  const payload = JSON.stringify({ hello: "world", ns });
  const gz = gzipPayload(payload);
  await store.putObject({ bucket: BUCKET, key: `raw/${ids.rawSnap}.gz`, body: gz.compressed });

  const dry = await runRawPayloadSweep(pool, store, { env: {} });
  assert.equal(dry.dryRun, true);
  const [[beforeRow]] = await pool.query<RowDataPacket[]>("SELECT payload IS NOT NULL AS hasPayload FROM raw_api_snapshots WHERE id=?", [ids.rawSnap]);
  assert.equal(Number(beforeRow.hasPayload), 1, "dry-run kept payload");

  const real = await runRawPayloadSweep(pool, store, { destructiveEnabled: true, scanLimit: 5000 });
  assert.ok(real.removed >= 1, "at least our seeded snapshot's payload was nulled");
  const [[afterRow]] = await pool.query<RowDataPacket[]>("SELECT payload IS NULL AS nulled, id FROM raw_api_snapshots WHERE id=?", [ids.rawSnap]);
  assert.equal(Number(afterRow.nulled), 1, "payload nulled");
  assert.equal(afterRow.id, ids.rawSnap, "metadata row preserved");
});

test("workflow_locks GC: removes expired+terminal, preserves active-owner lock", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { cleanupExpiredWorkflowLocks } = await import("@/lib/retention/maintenance");
  const pool = getPool();
  const dry = await cleanupExpiredWorkflowLocks(pool, { dryRun: true });
  assert.ok(dry.candidates >= 1, "the stale lock is a candidate");
  const real = await cleanupExpiredWorkflowLocks(pool, { dryRun: false, env: { RETENTION_DESTRUCTIVE_ENABLED: "true", RETENTION_ENVIRONMENT: "isolated_staging" } });
  assert.ok(real.deleted >= 1);
  const [[stale]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) n FROM workflow_locks WHERE id=?", [ids.lockStale]);
  const [[active]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) n FROM workflow_locks WHERE id=?", [ids.lockActive]);
  assert.equal(Number(stale.n), 0, "stale lock removed");
  assert.equal(Number(active.n), 1, "active-owner lock preserved");
});

test("normalized_players safeguard: a reachable, participant-referenced player is never deletable", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { assessNormalizedPlayerDeletion } = await import("@/lib/retention/maintenance");
  const pool = getPool();
  // Seed a dedicated referenced player so this proof does not depend on the
  // battle_graph test's deletions (which remove the shared participant first).
  const pid = randomUUID();
  await q(pool, "INSERT INTO normalized_players (id, player_tag, display_name, first_seen_at, last_seen_at) VALUES (?, ?, 'SG', NOW(3), NOW(3))", [pid, `#${ns}sg`]);
  const bid = randomUUID();
  await q(pool, "INSERT INTO normalized_battles (id, battle_key, structure, occurred_at, first_observed_fetch_run_id) VALUES (?, ?, 'teams', NOW(3), ?)", [bid, `sg-${bid}`.slice(0, 64), ids.fetchRun]);
  const tid = randomUUID();
  await q(pool, "INSERT INTO battle_teams (id, battle_id, team_index, result) VALUES (?, ?, 0, 'victory')", [tid, bid]);
  await q(pool, "INSERT INTO battle_participants (id, battle_id, battle_team_id, player_id, brawler_id, participant_index) VALUES (?, ?, ?, ?, ?, 0)", [randomUUID(), bid, tid, pid, ids.brawler]);
  try {
    const res = await assessNormalizedPlayerDeletion(pool, pid);
    assert.equal(res.deletable, false);
    assert.ok(res.blockReasons.includes("active_or_reachable"), "a reachable player is never deletable");
    assert.ok(res.blockReasons.includes("participant_referenced"), "a participant-referenced player is never deletable");
    assert.ok(res.blockReasons.includes("no_approved_merge_evidence"), "routine deletion is never authorized");
  } finally {
    await q(pool, "DELETE FROM battle_participants WHERE battle_id=?", [bid]);
    await q(pool, "DELETE FROM battle_teams WHERE battle_id=?", [bid]);
    await q(pool, "DELETE FROM normalized_battles WHERE id=?", [bid]);
    await q(pool, "DELETE FROM normalized_players WHERE id=?", [pid]);
  }
});

test("production guard: destructive graph retention refused unless flag + isolated env", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const g = await import("@/lib/retention/graph");
  const pool = getPool();
  await assert.rejects(
    () => g.runGraphRetention(pool, new InMemoryObjectStorage(), { family: "battle_graph", action: "delete", allowlist: [randomUUID()], env: { RETENTION_DESTRUCTIVE_ENABLED: "true", RETENTION_ENVIRONMENT: "production" } }),
    /production_guard_block/
  );
});

async function countTable(pool: Pool, table: string, anchorIds: string[], col = "id"): Promise<number> {
  const ph = anchorIds.map(() => "?").join(",");
  const [[r]] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) n FROM \`${table}\` WHERE \`${col}\` IN (${ph})`, anchorIds);
  return Number(r.n);
}
