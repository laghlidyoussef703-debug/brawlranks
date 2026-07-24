/**
 * DATASET Phase 15 — alert rule evaluation (PURE; no DB, no IO).
 *
 * Maps a capacity snapshot + a health snapshot to the set of alert conditions
 * currently firing. Deduplication, occurrence counting, and auto-resolution are
 * done by the repository against the persisted open alerts — this module only
 * decides WHICH conditions are true right now, so the rules stay unit-testable.
 */

import type { MonitoringThresholds } from "./thresholds";
import type { ForecastStatus } from "./capacity";

export type Severity = "warning" | "critical";

export interface DesiredAlert {
  alertKey: string;
  alertType: string;
  severity: Severity;
  currentValue: string | null;
  threshold: string | null;
  details: Record<string, unknown>;
}

export interface CapacityAlertInput {
  daysToLimit: number | null;
  freePercent: number | null;
  forecastStatus: ForecastStatus;
}

export interface HealthAlertInput {
  collectorStatus: "ok" | "degraded" | "failed";
  connectionUsagePercent: number | null;
  lockWaitCount: number | null;
  longRunningQueryCount: number | null;
  rawArchiveFailedCount: number | null;
  archiveVerificationFailureCount: number | null;
  oldestPendingArchiveAgeSeconds: number | null;
  rawArchivePendingCount: number | null;
  workflowStalledCount: number | null;
  workflowFailedCount: number | null;
  expiredLockCount: number | null;
  oldestActiveWorkflowAgeSeconds: number | null;
  currentPublishedSnapshotId: string | null;
  currentPublishedSnapshotAgeSeconds: number | null;
  currentPublishedSnapshotItemCount: number | null;
  latestRankingRunStatus: string | null;
  backupAgeSeconds: number | null;
  restoreTestAgeSeconds: number | null;
}

export interface EvaluateInput {
  capacity: CapacityAlertInput | null;
  health: HealthAlertInput | null;
  prevHealth?: { rawArchivePendingCount: number | null } | null;
  thresholds: MonitoringThresholds;
}

function alert(a: DesiredAlert): DesiredAlert { return a; }

