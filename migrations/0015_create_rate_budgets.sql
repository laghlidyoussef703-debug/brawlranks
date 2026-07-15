-- Phase 3: Rate-limit budget state.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.23 (rate-limit budget model —
-- per-endpoint ceiling, daily budget, emergency reserve, stop conditions).
--
-- One row per named budget scope, combining live-counter state with its
-- configured ceiling in a single table — deliberately not per-endpoint
-- infrastructure (no Redis, no external queue service; this task's rules
-- prohibit introducing one without a verified MariaDB blocker, and a
-- simple atomic UPDATE-based counter satisfies the requirement, see
-- lib/ingestion/rateBudget.ts).
--
-- The exact numeric ceilings seeded here are CONSERVATIVE, CONFIGURED
-- DEFAULTS, not verified official API limits — the real limits were not
-- independently confirmed this session (no live proxy access). This is
-- stated plainly in PHASE3.md and must not be read as a measured fact.

CREATE TABLE ingestion_rate_budgets (
  id CHAR(36) NOT NULL,
  budget_scope VARCHAR(30) NOT NULL,
  window_started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  window_seconds INT NOT NULL,
  request_ceiling INT NOT NULL,
  reserved_for_priority INT NOT NULL DEFAULT 0,
  requests_used INT NOT NULL DEFAULT 0,
  last_429_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_ingestion_rate_budgets_scope (budget_scope),
  CONSTRAINT chk_ingestion_rate_budgets_scope CHECK (
    budget_scope IN (
      'global_daily', 'catalog', 'rankings', 'player_profile',
      'battle_log', 'club'
    )
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- reserved_for_priority holds back N slots of request_ceiling exclusively
-- for the catalog/health-check callers (Section 7.23's "emergency
-- reserve") — enforced in lib/ingestion/rateBudget.ts by checking against
-- (request_ceiling - reserved_for_priority) for non-priority callers and
-- request_ceiling for priority callers. Consumption is a single atomic
-- `UPDATE ... SET requests_used = requests_used + 1 WHERE budget_scope = ?
-- AND requests_used < <limit>` — MySQL's row-level UPDATE is itself
-- atomic, so no separate lock is needed for the increment.

CREATE TABLE crawl_batches (
  id CHAR(36) NOT NULL,
  workflow_run_id CHAR(36) NOT NULL,
  batch_type VARCHAR(20) NOT NULL,
  requested_size INT NOT NULL,
  selected_count INT NOT NULL DEFAULT 0,
  succeeded_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_crawl_batches_workflow_run_id (workflow_run_id),
  KEY idx_crawl_batches_type_started (batch_type, started_at),
  CONSTRAINT fk_crawl_batches_workflow_run
    FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs (id),
  CONSTRAINT chk_crawl_batches_type CHECK (
    batch_type IN ('player_discovery', 'battle_log', 'ranking_seed', 'club_expansion')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
