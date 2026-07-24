/**
 * DATASET Phase 15 — isolated-DB validation of the real collectors + alert
 * engine on MySQL 8.4. Double-gated (MON_DB_TEST=1 + DB creds) so it never runs
 * by accident or against production. Proves: capacity snapshot + persisted
 * 30/90/365 forecasts, health snapshot, healthy -> warning -> critical
 * escalation on the SAME deduped alert (occurrence increments), auto-resolution,
 * snapshot idempotency, and that NO operational row is modified by monitoring.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";

const enabled = process.env.MON_DB_TEST === "1" && Boolean(process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1);
const opt = { skip: enabled ? false : "isolated-DB only: set MON_DB_TEST=1 + DB creds." };
const ns = "mon_" + Date.now().toString(36);
const uid = (): string => randomUUID();
const ids: Record<string, string> = { source: uid(), endpoint: uid(), wf: uid(), brawler: uid(), aggO: uid(), aggM: uid(), aggX: uid(), ranking: uid(), snapshot: uid(), item: uid() };
const OPERATIONAL = ["normalized_battles", "workflow_runs", "raw_api_snapshots", "published_snapshots", "published_snapshot_items", "ranking_runs", "aggregation_runs"];
let opBefore: Record<string, number> = {};
let totalBytes = 5_000_000;

async function q(pool: Pool, sql: string, p: unknown[] = []): Promise<void> { await pool.query(sql, p); }
async function counts(pool: Pool): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of OPERATIONAL) { const [[r]] = await pool.query<RowDataPacket[]>(`SELECT COUNT(*) c FROM \`${t}\``); out[t] = Number(r.c); }
  return out;
}
async function setLimitForFree(pool: Pool, freeFrac: number): Promise<void> {
  const [[r]] = await pool.query<RowDataPacket[]>("SELECT COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0) t FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()");
  totalBytes = Number(r.t);
  process.env.MON_DB_CAPACITY_LIMIT_BYTES = String(Math.round(totalBytes / (1 - freeFrac)));
}
async function openAlert(pool: Pool, key: string): Promise<RowDataPacket | null> {
  const [[r]] = await pool.query<RowDataPacket[]>("SELECT * FROM operational_alerts WHERE alert_key = ? AND status = 'open'", [key]);
  return r ?? null;
}

before(async () => {
  if (!enabled) return;
  process.env.INTERNAL_CRON_SECRET = process.env.INTERNAL_CRON_SECRET || "test-secret";
  process.env.MON_BACKUP_AGE_SECONDS = "3600";       // known, fresh -> no backup alert
  process.env.MON_RESTORE_TEST_AGE_SECONDS = "3600";
  const { getPool } = await import("@/lib/mysql");
  const { ensureWorkflowDefinition } = await import("@/lib/workflow");
  const pool = getPool();
  const [[rs]] = await pool.query<RowDataPacket[]>("SELECT id FROM ranking_rule_sets WHERE is_active = 1 LIMIT 1");

  await q(pool, "INSERT INTO data_sources (id, name, source_type) VALUES (?, ?, 'official_api')", [ids.source, `${ns}-src`]);
  await q(pool, "INSERT INTO source_endpoints (id, data_source_id, endpoint_category, path) VALUES (?, ?, 'battlelog', '/x')", [ids.endpoint, ids.source]);
  const wfDef = await ensureWorkflowDefinition(pool, `${ns}-wf`, "scheduled_sync");
  await q(pool, "INSERT INTO workflow_runs (id, workflow_definition_id, status, triggered_by, started_at) VALUES (?, ?, 'succeeded', 'manual', UTC_TIMESTAMP(3))", [ids.wf, wfDef]);
  await q(pool, "INSERT INTO canonical_brawlers (id, source_brawler_id, slug, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'B', NOW(3), NOW(3))", [ids.brawler, `${ns}-b`, `${ns}-b`]);
  for (const [rid, scope] of [[ids.aggO, "overall"], [ids.aggM, "per_mode"], [ids.aggX, "matchup"]] as const)
    await q(pool, "INSERT INTO aggregation_runs (id, workflow_run_id, scope, status, started_at) VALUES (?, ?, ?, 'succeeded', UTC_TIMESTAMP(3))", [rid, ids.wf, scope]);
  await q(pool, "INSERT INTO ranking_runs (id, workflow_run_id, ranking_rule_set_id, mode_aggregation_run_id, overall_aggregation_run_id, matchup_aggregation_run_id, status, started_at) VALUES (?,?,?,?,?,?,'succeeded', UTC_TIMESTAMP(3))", [ids.ranking, ids.wf, rs.id, ids.aggM, ids.aggO, ids.aggX]);
  await q(pool, "INSERT INTO published_snapshots (id, ranking_run_id, is_current, published_at) VALUES (?, ?, 1, UTC_TIMESTAMP(3))", [ids.snapshot, ids.ranking]);
  await q(pool, "INSERT INTO published_snapshot_items (id, published_snapshot_id, brawler_id, overall_tier, overall_score, overall_confidence, mode_tiers, calculated_at, published_at, data_limitations) VALUES (?,?,?, 'B', 50.00, 'medium', '[]', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), '{}')", [ids.item, ids.snapshot, ids.brawler]);

  // History seeded ABOVE the current total so measured growth is <=0 (clamped to
  // 0): days_to_limit stays healthy (Infinity) and free% alone drives the forecast
  // state. Forecasts remain 'ok' (conservative 0 is a valid flat projection).
  const [[cur]] = await pool.query<RowDataPacket[]>("SELECT COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0) t FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()");
  const seedTotal = Number(cur.t) + 50_000_000;
  for (const off of [30, 7, 1])
    await q(pool, "INSERT INTO database_capacity_snapshots (id, captured_at, environment, schema_name, total_bytes, data_bytes, index_bytes, forecast_status, collector_version) VALUES (?, UTC_TIMESTAMP(3) - INTERVAL ? DAY, 'digitalocean', DATABASE(), ?, ?, ?, 'healthy', 'seed')", [uid(), off, seedTotal, seedTotal - 500000, 500000]);

  opBefore = await counts(pool);
});

after(async () => {
  if (!enabled) return;
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();
  const s = (p: Promise<unknown>) => p.catch(() => {});
  await s(q(pool, "DELETE FROM operational_alerts WHERE 1=1"));
  await s(q(pool, "DELETE FROM database_table_capacity_snapshots WHERE 1=1"));
  await s(q(pool, "DELETE FROM database_capacity_snapshots WHERE 1=1"));
  await s(q(pool, "DELETE FROM operational_health_snapshots WHERE 1=1"));
  await s(q(pool, "DELETE FROM monitoring_runs WHERE 1=1"));
  await s(q(pool, "DELETE FROM workflow_locks WHERE locked_by_run_id = ?", [ids.wf]));
  await s(q(pool, "DELETE FROM published_snapshot_items WHERE id = ?", [ids.item]));
  await s(q(pool, "DELETE FROM published_snapshots WHERE id = ?", [ids.snapshot]));
  await s(q(pool, "DELETE FROM ranking_runs WHERE id = ?", [ids.ranking]));
  await s(q(pool, "DELETE FROM aggregation_runs WHERE id IN (?,?,?)", [ids.aggO, ids.aggM, ids.aggX]));
  await s(q(pool, "DELETE FROM workflow_runs WHERE id = ?", [ids.wf]));
  await s(q(pool, "DELETE FROM workflow_definitions WHERE slug = ?", [`${ns}-wf`]));
  await s(q(pool, "DELETE FROM canonical_brawlers WHERE id = ?", [ids.brawler]));
  await s(q(pool, "DELETE FROM source_endpoints WHERE id = ?", [ids.endpoint]));
  await s(q(pool, "DELETE FROM data_sources WHERE id = ?", [ids.source]));
  await pool.end().catch(() => {});
  (globalThis as Record<string, unknown>).__brawlranksMysqlPool = undefined;
});

test("HEALTHY: capacity snapshot healthy, forecasts persisted (30/90/365), no critical alerts", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runSnapshot, runEvaluate, readCapacitySummary } = await import("@/lib/monitoring/runner");
  const pool = getPool();
  await setLimitForFree(pool, 0.60);
  const snap = await runSnapshot(pool, {});
  assert.equal(snap.capacity.forecastStatus, "healthy");
  assert.equal(snap.forecasts.length, 3);
  assert.deepEqual(snap.forecasts.map((f) => f.horizonDays), [30, 90, 365]);
  assert.ok(snap.forecasts.every((f) => f.status === "ok"), "forecasts computed (flat history is still ok)");

  const summary = await readCapacitySummary(pool) as { forecasts: unknown[] };
  assert.equal((summary.forecasts as unknown[]).length, 3, "forecasts persisted + exposed");

  const ev = await runEvaluate(pool, {});
  assert.equal(ev.reconcile!.criticalCount, 0, "healthy state has no critical alerts");
  assert.equal(await openAlert(pool, "capacity:free_percent"), null);
});

test("WARNING: free% in warning band opens a warning alert", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runSnapshot, runEvaluate } = await import("@/lib/monitoring/runner");
  const pool = getPool();
  await setLimitForFree(pool, 0.25);
  const snap = await runSnapshot(pool, {});
  assert.equal(snap.capacity.forecastStatus, "warning");
  await runEvaluate(pool, {});
  const a = await openAlert(pool, "capacity:free_percent");
  assert.ok(a, "warning alert opened");
  assert.equal(a!.severity, "warning");
  assert.equal(Number(a!.occurrence_count), 1);
});

test("CRITICAL: escalates the SAME alert to critical (dedupe, occurrence increments) + expired-lock alert", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runSnapshot, runEvaluate } = await import("@/lib/monitoring/runner");
  const pool = getPool();
  const wfDef = (await pool.query<RowDataPacket[]>("SELECT id FROM workflow_definitions WHERE slug = ?", [`${ns}-wf`]))[0][0].id;
  await q(pool, "INSERT INTO workflow_locks (id, workflow_definition_id, locked_by_run_id, locked_at, expires_at) VALUES (?, ?, ?, UTC_TIMESTAMP(3) - INTERVAL 1 HOUR, UTC_TIMESTAMP(3) - INTERVAL 30 MINUTE)", [uid(), wfDef, ids.wf]);
  await setLimitForFree(pool, 0.12);
  const snap = await runSnapshot(pool, {});
  assert.equal(snap.capacity.forecastStatus, "critical");
  await runEvaluate(pool, {});
  const a = await openAlert(pool, "capacity:free_percent");
  assert.ok(a);
  assert.equal(a!.severity, "critical", "warning escalated to critical on the same alert");
  assert.ok(Number(a!.occurrence_count) >= 2, "occurrence_count incremented, not a new alert");
  const [[dup]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) c FROM operational_alerts WHERE alert_key = 'capacity:free_percent' AND status = 'open'");
  assert.equal(Number(dup.c), 1, "no duplicate open alert for the same key");
  assert.ok(await openAlert(pool, "workflow:expired_lock"), "expired lock alert opened");
});

test("RESOLUTION: when conditions clear, alerts auto-resolve (history preserved)", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runSnapshot, runEvaluate } = await import("@/lib/monitoring/runner");
  const pool = getPool();
  await q(pool, "DELETE FROM workflow_locks WHERE locked_by_run_id = ?", [ids.wf]);
  await setLimitForFree(pool, 0.60);
  const snap = await runSnapshot(pool, {});
  assert.equal(snap.capacity.forecastStatus, "healthy");
  await runEvaluate(pool, {});
  assert.equal(await openAlert(pool, "capacity:free_percent"), null, "capacity alert resolved");
  assert.equal(await openAlert(pool, "workflow:expired_lock"), null, "expired-lock alert resolved");
  const [[resolved]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) c FROM operational_alerts WHERE alert_key = 'capacity:free_percent' AND status = 'resolved'");
  assert.ok(Number(resolved.c) >= 1, "resolved alert history preserved");
});

test("IDEMPOTENCY: a snapshot rerun with the same key is a no-op", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runSnapshot } = await import("@/lib/monitoring/runner");
  const pool = getPool();
  const key = "idem-" + uid();
  const [[b1]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) c FROM database_capacity_snapshots");
  const r1 = await runSnapshot(pool, { idempotencyKey: key });
  const r2 = await runSnapshot(pool, { idempotencyKey: key });
  const [[b2]] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) c FROM database_capacity_snapshots");
  assert.equal(r1.idempotent, false);
  assert.equal(r2.idempotent, true, "second run with same key is idempotent");
  assert.equal(Number(b2.c) - Number(b1.c), 1, "exactly one capacity snapshot written for the duplicated key");
});

test("SAFETY: monitoring modified NO operational rows", opt, async () => {
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();
  const opAfter = await counts(pool);
  assert.deepEqual(opAfter, opBefore, "operational table row counts unchanged by all monitoring runs");
});
