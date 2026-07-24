-- DATASET Phase 15: monitoring, alerts, and capacity forecasting.
-- Spec: DATASET.md Phase 15 (five-minute operational metrics + daily immutable
-- capacity snapshots + the threshold table).
--
-- STRICTLY ADDITIVE. Adds ONLY new monitoring tables; touches no operational
-- table. The monitoring collectors read operational tables read-only and write
-- ONLY these rows. All timestamps are UTC (the app writes UTC_TIMESTAMP(3)).
-- Indexes are chosen for time-range queries (captured_at / started_at) and for
-- the active-alert dedupe uniqueness.

-- 1. Immutable daily-ish capacity snapshot (one row per capture).
CREATE TABLE database_capacity_snapshots (
  id CHAR(36) NOT NULL,
  captured_at DATETIME(3) NOT NULL,
  environment VARCHAR(40) NOT NULL,
  schema_name VARCHAR(64) NOT NULL,
  total_bytes BIGINT UNSIGNED NOT NULL,
  data_bytes BIGINT UNSIGNED NOT NULL,
  index_bytes BIGINT UNSIGNED NOT NULL,
  configured_limit_bytes BIGINT UNSIGNED NULL,
  free_bytes BIGINT NULL,
  free_percent DECIMAL(7,3) NULL,
  growth_24h_bytes_per_day BIGINT NULL,
  growth_7d_bytes_per_day BIGINT NULL,
  growth_30d_bytes_per_day BIGINT NULL,
  conservative_growth_bytes_per_day BIGINT NULL,
  days_to_limit DECIMAL(14,3) NULL,
  forecast_status VARCHAR(20) NOT NULL DEFAULT 'unknown',
  collector_version VARCHAR(40) NOT NULL,
  source_metadata LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_capacity_snapshots_captured (captured_at),
  KEY idx_capacity_snapshots_env_captured (environment, captured_at),
  CONSTRAINT chk_capacity_forecast_status CHECK (forecast_status IN ('healthy','warning','critical','unknown'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Per-table sizes for a capacity snapshot.
CREATE TABLE database_table_capacity_snapshots (
  id CHAR(36) NOT NULL,
  capacity_snapshot_id CHAR(36) NOT NULL,
  schema_name VARCHAR(64) NOT NULL,
  table_name VARCHAR(64) NOT NULL,
  row_count BIGINT UNSIGNED NULL,
  data_bytes BIGINT UNSIGNED NOT NULL,
  index_bytes BIGINT UNSIGNED NOT NULL,
  total_bytes BIGINT UNSIGNED NOT NULL,
  captured_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_table_capacity_snapshot (capacity_snapshot_id),
  KEY idx_table_capacity_total (capacity_snapshot_id, total_bytes),
  CONSTRAINT fk_table_capacity_snapshot
    FOREIGN KEY (capacity_snapshot_id) REFERENCES database_capacity_snapshots (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Operational health snapshot (five-minute cadence). Every "when known"
--    metric is NULL when its evidence is unavailable — never a fabricated 0.
CREATE TABLE operational_health_snapshots (
  id CHAR(36) NOT NULL,
  captured_at DATETIME(3) NOT NULL,
  environment VARCHAR(40) NOT NULL,
  battles_last_hour INT NULL,
  battles_last_24h INT NULL,
  latest_battle_at DATETIME(3) NULL,
  latest_fetch_at DATETIME(3) NULL,
  failed_fetch_count INT NULL,
  retry_backlog_count INT NULL,
  raw_archive_pending_count INT NULL,
  raw_archive_failed_count INT NULL,
  oldest_pending_archive_age_seconds BIGINT NULL,
  oldest_failed_archive_age_seconds BIGINT NULL,
  archive_verification_failure_count INT NULL,
  raw_payload_blocked_count INT NULL,
  workflow_running_count INT NULL,
  workflow_failed_count INT NULL,
  workflow_retryable_count INT NULL,
  workflow_stalled_count INT NULL,
  expired_lock_count INT NULL,
  unreleased_lock_count INT NULL,
  oldest_active_workflow_age_seconds BIGINT NULL,
  current_published_snapshot_id CHAR(36) NULL,
  current_published_snapshot_age_seconds BIGINT NULL,
  current_published_snapshot_item_count INT NULL,
  latest_ranking_run_status VARCHAR(20) NULL,
  held_ranking_run_count INT NULL,
  backup_age_seconds BIGINT NULL,
  restore_test_age_seconds BIGINT NULL,
  active_connections INT NULL,
  max_connections INT NULL,
  connection_usage_percent DECIMAL(7,3) NULL,
  lock_wait_count INT NULL,
  long_running_query_count INT NULL,
  collector_query_latency_ms INT NULL,
  collector_status VARCHAR(20) NOT NULL DEFAULT 'ok',
  details LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_health_snapshots_captured (captured_at),
  CONSTRAINT chk_health_collector_status CHECK (collector_status IN ('ok','degraded','failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Deduplicated alerts. A generated active_flag + UNIQUE(alert_key, active_flag)
--    guarantees at most one OPEN alert per key at the database level.
CREATE TABLE operational_alerts (
  id CHAR(36) NOT NULL,
  alert_key VARCHAR(160) NOT NULL,
  alert_type VARCHAR(60) NOT NULL,
  severity VARCHAR(10) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'open',
  active_flag TINYINT GENERATED ALWAYS AS (IF(status = 'open', 1, NULL)) STORED,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  resolved_at DATETIME(3) NULL,
  occurrence_count INT NOT NULL DEFAULT 1,
  current_value VARCHAR(160) NULL,
  threshold VARCHAR(160) NULL,
  details LONGTEXT NULL,
  source_snapshot_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_alert_active (alert_key, active_flag),
  KEY idx_alerts_status_severity (status, severity),
  KEY idx_alerts_key (alert_key),
  KEY idx_alerts_last_seen (last_seen_at),
  CONSTRAINT chk_alert_severity CHECK (severity IN ('warning','critical')),
  CONSTRAINT chk_alert_status CHECK (status IN ('open','resolved','suppressed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. One row per collector/evaluator run (auditable + idempotent).
CREATE TABLE monitoring_runs (
  id CHAR(36) NOT NULL,
  run_type VARCHAR(20) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  collector_version VARCHAR(40) NOT NULL,
  capacity_snapshot_id CHAR(36) NULL,
  health_snapshot_id CHAR(36) NULL,
  warning_count INT NOT NULL DEFAULT 0,
  critical_count INT NOT NULL DEFAULT 0,
  failure_details LONGTEXT NULL,
  idempotency_key VARCHAR(160) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_monitoring_run_idempotency (idempotency_key),
  KEY idx_monitoring_runs_type_started (run_type, started_at),
  CONSTRAINT chk_monitoring_run_type CHECK (run_type IN ('snapshot','evaluate')),
  CONSTRAINT chk_monitoring_run_status CHECK (status IN ('running','succeeded','failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
