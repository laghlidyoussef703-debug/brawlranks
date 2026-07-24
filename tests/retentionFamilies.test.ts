/**
 * DATASET Phase 14 — DB-free unit coverage for the newly-added retention
 * families (observed_players, crawl_batches, detected_changes, data_incidents,
 * normalized_snapshots, player_name_history archive-only) and the maintenance
 * paths (workflow_locks GC, normalized_players safeguard). A fake pool answers
 * each plan's single query so exact boundary/guard logic is asserted without
 * MySQL. (Full lifecycle + real SQL is proven by tests/retentionPhase14Isolated.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import {
  planFamily, OBSERVED_PLAYERS, CRAWL_BATCHES, DETECTED_CHANGES, DATA_INCIDENTS,
  NORMALIZED_SNAPSHOTS, PLAYER_NAME_HISTORY,
} from "@/lib/retention/graph";

function poolReturning(match: RegExp, rows: RowDataPacket[], extra?: (sql: string) => RowDataPacket[] | null): Pool {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const handle = async (sqlRaw: string): Promise<[unknown, unknown]> => {
    const sql = norm(sqlRaw);
    if (match.test(sql)) return [rows, []];
    const e = extra?.(sql);
    if (e) return [e, []];
    if (/^SELECT/i.test(sql)) return [[], []];
    return [{ affectedRows: 0 } as ResultSetHeader, []];
  };
  return {
    query: (s: string) => handle(s), execute: (s: string) => handle(s),
    getConnection: async () => ({ query: (s: string) => handle(s), execute: (s: string) => handle(s), beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} } as unknown as PoolConnection),
  } as unknown as Pool;
}

test("observed_players: 60d unpromoted / 30d promoted boundaries and active-crawl guard", async () => {
  const now = new Date();
  const d = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const rows = [
    { anchorId: "unpromoted-old", playerTag: "#u", promoted: 0, firstObserved: d(90), promotedAt: null, activeCrawl: 0 },
    { anchorId: "unpromoted-hot", playerTag: "#h", promoted: 0, firstObserved: d(10), promotedAt: null, activeCrawl: 0 },
    { anchorId: "promoted-old", playerTag: "#p", promoted: 1, firstObserved: d(200), promotedAt: d(60), activeCrawl: 0 },
    { anchorId: "promoted-hot", playerTag: "#ph", promoted: 1, firstObserved: d(200), promotedAt: d(10), activeCrawl: 0 },
    { anchorId: "active-crawl", playerTag: "#a", promoted: 0, firstObserved: d(90), promotedAt: null, activeCrawl: 1 },
  ] as unknown as RowDataPacket[];
  const plan = await planFamily(poolReturning(/FROM observed_players op/i, rows), OBSERVED_PLAYERS, { now });
  const eligible = new Set(plan.candidates.map((c) => c.anchorId));
  assert.deepEqual([...eligible].sort(), ["promoted-old", "unpromoted-old"]);
  assert.equal(plan.skippedByReason.within_unpromoted_hot, 1);
  assert.equal(plan.skippedByReason.within_promoted_hot, 1);
  assert.equal(plan.skippedByReason.active_crawl_dependency, 1);
});

test("crawl_batches: only completed batches (SQL guards uncompleted/active out)", async () => {
  const rows = [{ anchorId: "cb1", wf: "wf1", ts: new Date() }] as unknown as RowDataPacket[];
  const plan = await planFamily(poolReturning(/FROM crawl_batches WHERE completed_at IS NOT NULL/i, rows), CRAWL_BATCHES, {});
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].anchorId, "cb1");
});

test("detected_changes: open incident dependency blocks", async () => {
  const rows = [
    { anchorId: "dc-free", ts: new Date(), fr: "f1", openIncident: 0 },
    { anchorId: "dc-blocked", ts: new Date(), fr: "f2", openIncident: 1 },
  ] as unknown as RowDataPacket[];
  const plan = await planFamily(poolReturning(/FROM detected_changes dc/i, rows), DETECTED_CHANGES, {});
  assert.deepEqual(plan.candidates.map((c) => c.anchorId), ["dc-free"]);
  assert.equal(plan.skippedByReason.open_incident_dependency, 1);
});

test("data_incidents: only resolved rows are candidates (SQL guards unresolved out)", async () => {
  const rows = [{ anchorId: "inc-resolved", ts: new Date() }] as unknown as RowDataPacket[];
  const plan = await planFamily(poolReturning(/FROM data_incidents WHERE status = 'resolved'/i, rows), DATA_INCIDENTS, {});
  assert.equal(plan.candidates.length, 1);
});

test("normalized_snapshots: only superseded (is_accepted=0) rows are candidates", async () => {
  const rows = [{ anchorId: "snap-superseded", et: "brawler", eid: "x", ts: new Date() }] as unknown as RowDataPacket[];
  const plan = await planFamily(poolReturning(/FROM normalized_snapshots WHERE is_accepted = 0/i, rows), NORMALIZED_SNAPSHOTS, {});
  assert.equal(plan.candidates.length, 1);
  assert.deepEqual(plan.candidates[0].naturalKey, { entity_type: "brawler", entity_id: "x" });
});

test("player_name_history: archive-only family lists archivable rows and refuses deletion", async () => {
  const { deleteGraphBatch } = await import("@/lib/retention/graph");
  const rows = [{ anchorId: "00000000-0000-0000-0000-000000000001", pid: "p1", pname: "Old", ts: new Date() }] as unknown as RowDataPacket[];
  const plan = await planFamily(poolReturning(/FROM player_name_history WHERE recorded_at < \?/i, rows), PLAYER_NAME_HISTORY, {});
  assert.equal(plan.candidates.length, 1);
  // Even with a (fake) verified manifest, an archive-only family is refused.
  const pool = poolReturning(/FROM retention_graph_manifests/i, [{ id: "m1", family: "player_name_history", archive_key: "k", verification_status: "verified", verification_count: 2, staging_reimport_status: "passed", anchor_count: 1 }] as unknown as RowDataPacket[]);
  const res = await deleteGraphBatch(pool, PLAYER_NAME_HISTORY, "player_name_history/abc", { allowlist: ["00000000-0000-0000-0000-000000000001"], dryRun: false });
  assert.equal(res.blockedReason, "archive_only_no_deletion");
});

// --- maintenance -----------------------------------------------------------

test("workflow_locks GC: dry-run counts, real requires flag+env, never touches active owners", async () => {
  const { cleanupExpiredWorkflowLocks } = await import("@/lib/retention/maintenance");
  const state = { locks: ["l1", "l2"] };
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const handle = async (sqlRaw: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    const sql = norm(sqlRaw);
    if (/SELECT wl.id FROM workflow_locks wl LEFT JOIN/i.test(sql)) return [state.locks.map((id) => ({ id })), []];
    if (/COUNT\(\*\) n FROM workflow_locks wl JOIN workflow_runs/i.test(sql)) return [[{ n: 3 }], []];
    if (/^DELETE FROM workflow_locks WHERE id IN/i.test(sql)) { const n = (params as string[]).length; state.locks = []; return [{ affectedRows: n } as ResultSetHeader, []]; }
    return [{ affectedRows: 0 } as ResultSetHeader, []];
  };
  const pool = { query: (s: string, p?: unknown[]) => handle(s, p), execute: (s: string, p?: unknown[]) => handle(s, p) } as unknown as Pool;

  const dry = await cleanupExpiredWorkflowLocks(pool, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.candidates, 2);
  assert.equal(dry.deleted, 0);
  assert.equal(dry.skippedActiveOwner, 3, "active-owner locks are reported, never removed");

  await assert.rejects(() => cleanupExpiredWorkflowLocks(pool, { dryRun: false, env: {} }), /destructive_flag_required/);
  await assert.rejects(() => cleanupExpiredWorkflowLocks(pool, { dryRun: false, env: { RETENTION_DESTRUCTIVE_ENABLED: "true", RETENTION_ENVIRONMENT: "production" } }), /production_guard_block/);

  const real = await cleanupExpiredWorkflowLocks(pool, { dryRun: false, env: { RETENTION_DESTRUCTIVE_ENABLED: "true", RETENTION_ENVIRONMENT: "isolated_staging" } });
  assert.equal(real.deleted, 2);
});

test("normalized_players safeguard: reachable + participant-referenced player is never deletable", async () => {
  const { assessNormalizedPlayerDeletion } = await import("@/lib/retention/maintenance");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const handle = async (sqlRaw: string): Promise<[unknown, unknown]> => {
    const sql = norm(sqlRaw);
    if (/SELECT is_reachable FROM normalized_players/i.test(sql)) return [[{ is_reachable: 1 }], []];
    if (/EXISTS\(SELECT 1 FROM battle_participants/i.test(sql)) return [[{ r: 1 }], []];
    return [[], []];
  };
  const pool = { query: (s: string) => handle(s), execute: (s: string) => handle(s) } as unknown as Pool;
  const res = await assessNormalizedPlayerDeletion(pool, "p1");
  assert.equal(res.deletable, false);
  assert.deepEqual(res.blockReasons.sort(), ["active_or_reachable", "no_approved_merge_evidence", "participant_referenced"]);
});
