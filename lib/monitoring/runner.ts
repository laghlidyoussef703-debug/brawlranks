/**
 * DATASET Phase 15 — monitoring orchestrator.
 *
 * `runSnapshot` collects a capacity + health snapshot (read-only against
 * operational tables), computes growth/forecast, and persists them (+ per-table
 * sizes + 30/90/365 forecasts in the capacity snapshot metadata). `runEvaluate`
 * reads the latest snapshots, evaluates alert rules, and reconciles them
 * (dedupe/increment/auto-resolve). Both are idempotent via monitoring_runs'
 * idempotency key. Nothing here mutates an operational row.
 */

import type { Pool, RowDataPacket } from "mysql2/promise";
import { loadThresholds, configuredLimitBytes, MONITORING_ENVIRONMENT, COLLECTOR_VERSION, type MonitoringThresholds } from "./thresholds";
import {
  computeGrowthRates, computeFree, daysToLimit, forecastStatus, forecast, historySpanDays, type CapacityPoint, type Forecast,
} from "./capacity";
import { evaluateAlerts, type DesiredAlert, type CapacityAlertInput, type HealthAlertInput } from "./alerts";
import { planCapacityResponse, type CapacityResponsePlan } from "./responsePlan";
import * as repo from "./repository";

const HORIZONS = [30, 90, 365];

export interface SnapshotResult {
  runId: string; idempotent: boolean;
  capacitySnapshotId: string | null; healthSnapshotId: string | null;
  capacity: { totalBytes: number; freeBytes: number | null; freePercent: number | null; daysToLimit: number | null; forecastStatus: string };
  forecasts: Forecast[];
  collectorStatus: string;
}

export async function runSnapshot(db: Pool, opts: { idempotencyKey?: string | null; now?: Date } = {}): Promise<SnapshotResult> {
  const t = loadThresholds();
  const now = opts.now ?? new Date();
  const run = await repo.startMonitoringRun(db, "snapshot", COLLECTOR_VERSION, opts.idempotencyKey ?? null);
  if (run.alreadyExisted) {
    const row = run.existingRow!;
    return {
      runId: run.id, idempotent: true,
      capacitySnapshotId: row.capacity_snapshot_id ?? null, healthSnapshotId: row.health_snapshot_id ?? null,
      capacity: { totalBytes: 0, freeBytes: null, freePercent: null, daysToLimit: null, forecastStatus: "unknown" },
      forecasts: [], collectorStatus: "idempotent_noop",
    };
  }
  try {
    const cap = await repo.collectCapacityRaw(db);
    const history = await repo.readCapacityHistory(db, MONITORING_ENVIRONMENT, cap.schemaName);
    const current: CapacityPoint = { capturedAt: now, totalBytes: cap.totalBytes };
    const rates = computeGrowthRates(history, current);
    const limit = configuredLimitBytes();
    const { freeBytes, freePercent } = computeFree(cap.totalBytes, limit);
    const d2l = daysToLimit(freeBytes, rates.conservativeBytesPerDay);
    const status = forecastStatus(d2l, freePercent, t);

    const spanDays = historySpanDays(history, now);
    const forecasts = HORIZONS.map((horizonDays) => forecast({
      now, currentTotalBytes: cap.totalBytes, limitBytes: limit,
      conservativeBytesPerDay: rates.conservativeBytesPerDay, horizonDays,
      snapshotCount: history.length + 1, spanDays, thresholds: t,
    }));

    const capacityId = await repo.insertCapacitySnapshot(db, {
      environment: MONITORING_ENVIRONMENT, schemaName: cap.schemaName, totalBytes: cap.totalBytes, dataBytes: cap.dataBytes, indexBytes: cap.indexBytes,
      configuredLimitBytes: limit, freeBytes, freePercent, growth24h: rates.growth24hBytesPerDay, growth7d: rates.growth7dBytesPerDay,
      growth30d: rates.growth30dBytesPerDay, conservative: rates.conservativeBytesPerDay, daysToLimit: d2l, forecastStatus: status,
      collectorVersion: COLLECTOR_VERSION, sourceMetadata: { forecasts, rates, spanDays, snapshotCount: history.length + 1 }, capturedAt: now,
    }, cap.tables);

    const health = await repo.collectHealthRaw(db, t);
    const healthId = await repo.insertHealthSnapshot(db, MONITORING_ENVIRONMENT, now, health);

    await repo.completeMonitoringRun(db, run.id, { status: "succeeded", capacitySnapshotId: capacityId, healthSnapshotId: healthId });
    return {
      runId: run.id, idempotent: false, capacitySnapshotId: capacityId, healthSnapshotId: healthId,
      capacity: { totalBytes: cap.totalBytes, freeBytes, freePercent, daysToLimit: d2l === Infinity ? null : d2l, forecastStatus: status },
      forecasts, collectorStatus: health.collectorStatus,
    };
  } catch (error) {
    await repo.completeMonitoringRun(db, run.id, { status: "failed", failureDetails: { message: error instanceof Error ? error.message : "unknown" } }).catch(() => {});
    throw error;
  }
}

