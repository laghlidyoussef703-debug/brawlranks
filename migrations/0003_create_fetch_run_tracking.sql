-- Phase 2: Fetch-run lifecycle tracking.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 25.2 (data_fetch_runs), Section
-- 7.21, Section 7.4 (pipeline steps this tracks).
--
-- A run must never be marked 'success' before the response is safely
-- stored, validation passes, and normalization completes for this phase's
-- scope (application-layer rule, enforced in lib/catalog/sync.ts — not
-- something the schema alone can guarantee).

CREATE TABLE data_fetch_runs (
  id CHAR(36) NOT NULL,
  data_source_id CHAR(36) NOT NULL,
  source_endpoint_id CHAR(36) NOT NULL,
  workflow_run_id CHAR(36) NULL,
  trigger_type VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  http_status INT NULL,
  attempt_count INT NOT NULL DEFAULT 1,
  started_at DATETIME(3) NOT NULL,
  fetched_at DATETIME(3) NULL,
  received_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  duration_ms INT NULL,
  schema_version VARCHAR(20) NULL,
  error_code VARCHAR(50) NULL,
  error_message VARCHAR(500) NULL,
  records_fetched INT NULL,
  changes_detected_count INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_data_fetch_runs_source_id (data_source_id),
  KEY idx_data_fetch_runs_endpoint_id (source_endpoint_id),
  KEY idx_data_fetch_runs_workflow_run_id (workflow_run_id),
  KEY idx_data_fetch_runs_status (status),
  KEY idx_data_fetch_runs_started_at (started_at),
  CONSTRAINT fk_data_fetch_runs_source
    FOREIGN KEY (data_source_id) REFERENCES data_sources (id),
  CONSTRAINT fk_data_fetch_runs_endpoint
    FOREIGN KEY (source_endpoint_id) REFERENCES source_endpoints (id),
  CONSTRAINT fk_data_fetch_runs_workflow_run
    FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs (id),
  CONSTRAINT chk_data_fetch_runs_status CHECK (
    status IN ('pending', 'running', 'success', 'partial', 'failed', 'timeout')
  ),
  CONSTRAINT chk_data_fetch_runs_trigger_type CHECK (
    trigger_type IN ('manual', 'cron', 'api')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
