/**
 * DATASET Phase 14 — archive-gated graph lifecycle (battle graph + workflow /
 * fetch audit families). DB-free unit tests: a stateful fake pool models the
 * source rows + manifests and mutates on DELETE/UPDATE, and an
 * InMemoryObjectStorage holds real gzip'd archive objects so archive -> verify
 * runs for real. Proves the exact safety contract WITHOUT MySQL (the staging
 * re-import proof, which needs real TEMPORARY TABLEs, is exercised by the
 * skipped DB-integration suite).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { InMemoryObjectStorage } from "@/lib/archive/provider";
import {
  BATTLE_GRAPH, WORKFLOW_AUDIT, FETCH_AUDIT,
  planFamily, archiveGraphBatch, verifyGraphArchive, deleteGraphBatch,
  computeArchiveKey, assertDestructiveAllowed,
} from "@/lib/retention/graph";

const BUCKET = "graph-bucket";
const DAY = 86_400_000;

// A tiny relational fixture: a set of battles, each with participants/teams/observations.
interface Battle { id: string; battle_key: string; occurred_at: Date; first_observed_fetch_run_id: string }
interface Child { id: string; battle_id: string; [k: string]: unknown }

interface GraphState {
  battles: Battle[];
  participants: Child[];
  teams: Child[];
  observations: Child[];
  manifests: RowDataPacket[];
  evidence: { manifest_id: string; pass_number: number; result: string }[];
  deletions: Record<string, unknown>[];
  lockHeld: boolean;
}

function u(): string { return randomUUID(); }

function seedBattles(n: number, ageDays: number): GraphState {
  const st: GraphState = { battles: [], participants: [], teams: [], observations: [], manifests: [], evidence: [], deletions: [], lockHeld: false };
  for (let i = 0; i < n; i++) {
    const id = u();
    st.battles.push({ id, battle_key: `bk-${i}-${id.slice(0, 8)}`, occurred_at: new Date(Date.now() - ageDays * DAY), first_observed_fetch_run_id: u() });
    const team = { id: u(), battle_id: id, team_index: 0, result: "victory", rank: null, created_at: new Date() };
    st.teams.push(team);
    st.participants.push({ id: u(), battle_id: id, battle_team_id: team.id, player_id: u(), brawler_id: u(), participant_index: 0, is_star_player: 0, created_at: new Date() });
    st.observations.push({ id: u(), battle_id: id, data_fetch_run_id: u(), observed_via_player_tag: "#ABC", observed_at: new Date() });
  }
  // deterministic id order
  st.battles.sort((a, b) => a.id.localeCompare(b.id));
  return st;
}

const COLUMNS: Record<string, { Field: string; Type: string; Null: string }[]> = {
  normalized_battles: ["id", "battle_key", "occurred_at", "first_observed_fetch_run_id"].map((f) => ({ Field: f, Type: f.includes("at") ? "datetime(3)" : "char(36)", Null: "NO" })),
  battle_participants: ["id", "battle_id", "battle_team_id", "player_id", "brawler_id", "participant_index", "is_star_player", "created_at"].map((f) => ({ Field: f, Type: "char(36)", Null: f === "battle_team_id" ? "YES" : "NO" })),
  battle_teams: ["id", "battle_id", "team_index", "result", "rank", "created_at"].map((f) => ({ Field: f, Type: "char(36)", Null: f === "rank" ? "YES" : "NO" })),
  battle_observations: ["id", "battle_id", "data_fetch_run_id", "observed_via_player_tag", "observed_at"].map((f) => ({ Field: f, Type: "char(36)", Null: "NO" })),
};

function makeGraphPool(st: GraphState): Pool {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const tableFor = (t: string): Child[] | Battle[] =>
    t === "normalized_battles" ? st.battles : t === "battle_participants" ? st.participants : t === "battle_teams" ? st.teams : st.observations;

  const handle = async (sqlRaw: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    const sql = norm(sqlRaw);

    if (/^INSERT INTO workflow_definitions/i.test(sql)) return [{ affectedRows: 1 }, []];
    if (/^SELECT id FROM workflow_definitions/i.test(sql)) return [[{ id: "def-1" }], []];
    if (/^UPDATE workflow_locks SET released_at/i.test(sql) && /expires_at < /i.test(sql)) return [{ affectedRows: 0 }, []];
    if (/^INSERT INTO workflow_locks/i.test(sql)) {
      if (st.lockHeld) { const e = new Error("dup") as Error & { code?: string }; e.code = "ER_DUP_ENTRY"; throw e; }
      return [{ affectedRows: 1 }, []];
    }
    if (/^UPDATE workflow_locks SET released_at/i.test(sql)) return [{ affectedRows: 1 }, []];

    if (/^SHOW COLUMNS FROM/i.test(sql)) {
      const t = sql.match(/SHOW COLUMNS FROM `(\w+)`/i)![1];
      return [COLUMNS[t], []];
    }

    // battle_graph plan
    if (/FROM normalized_battles WHERE occurred_at < \?/i.test(sql)) {
      const cutoff = new Date(params[0] as Date).getTime();
      const rows = st.battles.filter((b) => b.occurred_at.getTime() < cutoff).slice(0, Number(params[1]))
        .map((b) => ({ anchorId: b.id, battleKey: b.battle_key, ts: b.occurred_at }));
      return [rows, []];
    }
    // anchor rows
    if (/^SELECT \* FROM `normalized_battles` WHERE id IN/i.test(sql)) {
      const ids = params as string[];
      return [st.battles.filter((b) => ids.includes(b.id)).sort((a, b) => a.id.localeCompare(b.id)), []];
    }
    // child rows for archive (paged)
    const childSel = sql.match(/^SELECT \* FROM `(battle_participants|battle_teams|battle_observations)` WHERE `battle_id` IN \(([^)]*)\) AND id > \? ORDER BY id ASC LIMIT/i);
    if (childSel) {
      const table = childSel[1];
      const nIn = childSel[2].split(",").length;
      const anchorIds = params.slice(0, nIn) as string[];
      const after = params[nIn] as string;
      const rows = (tableFor(table) as Child[]).filter((r) => anchorIds.includes(r.battle_id) && r.id > after).sort((a, b) => a.id.localeCompare(b.id));
      return [rows, []];
    }
    // scoped delete select
    const delSel = sql.match(/^SELECT id FROM `(\w+)` WHERE `(\w+)` IN \(([^)]*)\) AND id > \? ORDER BY id ASC LIMIT/i);
    if (delSel) {
      const table = delSel[1]; const fk = delSel[2];
      const nIn = delSel[3].split(",").length;
      const anchorIds = params.slice(0, nIn) as string[];
      const after = params[nIn] as string;
      const limit = Number(params[nIn + 1]);
      const rows = (tableFor(table) as (Child | Battle)[])
        .filter((r) => anchorIds.includes(fk === "id" ? (r as Battle).id : (r as Child)[fk] as string) && r.id > after)
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit).map((r) => ({ id: r.id }));
      return [rows, []];
    }
    if (/^DELETE FROM `(\w+)` WHERE id IN/i.test(sql)) {
      const table = sql.match(/DELETE FROM `(\w+)`/i)![1];
      const ids = params as string[];
      const arr = tableFor(table) as { id: string }[];
      let removed = 0;
      for (let i = arr.length - 1; i >= 0; i--) if (ids.includes(arr[i].id)) { arr.splice(i, 1); removed++; }
      return [{ affectedRows: removed } as ResultSetHeader, []];
    }

    // manifests
    if (/^INSERT INTO retention_graph_manifests/i.test(sql)) {
      const [id, family, archive_key, , , anchor_table, anchor_count, row_counts, natural_keys, source_refs, , , uncompressed_bytes, archive_bytes, original_sha256, archive_sha256, object_provider, object_bucket, object_key] = params as unknown[];
      st.manifests.push({ id, family, archive_key, anchor_table, anchor_count, row_counts, natural_keys, source_refs, uncompressed_bytes, archive_bytes, original_sha256, archive_sha256, object_provider, object_bucket, object_key, verification_status: "pending", verification_count: 0, staging_reimport_status: "pending", verification_results: null, staging_reimport_result: null } as unknown as RowDataPacket);
      return [{ affectedRows: 1 }, []];
    }
    if (/FROM retention_graph_manifests WHERE family = \? AND archive_key = \?/i.test(sql)) {
      const m = st.manifests.find((x) => x.family === params[0] && x.archive_key === params[1]);
      return [m ? [m] : [], []];
    }
    if (/^UPDATE retention_graph_manifests SET verification_status/i.test(sql)) {
      const m = st.manifests.find((x) => x.id === params[params.length - 1]);
      if (m) { m.verification_status = params[0]; m.verification_count = params[1]; }
      return [{ affectedRows: 1 }, []];
    }
    if (/^UPDATE retention_graph_manifests SET staging_reimport_status/i.test(sql)) {
      const m = st.manifests.find((x) => x.id === params[2]);
      if (m) m.staging_reimport_status = params[0];
      return [{ affectedRows: 1 }, []];
    }
    if (/^INSERT INTO retention_graph_verification_evidence/i.test(sql)) {
      st.evidence.push({ manifest_id: params[1] as string, pass_number: params[2] as number, result: params[7] as string });
      return [{ affectedRows: 1 }, []];
    }
    if (/COUNT\(DISTINCT pass_number\) n FROM retention_graph_verification_evidence/i.test(sql)) {
      const passed = new Set(st.evidence.filter((e) => e.manifest_id === params[0] && e.result === "passed").map((e) => e.pass_number));
      return [[{ n: passed.size }], []];
    }
    if (/^INSERT INTO retention_graph_deletion_manifests/i.test(sql)) {
      st.deletions.push({ family: params[1], table_name: params[3], status: params[11] });
      return [{ affectedRows: 1 }, []];
    }

    if (/^SELECT/i.test(sql)) return [[], []];
    return [{ affectedRows: 1 }, []];
  };

  const conn = {
    query: (s: string, p?: unknown[]) => handle(s, p),
    execute: (s: string, p?: unknown[]) => handle(s, p),
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
  } as unknown as PoolConnection;
  return {
    query: (s: string, p?: unknown[]) => handle(s, p),
    execute: (s: string, p?: unknown[]) => handle(s, p),
    getConnection: async () => conn,
  } as unknown as Pool;
}

async function archiveAndVerify(st: GraphState, store: InMemoryObjectStorage, ids: string[]) {
  const pool = makeGraphPool(st);
  const archive = await archiveGraphBatch(pool, store, BATTLE_GRAPH, ids, { bucket: BUCKET });
  const verify = await verifyGraphArchive(pool, store, "battle_graph", archive.archiveKey);
  return { pool, archive, verify };
}

// ---------------------------------------------------------------------------

test("plan: battle_graph selects battles past 365 days, none within", async () => {
  const st = seedBattles(3, 400);
  st.battles[0].occurred_at = new Date(Date.now() - 10 * DAY); // one hot battle
  const pool = makeGraphPool(st);
  const plan = await planFamily(pool, BATTLE_GRAPH, {});
  assert.equal(plan.candidates.length, 2, "only battles older than 365 days are eligible");
  assert.equal(plan.totals.eligible, 2);
});

test("archive: the complete graph is archived with exact parent/child counts, checksums, natural keys, and source refs", async () => {
  const st = seedBattles(2, 400);
  const store = new InMemoryObjectStorage();
  const ids = st.battles.map((b) => b.id);
  const { archive } = await archiveAndVerify(st, store, ids);

  assert.equal(archive.rowCountsByTable.normalized_battles, 2);
  assert.equal(archive.rowCountsByTable.battle_participants, 2);
  assert.equal(archive.rowCountsByTable.battle_teams, 2);
  assert.equal(archive.rowCountsByTable.battle_observations, 2);
  assert.match(archive.originalSha256, /^[0-9a-f]{64}$/);
  assert.match(archive.archiveSha256, /^[0-9a-f]{64}$/);
  assert.equal(store.size(), 1, "exactly one archive object written");
});

test("verify: a healthy archive double-verifies (2 passes) and the manifest becomes verified", async () => {
  const st = seedBattles(2, 400);
  const store = new InMemoryObjectStorage();
  const { verify, archive } = await archiveAndVerify(st, store, st.battles.map((b) => b.id));
  assert.equal(verify.verified, true);
  assert.equal(verify.passes.length, 2);
  assert.equal(st.manifests[0].verification_status, "verified");
  assert.equal(archive.idempotent, false);
});

test("verify: a corrupted object fails verification (checksum mismatch) and blocks the verified status", async () => {
  const st = seedBattles(2, 400);
  const store = new InMemoryObjectStorage();
  const { archive } = await archiveAndVerify(st, store, st.battles.map((b) => b.id));
  // Corrupt the stored object.
  store.corrupt(BUCKET, archive.objectKey, Buffer.from("tampered"));
  const pool = makeGraphPool(st);
  const verify = await verifyGraphArchive(pool, store, "battle_graph", archive.archiveKey);
  assert.equal(verify.verified, false);
  assert.equal(st.manifests[0].verification_status, "failed");
});

test("archive: re-archiving the same anchor set is idempotent (same key, one object)", async () => {
  const st = seedBattles(2, 400);
  const store = new InMemoryObjectStorage();
  const ids = st.battles.map((b) => b.id);
  const pool = makeGraphPool(st);
  const a1 = await archiveGraphBatch(pool, store, BATTLE_GRAPH, ids, { bucket: BUCKET });
  const a2 = await archiveGraphBatch(pool, store, BATTLE_GRAPH, ids, { bucket: BUCKET });
  assert.equal(a2.idempotent, true);
  assert.equal(a1.archiveKey, a2.archiveKey);
  assert.equal(store.size(), 1);
});

test("delete: blocked until verified AND reimport passed; then deletes FK-safe with the exact allowlist", async () => {
  const st = seedBattles(2, 400);
  const store = new InMemoryObjectStorage();
  const ids = st.battles.map((b) => b.id);
  const { pool, archive } = await archiveAndVerify(st, store, ids);

  // Verified but reimport still pending -> blocked.
  const blocked = await deleteGraphBatch(pool, BATTLE_GRAPH, archive.archiveKey, { allowlist: ids, dryRun: false });
  assert.equal(blocked.proceeded, false);
  assert.equal(blocked.blockedReason, "reimport_not_passed");
  assert.equal(st.battles.length, 2, "nothing deleted while blocked");

  // Mark reimport passed (the DB-integration suite proves the real restore/replay).
  st.manifests[0].staging_reimport_status = "passed";

  const ok = await deleteGraphBatch(pool, BATTLE_GRAPH, archive.archiveKey, { allowlist: ids, dryRun: false });
  assert.equal(ok.proceeded, true);
  assert.equal(ok.deletedByTable.battle_participants, 2);
  assert.equal(ok.deletedByTable.battle_teams, 2);
  assert.equal(ok.deletedByTable.battle_observations, 2);
  assert.equal(ok.deletedByTable.normalized_battles, 2);
  assert.equal(st.battles.length, 0);
  assert.equal(st.participants.length, 0);
  assert.equal(st.teams.length, 0);
  assert.equal(st.observations.length, 0);
  // FK-safe order recorded: participants before teams before battles.
  const order = st.deletions.map((d) => d.table_name);
  assert.ok(order.indexOf("battle_participants") < order.indexOf("battle_teams"));
  assert.ok(order.indexOf("battle_teams") < order.indexOf("normalized_battles"));
});

test("delete: dry-run performs zero mutation even when fully gated", async () => {
  const st = seedBattles(2, 400);
  const store = new InMemoryObjectStorage();
  const ids = st.battles.map((b) => b.id);
  const { pool, archive } = await archiveAndVerify(st, store, ids);
  st.manifests[0].staging_reimport_status = "passed";

  const dry = await deleteGraphBatch(pool, BATTLE_GRAPH, archive.archiveKey, { allowlist: ids, dryRun: true });
  assert.equal(dry.proceeded, true);
  assert.equal(Object.keys(dry.deletedByTable).length, 0);
  assert.equal(st.battles.length, 2, "dry-run deletes nothing");
});

test("delete: an allowlist that does not equal the archived anchor set is rejected", async () => {
  const st = seedBattles(2, 400);
  const store = new InMemoryObjectStorage();
  const ids = st.battles.map((b) => b.id);
  const { pool, archive } = await archiveAndVerify(st, store, ids);
  st.manifests[0].staging_reimport_status = "passed";

  // Drop one id from the allowlist -> archive_key no longer matches.
  const wrong = await deleteGraphBatch(pool, BATTLE_GRAPH, archive.archiveKey, { allowlist: [ids[0]], dryRun: false });
  assert.equal(wrong.blockedReason, "allowlist_mismatch");
  assert.equal(st.battles.length, 2);
});

test("delete: batch limits are respected across tables", async () => {
  const st = seedBattles(5, 400);
  const store = new InMemoryObjectStorage();
  const ids = st.battles.map((b) => b.id);
  const { pool, archive } = await archiveAndVerify(st, store, ids);
  st.manifests[0].staging_reimport_status = "passed";
  const res = await deleteGraphBatch(pool, BATTLE_GRAPH, archive.archiveKey, { allowlist: ids, dryRun: false, deleteBatchSize: 2 });
  assert.equal(res.deletedByTable.normalized_battles, 5);
  assert.ok(res.batches >= 3, "5 rows / 2-per-batch took multiple batches per table");
  assert.equal(st.battles.length, 0);
});

// --- workflow_audit / fetch_audit eligibility ------------------------------

function makeWorkflowPool(rows: RowDataPacket[]): Pool {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const handle = async (sqlRaw: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    const sql = norm(sqlRaw);
    if (/FROM workflow_runs wr WHERE wr.started_at < \?/i.test(sql)) {
      const cutoff = new Date(params[0] as Date).getTime();
      return [rows.filter((r) => new Date(r.ts).getTime() < cutoff).slice(0, Number(params[1])), []];
    }
    if (/^SELECT/i.test(sql)) return [[], []];
    return [{ affectedRows: 1 }, []];
  };
  return { query: (s: string, p?: unknown[]) => handle(s, p), execute: (s: string, p?: unknown[]) => handle(s, p), getConnection: async () => ({}) as PoolConnection } as unknown as Pool;
}

test("workflow_audit: standard runs past 365d are eligible; failed/held within 24 months are retained", async () => {
  const now = new Date();
  const rows = [
    { anchorId: "wr-std-old", status: "succeeded", ts: new Date(now.getTime() - 400 * DAY), refFetch: 0, refLock: 0 },
    { anchorId: "wr-failed-recent", status: "failed", ts: new Date(now.getTime() - 400 * DAY), refFetch: 0, refLock: 0 },
    { anchorId: "wr-failed-old", status: "failed", ts: new Date(now.getTime() - 800 * DAY), refFetch: 0, refLock: 0 },
    { anchorId: "wr-active", status: "running", ts: new Date(now.getTime() - 400 * DAY), refFetch: 0, refLock: 0 },
    { anchorId: "wr-fetchref", status: "succeeded", ts: new Date(now.getTime() - 400 * DAY), refFetch: 1, refLock: 0 },
    { anchorId: "wr-lockref", status: "succeeded", ts: new Date(now.getTime() - 400 * DAY), refFetch: 0, refLock: 1 },
  ] as unknown as RowDataPacket[];
  const pool = makeWorkflowPool(rows);
  const plan = await planFamily(pool, WORKFLOW_AUDIT, { now });
  const eligible = new Set(plan.candidates.map((c) => c.anchorId));
  assert.ok(eligible.has("wr-std-old"), "standard run past 365d is eligible");
  assert.ok(eligible.has("wr-failed-old"), "failed run past 24 months is eligible");
  assert.equal(eligible.has("wr-failed-recent"), false);
  assert.equal(plan.skippedByReason.within_extended_retention, 1);
  assert.equal(eligible.has("wr-active"), false);
  assert.equal(plan.skippedByReason.active_or_retryable, 1);
  assert.equal(eligible.has("wr-fetchref"), false);
  assert.equal(plan.skippedByReason.referenced_by_fetch, 1);
  assert.equal(eligible.has("wr-lockref"), false);
  assert.equal(plan.skippedByReason.referenced_by_active_lock, 1);
});

function makeFetchPool(rows: RowDataPacket[]): Pool {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const handle = async (sqlRaw: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    const sql = norm(sqlRaw);
    if (/FROM data_fetch_runs dfr WHERE dfr.started_at < \?/i.test(sql)) {
      const cutoff = new Date(params[0] as Date).getTime();
      return [rows.filter((r) => new Date(r.ts).getTime() < cutoff).slice(0, Number(params[1])), []];
    }
    if (/^SELECT/i.test(sql)) return [[], []];
    return [{ affectedRows: 1 }, []];
  };
  return { query: (s: string, p?: unknown[]) => handle(s, p), execute: (s: string, p?: unknown[]) => handle(s, p), getConnection: async () => ({}) as PoolConnection } as unknown as Pool;
}

test("fetch_audit: a fetch run referenced by raw snapshots / battles / incidents is skipped; an unreferenced old one is eligible", async () => {
  const now = new Date();
  const base = { refRaw: 0, refObs: 0, refBattle: 0, refBrawler: 0, refPlayer: 0, refClub: 0, refIncident: 0, refRetry: 0, ts: new Date(now.getTime() - 400 * DAY) };
  const rows = [
    { anchorId: "dfr-free", ...base },
    { anchorId: "dfr-raw", ...base, refRaw: 1 },
    { anchorId: "dfr-battle", ...base, refBattle: 1 },
    { anchorId: "dfr-incident", ...base, refIncident: 1 },
  ] as unknown as RowDataPacket[];
  const pool = makeFetchPool(rows);
  const plan = await planFamily(pool, FETCH_AUDIT, { now });
  const eligible = new Set(plan.candidates.map((c) => c.anchorId));
  assert.deepEqual([...eligible], ["dfr-free"]);
  assert.equal(plan.skippedByReason.referenced_by_raw_snapshot, 1);
  assert.equal(plan.skippedByReason.referenced_by_normalized_battle, 1);
  assert.equal(plan.skippedByReason.referenced_by_data_incident, 1);
});

// --- production guard -------------------------------------------------------

test("production guard: destructive graph retention is blocked unless flag + isolated-staging env are set", () => {
  assert.throws(() => assertDestructiveAllowed({}), /destructive_flag_required/);
  assert.throws(() => assertDestructiveAllowed({ RETENTION_DESTRUCTIVE_ENABLED: "true" }), /production_guard_block/);
  assert.throws(() => assertDestructiveAllowed({ RETENTION_DESTRUCTIVE_ENABLED: "true", RETENTION_ENVIRONMENT: "production" }), /production_guard_block/);
  // Only this combination is allowed:
  assert.doesNotThrow(() => assertDestructiveAllowed({ RETENTION_DESTRUCTIVE_ENABLED: "true", RETENTION_ENVIRONMENT: "isolated_staging" }));
});

test("computeArchiveKey is deterministic and order-independent", () => {
  const a = computeArchiveKey("battle_graph", ["b", "a", "c"]);
  const b = computeArchiveKey("battle_graph", ["c", "b", "a"]);
  assert.equal(a, b);
  assert.match(a, /^battle_graph\/[0-9a-f]{32}$/);
});