export function evaluateAlerts(input: EvaluateInput): DesiredAlert[] {
  const { capacity, health, prevHealth, thresholds: t } = input;
  const out: DesiredAlert[] = [];

  // --- Capacity ------------------------------------------------------------
  if (capacity) {
    const { daysToLimit: d2l, freePercent: fp } = capacity;
    if (d2l !== null && Number.isFinite(d2l)) {
      if (d2l < t.daysToLimitCritical) out.push(alert({ alertKey: "capacity:days_to_limit", alertType: "capacity_days_to_limit", severity: "critical", currentValue: d2l.toFixed(1), threshold: String(t.daysToLimitCritical), details: { daysToLimit: d2l } }));
      else if (d2l < t.daysToLimitWarning) out.push(alert({ alertKey: "capacity:days_to_limit", alertType: "capacity_days_to_limit", severity: "warning", currentValue: d2l.toFixed(1), threshold: String(t.daysToLimitWarning), details: { daysToLimit: d2l } }));
    }
    if (fp !== null) {
      if (fp < t.freePercentCritical) out.push(alert({ alertKey: "capacity:free_percent", alertType: "capacity_free_percent", severity: "critical", currentValue: fp.toFixed(1), threshold: String(t.freePercentCritical), details: { freePercent: fp } }));
      else if (fp < t.freePercentWarning) out.push(alert({ alertKey: "capacity:free_percent", alertType: "capacity_free_percent", severity: "warning", currentValue: fp.toFixed(1), threshold: String(t.freePercentWarning), details: { freePercent: fp } }));
    }
  }

  if (!health) return out;
  const h = health;

  // --- Monitoring collector failure ----------------------------------------
  if (h.collectorStatus === "failed") out.push(alert({ alertKey: "monitoring:collector_failure", alertType: "monitoring_collector_failure", severity: "critical", currentValue: h.collectorStatus, threshold: "ok", details: {} }));

  // --- Database ------------------------------------------------------------
  if (h.connectionUsagePercent !== null) {
    if (h.connectionUsagePercent >= t.connectionUsageCritical) out.push(alert({ alertKey: "db:connection_usage", alertType: "db_connection_usage", severity: "critical", currentValue: h.connectionUsagePercent.toFixed(1), threshold: String(t.connectionUsageCritical), details: {} }));
    else if (h.connectionUsagePercent >= t.connectionUsageWarning) out.push(alert({ alertKey: "db:connection_usage", alertType: "db_connection_usage", severity: "warning", currentValue: h.connectionUsagePercent.toFixed(1), threshold: String(t.connectionUsageWarning), details: {} }));
  }
  if (h.lockWaitCount !== null && h.lockWaitCount > t.lockWaitWarning) out.push(alert({ alertKey: "db:lock_waits", alertType: "db_lock_waits", severity: "warning", currentValue: String(h.lockWaitCount), threshold: String(t.lockWaitWarning), details: {} }));
  if (h.longRunningQueryCount !== null && h.longRunningQueryCount > t.longRunningQueryWarning) out.push(alert({ alertKey: "db:long_running_queries", alertType: "db_long_running_queries", severity: "warning", currentValue: String(h.longRunningQueryCount), threshold: String(t.longRunningQueryWarning), details: {} }));

  // --- Archives ------------------------------------------------------------
  if ((h.archiveVerificationFailureCount ?? 0) > 0) out.push(alert({ alertKey: "archive:verification_failure", alertType: "archive_verification_failure", severity: "critical", currentValue: String(h.archiveVerificationFailureCount), threshold: "0", details: {} }));
  if ((h.rawArchiveFailedCount ?? 0) > 0) out.push(alert({ alertKey: "archive:failed", alertType: "archive_failed", severity: "warning", currentValue: String(h.rawArchiveFailedCount), threshold: "0", details: {} }));
  if (h.oldestPendingArchiveAgeSeconds !== null && h.oldestPendingArchiveAgeSeconds > t.archivePendingAgeWarningSeconds) out.push(alert({ alertKey: "archive:pending_age", alertType: "archive_pending_age", severity: "warning", currentValue: String(h.oldestPendingArchiveAgeSeconds), threshold: String(t.archivePendingAgeWarningSeconds), details: {} }));
  if (prevHealth && prevHealth.rawArchivePendingCount !== null && h.rawArchivePendingCount !== null &&
      h.rawArchivePendingCount > prevHealth.rawArchivePendingCount && h.rawArchivePendingCount > t.archivePendingCountWarning) {
    out.push(alert({ alertKey: "archive:backlog_growing", alertType: "archive_backlog_growing", severity: "warning", currentValue: String(h.rawArchivePendingCount), threshold: `> prev (${prevHealth.rawArchivePendingCount})`, details: { prev: prevHealth.rawArchivePendingCount } }));
  }

  // --- Workflows -----------------------------------------------------------
  if ((h.workflowStalledCount ?? 0) > 0) out.push(alert({ alertKey: "workflow:stalled", alertType: "workflow_stalled", severity: "warning", currentValue: String(h.workflowStalledCount), threshold: "0", details: {} }));
  if ((h.expiredLockCount ?? 0) > 0) out.push(alert({ alertKey: "workflow:expired_lock", alertType: "workflow_expired_lock", severity: "warning", currentValue: String(h.expiredLockCount), threshold: "0", details: {} }));
  if ((h.workflowFailedCount ?? 0) > 0) out.push(alert({ alertKey: "workflow:failed", alertType: "workflow_failed", severity: "warning", currentValue: String(h.workflowFailedCount), threshold: "0", details: {} }));
  if (h.oldestActiveWorkflowAgeSeconds !== null && h.oldestActiveWorkflowAgeSeconds > t.activeWorkflowAgeMinutes * 60) out.push(alert({ alertKey: "workflow:active_too_old", alertType: "workflow_active_too_old", severity: "warning", currentValue: String(h.oldestActiveWorkflowAgeSeconds), threshold: String(t.activeWorkflowAgeMinutes * 60), details: {} }));

  // --- Publishing ----------------------------------------------------------
  if (!h.currentPublishedSnapshotId) out.push(alert({ alertKey: "publishing:no_snapshot", alertType: "publishing_no_snapshot", severity: "critical", currentValue: "none", threshold: "exists", details: {} }));
  else {
    if (h.currentPublishedSnapshotItemCount === 0) out.push(alert({ alertKey: "publishing:empty_snapshot", alertType: "publishing_empty_snapshot", severity: "critical", currentValue: "0", threshold: ">0", details: {} }));
    if (h.currentPublishedSnapshotAgeSeconds !== null) {
      if (h.currentPublishedSnapshotAgeSeconds > t.snapshotStaleCriticalSeconds) out.push(alert({ alertKey: "publishing:snapshot_stale", alertType: "publishing_snapshot_stale", severity: "critical", currentValue: String(h.currentPublishedSnapshotAgeSeconds), threshold: String(t.snapshotStaleCriticalSeconds), details: {} }));
      else if (h.currentPublishedSnapshotAgeSeconds > t.snapshotStaleWarningSeconds) out.push(alert({ alertKey: "publishing:snapshot_stale", alertType: "publishing_snapshot_stale", severity: "warning", currentValue: String(h.currentPublishedSnapshotAgeSeconds), threshold: String(t.snapshotStaleWarningSeconds), details: {} }));
    }
  }
  if (h.latestRankingRunStatus === "failed" || h.latestRankingRunStatus === "held") out.push(alert({ alertKey: "publishing:ranking_run_state", alertType: "publishing_ranking_run_state", severity: "warning", currentValue: h.latestRankingRunStatus, threshold: "succeeded", details: {} }));

  // --- Backups (unknown surfaced, never falsely healthy) -------------------
  if (h.backupAgeSeconds === null) out.push(alert({ alertKey: "backup:evidence_unknown", alertType: "backup_evidence_unknown", severity: "warning", currentValue: "unknown", threshold: "known", details: {} }));
  else if (h.backupAgeSeconds > t.backupAgeCriticalSeconds) out.push(alert({ alertKey: "backup:age", alertType: "backup_age", severity: "critical", currentValue: String(h.backupAgeSeconds), threshold: String(t.backupAgeCriticalSeconds), details: {} }));
  else if (h.backupAgeSeconds > t.backupAgeWarningSeconds) out.push(alert({ alertKey: "backup:age", alertType: "backup_age", severity: "warning", currentValue: String(h.backupAgeSeconds), threshold: String(t.backupAgeWarningSeconds), details: {} }));

  if (h.restoreTestAgeSeconds === null) out.push(alert({ alertKey: "restore:evidence_unknown", alertType: "restore_evidence_unknown", severity: "warning", currentValue: "unknown", threshold: "known", details: {} }));
  else if (h.restoreTestAgeSeconds > t.restoreTestAgeCriticalSeconds) out.push(alert({ alertKey: "restore:age", alertType: "restore_test_age", severity: "critical", currentValue: String(h.restoreTestAgeSeconds), threshold: String(t.restoreTestAgeCriticalSeconds), details: {} }));
  else if (h.restoreTestAgeSeconds > t.restoreTestAgeWarningSeconds) out.push(alert({ alertKey: "restore:age", alertType: "restore_test_age", severity: "warning", currentValue: String(h.restoreTestAgeSeconds), threshold: String(t.restoreTestAgeWarningSeconds), details: {} }));

  return out;
}
