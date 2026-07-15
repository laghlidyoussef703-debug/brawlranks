-- Phase 2: Workflow/run foundation required by the automation architecture.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 25.2 (workflow_definitions,
-- workflow_runs, workflow_steps, workflow_locks), Section 24.6 (cron design
-- / lock mechanics), Section 26.4 (generated-column unique pattern).
--
-- Scoped to Phase 2's needs only: tracking the catalog-sync workflow's
-- executions. Ranking/build/matchup/SEO publication workflow types are not
-- created by this migration.

CREATE TABLE workflow_definitions (
  id CHAR(36) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  workflow_type VARCHAR(50) NOT NULL,
  schedule VARCHAR(100) NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  retry_policy LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_workflow_definitions_slug (slug),
  KEY idx_workflow_definitions_workflow_type (workflow_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE workflow_runs (
  id CHAR(36) NOT NULL,
  workflow_definition_id CHAR(36) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  triggered_by VARCHAR(20) NOT NULL,
  triggered_by_actor VARCHAR(100) NULL,
  started_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  error_summary VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_workflow_runs_definition_id (workflow_definition_id),
  KEY idx_workflow_runs_status (status),
  KEY idx_workflow_runs_started_at (started_at),
  CONSTRAINT fk_workflow_runs_definition
    FOREIGN KEY (workflow_definition_id) REFERENCES workflow_definitions (id),
  CONSTRAINT chk_workflow_runs_status CHECK (
    status IN ('running', 'succeeded', 'succeeded_with_warnings', 'held', 'failed', 'rolled_back')
  ),
  CONSTRAINT chk_workflow_runs_triggered_by CHECK (
    triggered_by IN ('schedule', 'event', 'manual')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE workflow_steps (
  id CHAR(36) NOT NULL,
  workflow_run_id CHAR(36) NOT NULL,
  step_name VARCHAR(100) NOT NULL,
  step_order INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  started_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  output_summary LONGTEXT NULL,
  error_detail VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_workflow_steps_run_order (workflow_run_id, step_order),
  KEY idx_workflow_steps_run_id (workflow_run_id),
  CONSTRAINT fk_workflow_steps_run
    FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs (id),
  CONSTRAINT chk_workflow_steps_status CHECK (
    status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- workflow_locks: prevents overlapping executions of the same workflow.
-- "Only one active lock per workflow_definition_id" is enforced by the
-- generated-column unique pattern (Section 25 conventions / 26.4), not by
-- application logic alone: active_flag is NULL once released, so releasing
-- a lock (setting released_at) frees the unique slot for a new acquire.
CREATE TABLE workflow_locks (
  id CHAR(36) NOT NULL,
  workflow_definition_id CHAR(36) NOT NULL,
  locked_at DATETIME(3) NOT NULL,
  locked_by_run_id CHAR(36) NULL,
  expires_at DATETIME(3) NOT NULL,
  released_at DATETIME(3) NULL,
  active_flag TINYINT GENERATED ALWAYS AS (IF(released_at IS NULL, 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_workflow_locks_active (workflow_definition_id, active_flag),
  KEY idx_workflow_locks_expires_at (expires_at),
  CONSTRAINT fk_workflow_locks_definition
    FOREIGN KEY (workflow_definition_id) REFERENCES workflow_definitions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