function capacityAlertInput(cap: RowDataPacket | null): CapacityAlertInput | null {
  if (!cap) return null;
  return {
    daysToLimit: cap.days_to_limit === null ? null : Number(cap.days_to_limit),
    freePercent: cap.free_percent === null ? null : Number(cap.free_percent),
    forecastStatus: cap.forecast_status,
  };
}

function healthAlertInput(h: RowDataPacket | null): HealthAlertInput | null {
  if (!h) return null;
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    collectorStatus: h.collector_status,
    connectionUsagePercent: n(h.connection_usage_percent),
    lockWaitCount: n(h.lock_wait_count),
    longRunningQueryCount: n(h.long_running_query_count),
    rawArchiveFailedCount: n(h.raw_archive_failed_count),
    archiveVerificationFailureCount: n(h.archive_verification_failure_count),
    oldestPendingArchiveAgeSeconds: n(h.oldest_pending_archive_age_seconds),
    rawArchivePendingCount: n(h.raw_archive_pending_count),
    workflowStalledCount: n(h.workflow_stalled_count),
    workflowFailedCount: n(h.workflow_failed_count),
    expiredLockCount: n(h.expired_lock_count),
    oldestActiveWorkflowAgeSeconds: n(h.oldest_active_workflow_age_seconds),
    currentPublishedSnapshotId: h.current_published_snapshot_id ?? null,
    currentPublishedSnapshotAgeSeconds: n(h.current_published_snapshot_age_seconds),
    currentPublishedSnapshotItemCount: n(h.current_published_snapshot_item_count),
    latestRankingRunStatus: h.latest_ranking_run_status ?? null,
    backupAgeSeconds: n(h.backup_age_seconds),
    restoreTestAgeSeconds: n(h.restore_test_age_seconds),
  };
}

export interface EvaluateResult {
  runId: string; idempotent: boolean; dryRun: boolean;
  desired: DesiredAlert[];
  reconcile: repo.ReconcileResult | null;
  responsePlan: CapacityResponsePlan;
}

