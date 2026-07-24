/**
 * DATASET Phase 15 — monitoring data access.
 *
 * READ-ONLY against operational tables (information_schema + safe counts); the
 * ONLY rows it writes are monitoring rows (capacity/health snapshots, alerts,
 * monitoring_runs). Best-effort DB engine stats (connections/locks/long queries)
 * are captured with per-query failure isolation: a query the monitoring user is
 * not privileged for yields `null` (unknown) and degrades collector_status —
 * never an error that aborts the whole collection, never a fabricated number.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { getArchiveMetrics } from "@/lib/archive/repository";
import type { MonitoringThresholds } from "./thresholds";
import type { CapacityPoint } from "./capacity";
import type { DesiredAlert } from "./alerts";

type Queryable = Pool | PoolConnection;

// ---------------------------------------------------------------------------
// Capacity (information_schema — read-only)
// ---------------------------------------------------------------------------

export interface TableCapacity { tableName: string; rowCount: number | null; dataBytes: number; indexBytes: number; totalBytes: number }
export interface CapacityRaw { schemaName: string; totalBytes: number; dataBytes: number; indexBytes: number; tables: TableCapacity[] }

export async function collectCapacityRaw(db: Queryable): Promise<CapacityRaw> {
  const [[agg]] = await db.query<RowDataPacket[]>(
    `SELECT DATABASE() AS schemaName,
            COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS total,
            COALESCE(SUM(DATA_LENGTH), 0) AS data_len,
            COALESCE(SUM(INDEX_LENGTH), 0) AS idx_len
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
  );
  const [tables] = await db.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS t, TABLE_ROWS AS rows_est,
            COALESCE(DATA_LENGTH,0) AS data_len, COALESCE(INDEX_LENGTH,0) AS idx_len,
            COALESCE(DATA_LENGTH,0) + COALESCE(INDEX_LENGTH,0) AS total
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY (COALESCE(DATA_LENGTH,0) + COALESCE(INDEX_LENGTH,0)) DESC`
  );
  return {
    schemaName: String(agg.schemaName),
    totalBytes: Number(agg.total), dataBytes: Number(agg.data_len), indexBytes: Number(agg.idx_len),
    tables: tables.map((r) => ({ tableName: String(r.t), rowCount: r.rows_est === null ? null : Number(r.rows_est), dataBytes: Number(r.data_len), indexBytes: Number(r.idx_len), totalBytes: Number(r.total) })),
  };
}

export async function readCapacityHistory(db: Queryable, environment: string, schemaName: string, limit = 200): Promise<CapacityPoint[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT captured_at, total_bytes FROM database_capacity_snapshots
      WHERE environment = ? AND schema_name = ? ORDER BY captured_at DESC LIMIT ?`,
    [environment, schemaName, limit]
  );
  return rows.map((r) => ({ capturedAt: new Date(r.captured_at), totalBytes: Number(r.total_bytes) }));
}

// ---------------------------------------------------------------------------
// Operational health (read-only counts + best-effort engine stats)
// ---------------------------------------------------------------------------

export interface HealthRaw {
  battlesLastHour: number | null;
  battlesLast24h: number | null;
  latestBattleAt: Date | null;
  latestFetchAt: Date | null;
  failedFetchCount: number | null;
  retryBacklogCount: number | null;
  rawArchivePendingCount: number | null;
  rawArchiveFailedCount: number | null;
  oldestPendingArchiveAgeSeconds: number | null;
  oldestFailedArchiveAgeSeconds: number | null;
  archiveVerificationFailureCount: number | null;
  rawPayloadBlockedCount: number | null;
  workflowRunningCount: number | null;
  workflowFailedCount: number | null;
  workflowRetryableCount: number | null;
  workflowStalledCount: number | null;
  expiredLockCount: number | null;
  unreleasedLockCount: number | null;
  oldestActiveWorkflowAgeSeconds: number | null;
  currentPublishedSnapshotId: string | null;
  currentPublishedSnapshotAgeSeconds: number | null;
  currentPublishedSnapshotItemCount: number | null;
  latestRankingRunStatus: string | null;
  heldRankingRunCount: number | null;
  backupAgeSeconds: number | null;
  restoreTestAgeSeconds: number | null;
  activeConnections: number | null;
  maxConnections: number | null;
  connectionUsagePercent: number | null;
  lockWaitCount: number | null;
  longRunningQueryCount: number | null;
  collectorQueryLatencyMs: number | null;
  collectorStatus: "ok" | "degraded" | "failed";
  degradedReasons: string[];
}

async function tryNum(db: Queryable, sql: string, params: unknown[], reasons: string[], label: string): Promise<number | null> {
  try {
    const [[r]] = await db.query<RowDataPacket[]>(sql, params);
    const v = r ? (Object.values(r)[0] as unknown) : null;
    return v === null || v === undefined ? null : Number(v);
  } catch {
    reasons.push(label);
    return null;
  }
}

export async function collectHealthRaw(db: Queryable, t: MonitoringThresholds): Promise<HealthRaw> {
  const reasons: string[] = [];
  const started = Date.now();

  // Ingestion (schema-privileged counts — required).
  const battlesLastHour = await tryNum(db, "SELECT COUNT(*) c FROM normalized_battles WHERE created_at >= UTC_TIMESTAMP(3) - INTERVAL 1 HOUR", [], reasons, "battles_hour");
  const battlesLast24h = await tryNum(db, "SELECT COUNT(*) c FROM normalized_battles WHERE created_at >= UTC_TIMESTAMP(3) - INTERVAL 24 HOUR", [], reasons, "battles_24h");
  const [[latestBattle]] = await db.query<RowDataPacket[]>("SELECT MAX(occurred_at) m FROM normalized_battles");
  const [[latestFetch]] = await db.query<RowDataPacket[]>("SELECT MAX(started_at) m FROM data_fetch_runs");
  const failedFetchCount = await tryNum(db, "SELECT COUNT(*) c FROM data_fetch_runs WHERE status IN ('failed','timeout') AND started_at >= UTC_TIMESTAMP(3) - INTERVAL 24 HOUR", [], reasons, "failed_fetch");
  const retryBacklogCount = await tryNum(db, "SELECT COUNT(*) c FROM player_crawl_schedule WHERE is_active = 1 AND next_due_at <= UTC_TIMESTAMP(3) AND (backoff_until IS NULL OR backoff_until <= UTC_TIMESTAMP(3)) AND leased_by_run_id IS NULL", [], reasons, "retry_backlog");

  // Archives (reuse the archive metrics; add oldest-failed age + blocked count).
  let archivePending: number | null = null, archiveFailed: number | null = null, oldestPending: number | null = null, verifFailures: number | null = null;
  try {
    const m = await getArchiveMetrics(db);
    archivePending = m.pending; archiveFailed = m.failed; oldestPending = m.oldestPendingAgeSeconds; verifFailures = m.verificationFailures;
  } catch { reasons.push("archive_metrics"); }
  const oldestFailedArchiveAgeSeconds = await tryNum(db, "SELECT TIMESTAMPDIFF(SECOND, MIN(updated_at), UTC_TIMESTAMP(3)) s FROM raw_snapshot_archives WHERE archive_status = 'failed'", [], reasons, "oldest_failed_archive");
  const rawPayloadBlockedCount = await tryNum(db, `SELECT COUNT(*) c FROM raw_api_snapshots s LEFT JOIN raw_snapshot_archives a ON a.raw_snapshot_id = s.id WHERE s.payload IS NOT NULL AND (a.raw_snapshot_id IS NULL OR a.archive_status <> 'verified')`, [], reasons, "raw_blocked");

  // Workflows.
  const workflowRunningCount = await tryNum(db, "SELECT COUNT(*) c FROM workflow_runs WHERE status = 'running'", [], reasons, "wf_running");
  const workflowFailedCount = await tryNum(db, "SELECT COUNT(*) c FROM workflow_runs WHERE status = 'failed' AND started_at >= UTC_TIMESTAMP(3) - INTERVAL 24 HOUR", [], reasons, "wf_failed");
  const workflowRetryableCount = await tryNum(db, "SELECT COUNT(*) c FROM workflow_runs WHERE status IN ('retrying','queued')", [], reasons, "wf_retryable");
  const workflowStalledCount = await tryNum(db, "SELECT COUNT(*) c FROM workflow_runs WHERE status = 'running' AND started_at < UTC_TIMESTAMP(3) - INTERVAL ? MINUTE", [t.workflowStalledMinutes], reasons, "wf_stalled");
  const expiredLockCount = await tryNum(db, "SELECT COUNT(*) c FROM workflow_locks WHERE released_at IS NULL AND expires_at < UTC_TIMESTAMP(3)", [], reasons, "locks_expired");
  const unreleasedLockCount = await tryNum(db, "SELECT COUNT(*) c FROM workflow_locks WHERE released_at IS NULL", [], reasons, "locks_unreleased");
  const oldestActiveWorkflowAgeSeconds = await tryNum(db, "SELECT TIMESTAMPDIFF(SECOND, MIN(started_at), UTC_TIMESTAMP(3)) s FROM workflow_runs WHERE status = 'running'", [], reasons, "wf_oldest_active");

  // Publishing.
  const [[snap]] = await db.query<RowDataPacket[]>(
    `SELECT ps.id, TIMESTAMPDIFF(SECOND, ps.published_at, UTC_TIMESTAMP(3)) age,
            (SELECT COUNT(*) FROM published_snapshot_items i WHERE i.published_snapshot_id = ps.id) items
       FROM published_snapshots ps WHERE ps.is_current = 1 LIMIT 1`
  );
  const heldRankingRunCount = await tryNum(db, "SELECT COUNT(*) c FROM ranking_runs WHERE status = 'held'", [], reasons, "ranking_held");
  const [[latestRanking]] = await db.query<RowDataPacket[]>("SELECT status FROM ranking_runs ORDER BY started_at DESC LIMIT 1");

  // Backups / restore-test evidence: unknown unless the operator supplies it.
  const backupAgeSeconds = envSeconds("MON_BACKUP_AGE_SECONDS");
  const restoreTestAgeSeconds = envSeconds("MON_RESTORE_TEST_AGE_SECONDS");

  // Best-effort engine stats (may require privileges the monitoring user lacks).
  const maxConnections = await tryNum(db, "SELECT @@max_connections v", [], reasons, "max_conn");
  let activeConnections = await tryNum(db, "SELECT VARIABLE_VALUE v FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Threads_connected'", [], reasons, "active_conn");
  if (activeConnections === null) activeConnections = await tryNum(db, "SELECT COUNT(*) v FROM information_schema.PROCESSLIST", [], reasons, "active_conn_pl");
  const connectionUsagePercent = activeConnections !== null && maxConnections !== null && maxConnections > 0 ? (activeConnections / maxConnections) * 100 : null;
  const longRunningQueryCount = await tryNum(db, "SELECT COUNT(*) v FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Sleep' AND TIME > 5", [], reasons, "long_query");
  const lockWaitCount = await tryNum(db, "SELECT COUNT(*) v FROM performance_schema.data_lock_waits", [], reasons, "lock_wait");

  const collectorQueryLatencyMs = Date.now() - started;
  const collectorStatus: HealthRaw["collectorStatus"] = reasons.length === 0 ? "ok" : "degraded";

  return {
    battlesLastHour, battlesLast24h,
    latestBattleAt: latestBattle?.m ? new Date(latestBattle.m) : null,
    latestFetchAt: latestFetch?.m ? new Date(latestFetch.m) : null,
    failedFetchCount, retryBacklogCount,
    rawArchivePendingCount: archivePending, rawArchiveFailedCount: archiveFailed,
    oldestPendingArchiveAgeSeconds: oldestPending, oldestFailedArchiveAgeSeconds,
    archiveVerificationFailureCount: verifFailures, rawPayloadBlockedCount,
    workflowRunningCount, workflowFailedCount, workflowRetryableCount, workflowStalledCount,
    expiredLockCount, unreleasedLockCount, oldestActiveWorkflowAgeSeconds,
    currentPublishedSnapshotId: snap?.id ?? null,
    currentPublishedSnapshotAgeSeconds: snap?.age === undefined || snap?.age === null ? null : Number(snap.age),
    currentPublishedSnapshotItemCount: snap?.items === undefined || snap?.items === null ? null : Number(snap.items),
    latestRankingRunStatus: latestRanking?.status ?? null,
    heldRankingRunCount,
    backupAgeSeconds, restoreTestAgeSeconds,
    activeConnections, maxConnections, connectionUsagePercent,
    lockWaitCount, longRunningQueryCount, collectorQueryLatencyMs,
    collectorStatus, degradedReasons: reasons,
  };
}

function envSeconds(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface CapacitySnapshotRow {
  environment: string; schemaName: string; totalBytes: number; dataBytes: number; indexBytes: number;
  configuredLimitBytes: number | null; freeBytes: number | null; freePercent: number | null;
  growth24h: number | null; growth7d: number | null; growth30d: number | null; conservative: number | null;
  daysToLimit: number | null; forecastStatus: string; collectorVersion: string; sourceMetadata: unknown; capturedAt: Date;
}

export async function insertCapacitySnapshot(db: Queryable, r: CapacitySnapshotRow, tables: TableCapacity[]): Promise<string> {
  const id = randomUUID();
  const d2l = r.daysToLimit === null ? null : Number.isFinite(r.daysToLimit) ? r.daysToLimit : null;
  await db.execute(
    `INSERT INTO database_capacity_snapshots
       (id, captured_at, environment, schema_name, total_bytes, data_bytes, index_bytes, configured_limit_bytes,
        free_bytes, free_percent, growth_24h_bytes_per_day, growth_7d_bytes_per_day, growth_30d_bytes_per_day,
        conservative_growth_bytes_per_day, days_to_limit, forecast_status, collector_version, source_metadata)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, r.capturedAt, r.environment, r.schemaName, r.totalBytes, r.dataBytes, r.indexBytes, r.configuredLimitBytes,
     r.freeBytes, r.freePercent, round(r.growth24h), round(r.growth7d), round(r.growth30d), round(r.conservative),
     d2l, r.forecastStatus, r.collectorVersion, JSON.stringify(r.sourceMetadata ?? {})]
  );
  for (const tbl of tables) {
    await db.execute(
      `INSERT INTO database_table_capacity_snapshots (id, capacity_snapshot_id, schema_name, table_name, row_count, data_bytes, index_bytes, total_bytes, captured_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [randomUUID(), id, r.schemaName, tbl.tableName, tbl.rowCount, tbl.dataBytes, tbl.indexBytes, tbl.totalBytes, r.capturedAt]
    );
  }
  return id;
}
function round(v: number | null): number | null { return v === null ? null : Math.round(v); }

export async function insertHealthSnapshot(db: Queryable, environment: string, capturedAt: Date, h: HealthRaw): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO operational_health_snapshots
       (id, captured_at, environment, battles_last_hour, battles_last_24h, latest_battle_at, latest_fetch_at,
        failed_fetch_count, retry_backlog_count, raw_archive_pending_count, raw_archive_failed_count,
        oldest_pending_archive_age_seconds, oldest_failed_archive_age_seconds, archive_verification_failure_count,
        raw_payload_blocked_count, workflow_running_count, workflow_failed_count, workflow_retryable_count,
        workflow_stalled_count, expired_lock_count, unreleased_lock_count, oldest_active_workflow_age_seconds,
        current_published_snapshot_id, current_published_snapshot_age_seconds, current_published_snapshot_item_count,
        latest_ranking_run_status, held_ranking_run_count, backup_age_seconds, restore_test_age_seconds,
        active_connections, max_connections, connection_usage_percent, lock_wait_count, long_running_query_count,
        collector_query_latency_ms, collector_status, details)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, capturedAt, environment, h.battlesLastHour, h.battlesLast24h, h.latestBattleAt, h.latestFetchAt,
     h.failedFetchCount, h.retryBacklogCount, h.rawArchivePendingCount, h.rawArchiveFailedCount,
     h.oldestPendingArchiveAgeSeconds, h.oldestFailedArchiveAgeSeconds, h.archiveVerificationFailureCount,
     h.rawPayloadBlockedCount, h.workflowRunningCount, h.workflowFailedCount, h.workflowRetryableCount,
     h.workflowStalledCount, h.expiredLockCount, h.unreleasedLockCount, h.oldestActiveWorkflowAgeSeconds,
     h.currentPublishedSnapshotId, h.currentPublishedSnapshotAgeSeconds, h.currentPublishedSnapshotItemCount,
     h.latestRankingRunStatus, h.heldRankingRunCount, h.backupAgeSeconds, h.restoreTestAgeSeconds,
     h.activeConnections, h.maxConnections, h.connectionUsagePercent, h.lockWaitCount, h.longRunningQueryCount,
     h.collectorQueryLatencyMs, h.collectorStatus, JSON.stringify({ degradedReasons: h.degradedReasons })]
  );
  return id;
}

export async function getLatestCapacitySnapshot(db: Queryable): Promise<RowDataPacket | null> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT * FROM database_capacity_snapshots ORDER BY captured_at DESC LIMIT 1");
  return rows[0] ?? null;
}
export async function getLatestHealthSnapshots(db: Queryable, limit = 2): Promise<RowDataPacket[]> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT * FROM operational_health_snapshots ORDER BY captured_at DESC LIMIT ?", [limit]);
  return rows;
}
export async function getOpenAlerts(db: Queryable): Promise<RowDataPacket[]> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT * FROM operational_alerts WHERE status = 'open' ORDER BY severity DESC, last_seen_at DESC");
  return rows;
}

// ---------------------------------------------------------------------------
// Alert reconciliation (dedupe / increment / auto-resolve)
// ---------------------------------------------------------------------------

export interface ReconcileResult { opened: number; updated: number; resolved: number; openCount: number; warningCount: number; criticalCount: number }

export async function reconcileAlerts(db: Pool, desired: DesiredAlert[], sourceSnapshotId: string | null, now: Date): Promise<ReconcileResult> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [open] = await conn.query<RowDataPacket[]>("SELECT id, alert_key, severity FROM operational_alerts WHERE status = 'open' FOR UPDATE");
    const openByKey = new Map(open.map((r) => [String(r.alert_key), r]));
    const desiredByKey = new Map(desired.map((d) => [d.alertKey, d]));
    let opened = 0, updated = 0, resolved = 0;

    for (const d of desired) {
      const existing = openByKey.get(d.alertKey);
      if (existing) {
        await conn.execute(
          `UPDATE operational_alerts SET last_seen_at = ?, occurrence_count = occurrence_count + 1, severity = ?, alert_type = ?, current_value = ?, threshold = ?, details = ?, source_snapshot_id = ? WHERE id = ?`,
          [now, d.severity, d.alertType, d.currentValue, d.threshold, JSON.stringify(d.details), sourceSnapshotId, existing.id]
        );
        updated += 1;
      } else {
        await conn.execute(
          `INSERT INTO operational_alerts (id, alert_key, alert_type, severity, status, first_seen_at, last_seen_at, occurrence_count, current_value, threshold, details, source_snapshot_id)
           VALUES (?,?,?,?, 'open', ?, ?, 1, ?, ?, ?, ?)`,
          [randomUUID(), d.alertKey, d.alertType, d.severity, now, now, d.currentValue, d.threshold, JSON.stringify(d.details), sourceSnapshotId]
        );
        opened += 1;
      }
    }
    // Auto-resolve open alerts whose condition cleared.
    for (const [key, row] of openByKey) {
      if (!desiredByKey.has(key)) {
        await conn.execute("UPDATE operational_alerts SET status = 'resolved', resolved_at = ? WHERE id = ?", [now, row.id]);
        resolved += 1;
      }
    }
    await conn.commit();

    const [[counts]] = await conn.query<RowDataPacket[]>(
      "SELECT COUNT(*) openCount, SUM(severity = 'warning') w, SUM(severity = 'critical') c FROM operational_alerts WHERE status = 'open'"
    );
    return { opened, updated, resolved, openCount: Number(counts.openCount), warningCount: Number(counts.w ?? 0), criticalCount: Number(counts.c ?? 0) };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// monitoring_runs (idempotent)
// ---------------------------------------------------------------------------

export interface StartRunResult { id: string; alreadyExisted: boolean; existingRow: RowDataPacket | null }

export async function startMonitoringRun(db: Pool, runType: "snapshot" | "evaluate", collectorVersion: string, idempotencyKey: string | null): Promise<StartRunResult> {
  const id = randomUUID();
  if (idempotencyKey) {
    try {
      await db.execute(
        "INSERT INTO monitoring_runs (id, run_type, started_at, status, collector_version, idempotency_key) VALUES (?, ?, UTC_TIMESTAMP(3), 'running', ?, ?)",
        [id, runType, collectorVersion, idempotencyKey]
      );
      return { id, alreadyExisted: false, existingRow: null };
    } catch (error) {
      if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
        const [[row]] = await db.query<RowDataPacket[]>("SELECT * FROM monitoring_runs WHERE idempotency_key = ?", [idempotencyKey]);
        return { id: row.id, alreadyExisted: true, existingRow: row };
      }
      throw error;
    }
  }
  await db.execute("INSERT INTO monitoring_runs (id, run_type, started_at, status, collector_version) VALUES (?, ?, UTC_TIMESTAMP(3), 'running', ?)", [id, runType, collectorVersion]);
  return { id, alreadyExisted: false, existingRow: null };
}

export async function completeMonitoringRun(
  db: Queryable, id: string,
  p: { status: "succeeded" | "failed"; capacitySnapshotId?: string | null; healthSnapshotId?: string | null; warningCount?: number; criticalCount?: number; failureDetails?: unknown }
): Promise<void> {
  await db.execute(
    `UPDATE monitoring_runs SET completed_at = UTC_TIMESTAMP(3), status = ?, capacity_snapshot_id = ?, health_snapshot_id = ?, warning_count = ?, critical_count = ?, failure_details = ? WHERE id = ?`,
    [p.status, p.capacitySnapshotId ?? null, p.healthSnapshotId ?? null, p.warningCount ?? 0, p.criticalCount ?? 0, p.failureDetails ? JSON.stringify(p.failureDetails) : null, id]
  );
}

export type { ResultSetHeader };
