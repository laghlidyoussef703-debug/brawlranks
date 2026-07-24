/**
 * DATASET Phase 15 — configurable monitoring thresholds with SAFE defaults.
 *
 * Every threshold is overridable via an env var, but the defaults are the
 * conservative values from the task spec / DATASET Phase 15 table. Nothing here
 * has any side effect — it only reads env once into a frozen object.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export interface MonitoringThresholds {
  // Capacity
  daysToLimitWarning: number;
  daysToLimitCritical: number;
  freePercentWarning: number;
  freePercentCritical: number;
  // Connections
  connectionUsageWarning: number; // percent
  connectionUsageCritical: number;
  // Locks / queries
  lockWaitWarning: number;
  longRunningQueryWarning: number;
  // Archive
  archivePendingAgeWarningSeconds: number;
  archivePendingCountWarning: number;
  // Workflows
  workflowStalledMinutes: number;
  activeWorkflowAgeMinutes: number;
  // Publishing
  snapshotStaleWarningSeconds: number;
  snapshotStaleCriticalSeconds: number;
  // Backups
  backupAgeWarningSeconds: number;
  backupAgeCriticalSeconds: number;
  restoreTestAgeWarningSeconds: number;
  restoreTestAgeCriticalSeconds: number;
  // Forecast history sufficiency
  minForecastSnapshots: number;
  minForecastSpanDays: number;
}

const HOUR = 3600;
const DAY = 86_400;

export function loadThresholds(): MonitoringThresholds {
  return Object.freeze({
    daysToLimitWarning: num("MON_DAYS_TO_LIMIT_WARNING", 45),
    daysToLimitCritical: num("MON_DAYS_TO_LIMIT_CRITICAL", 30),
    freePercentWarning: num("MON_FREE_PERCENT_WARNING", 30),
    freePercentCritical: num("MON_FREE_PERCENT_CRITICAL", 20),
    connectionUsageWarning: num("MON_CONN_USAGE_WARNING", 75),
    connectionUsageCritical: num("MON_CONN_USAGE_CRITICAL", 90),
    lockWaitWarning: num("MON_LOCK_WAIT_WARNING", 5),
    longRunningQueryWarning: num("MON_LONG_QUERY_WARNING", 3),
    archivePendingAgeWarningSeconds: num("MON_ARCHIVE_PENDING_AGE_WARNING_S", HOUR),
    archivePendingCountWarning: num("MON_ARCHIVE_PENDING_COUNT_WARNING", 5000),
    workflowStalledMinutes: num("MON_WORKFLOW_STALLED_MINUTES", 15),
    activeWorkflowAgeMinutes: num("MON_ACTIVE_WORKFLOW_AGE_MINUTES", 15),
    snapshotStaleWarningSeconds: num("MON_SNAPSHOT_STALE_WARNING_S", 48 * HOUR),
    snapshotStaleCriticalSeconds: num("MON_SNAPSHOT_STALE_CRITICAL_S", 96 * HOUR),
    backupAgeWarningSeconds: num("MON_BACKUP_AGE_WARNING_S", 26 * HOUR),
    backupAgeCriticalSeconds: num("MON_BACKUP_AGE_CRITICAL_S", 36 * HOUR),
    restoreTestAgeWarningSeconds: num("MON_RESTORE_TEST_AGE_WARNING_S", 35 * DAY),
    restoreTestAgeCriticalSeconds: num("MON_RESTORE_TEST_AGE_CRITICAL_S", 45 * DAY),
    minForecastSnapshots: num("MON_MIN_FORECAST_SNAPSHOTS", 2),
    minForecastSpanDays: num("MON_MIN_FORECAST_SPAN_DAYS", 1),
  });
}

/** Configured DigitalOcean storage limit in bytes, if the operator provided it. */
export function configuredLimitBytes(): number | null {
  const raw = process.env.MON_DB_CAPACITY_LIMIT_BYTES;
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export const MONITORING_ENVIRONMENT = process.env.MON_ENVIRONMENT ?? "digitalocean";
export const COLLECTOR_VERSION = "phase15-monitoring/v1";