export async function runEvaluate(db: Pool, opts: { idempotencyKey?: string | null; dryRun?: boolean; now?: Date } = {}): Promise<EvaluateResult> {
  const t: MonitoringThresholds = loadThresholds();
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const run = await repo.startMonitoringRun(db, "evaluate", COLLECTOR_VERSION, opts.idempotencyKey ?? null);
  if (run.alreadyExisted) {
    return { runId: run.id, idempotent: true, dryRun, desired: [], reconcile: null, responsePlan: planCapacityResponse("unknown") };
  }
  try {
    const cap = await repo.getLatestCapacitySnapshot(db);
    const healthRows = await repo.getLatestHealthSnapshots(db, 2);
    const capInput = capacityAlertInput(cap);
    const healthInput = healthAlertInput(healthRows[0] ?? null);
    const prevHealth = healthRows[1] ? { rawArchivePendingCount: healthRows[1].raw_archive_pending_count === null ? null : Number(healthRows[1].raw_archive_pending_count) } : null;

    const desired = evaluateAlerts({ capacity: capInput, health: healthInput, prevHealth, thresholds: t });
    const responsePlan = planCapacityResponse((cap?.forecast_status as CapacityResponsePlan["level"]) ?? "unknown");

    if (dryRun) {
      await repo.completeMonitoringRun(db, run.id, { status: "succeeded", warningCount: desired.filter((d) => d.severity === "warning").length, criticalCount: desired.filter((d) => d.severity === "critical").length });
      return { runId: run.id, idempotent: false, dryRun: true, desired, reconcile: null, responsePlan };
    }

    const reconcile = await repo.reconcileAlerts(db, desired, healthRows[0]?.id ?? cap?.id ?? null, now);
    await repo.completeMonitoringRun(db, run.id, { status: "succeeded", capacitySnapshotId: cap?.id ?? null, healthSnapshotId: healthRows[0]?.id ?? null, warningCount: reconcile.warningCount, criticalCount: reconcile.criticalCount });
    return { runId: run.id, idempotent: false, dryRun: false, desired, reconcile, responsePlan };
  } catch (error) {
    await repo.completeMonitoringRun(db, run.id, { status: "failed", failureDetails: { message: error instanceof Error ? error.message : "unknown" } }).catch(() => {});
    throw error;
  }
}

// --- Read summaries for the GET routes (no writes) --------------------------

export async function readCapacitySummary(db: Pool): Promise<unknown> {
  const cap = await repo.getLatestCapacitySnapshot(db);
  if (!cap) return { ok: true, capacity: null, forecasts: [] };
  const meta = safeJson(cap.source_metadata);
  return {
    ok: true,
    capacity: {
      capturedAt: toIso(cap.captured_at), environment: cap.environment, totalBytes: Number(cap.total_bytes), dataBytes: Number(cap.data_bytes), indexBytes: Number(cap.index_bytes),
      configuredLimitBytes: cap.configured_limit_bytes === null ? null : Number(cap.configured_limit_bytes),
      freeBytes: cap.free_bytes === null ? null : Number(cap.free_bytes), freePercent: cap.free_percent === null ? null : Number(cap.free_percent),
      growth7dBytesPerDay: cap.growth_7d_bytes_per_day === null ? null : Number(cap.growth_7d_bytes_per_day),
      conservativeBytesPerDay: cap.conservative_growth_bytes_per_day === null ? null : Number(cap.conservative_growth_bytes_per_day),
      daysToLimit: cap.days_to_limit === null ? null : Number(cap.days_to_limit), forecastStatus: cap.forecast_status,
    },
    forecasts: (meta as { forecasts?: unknown }).forecasts ?? [],
  };
}

export async function readHealthSummary(db: Pool): Promise<unknown> {
  const rows = await repo.getLatestHealthSnapshots(db, 1);
  const h = rows[0];
  if (!h) return { ok: true, health: null };
  const { id, ...rest } = h;
  return { ok: true, health: { snapshotId: id, ...redactHealth(rest) } };
}

export async function readAlerts(db: Pool): Promise<unknown> {
  const open = await repo.getOpenAlerts(db);
  return {
    ok: true,
    open: open.map((a) => ({
      alertKey: a.alert_key, alertType: a.alert_type, severity: a.severity, status: a.status,
      firstSeenAt: toIso(a.first_seen_at), lastSeenAt: toIso(a.last_seen_at), occurrenceCount: Number(a.occurrence_count),
      currentValue: a.current_value, threshold: a.threshold,
    })),
    counts: { open: open.length, warning: open.filter((a) => a.severity === "warning").length, critical: open.filter((a) => a.severity === "critical").length },
  };
}

function toIso(v: unknown): string | null { return v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v); }
function safeJson(v: unknown): unknown { if (typeof v !== "string") return v ?? {}; try { return JSON.parse(v); } catch { return {}; } }
/** Health rows contain only safe operational metadata already; convert Dates and pass through. */
function redactHealth(h: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}
