-- Phase 3: Player crawl scheduling — drives battle-log collection ordering.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.3 (re-crawl priority), Section
-- 7.4 (due-player selection), Section 7.21 (player_crawl_schedule), Section
-- 7.23 (rate-limit-aware batch selection), Section 24.6 (lease pattern via
-- SELECT ... FOR UPDATE, the MariaDB-appropriate replacement for a
-- Postgres advisory lock).
--
-- Due-player selection reads this table with `SELECT ... FOR UPDATE SKIP
-- LOCKED`-style batch acquisition (lib/ingestion/crawlSchedule.ts) so two
-- concurrent crawl-batch workers can never select the same player — the
-- lease fields (leased_by_run_id/lease_expires_at) are the mechanism, not
-- just the FOR UPDATE lock itself, so a lease also survives across the
-- short lock-hold window of the selecting transaction.

CREATE TABLE player_crawl_schedule (
  id CHAR(36) NOT NULL,
  player_tag VARCHAR(20) NOT NULL,
  priority_score DECIMAL(10, 4) NOT NULL DEFAULT 0,
  next_due_at DATETIME(3) NOT NULL,
  last_crawled_at DATETIME(3) NULL,
  consecutive_failure_count INT NOT NULL DEFAULT 0,
  backoff_until DATETIME(3) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  region VARCHAR(10) NULL,
  trophy_bracket VARCHAR(20) NULL,
  stratum_source VARCHAR(20) NULL,
  leased_by_run_id CHAR(36) NULL,
  lease_expires_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_player_crawl_schedule_tag (player_tag),
  KEY idx_player_crawl_schedule_due (is_active, next_due_at),
  KEY idx_player_crawl_schedule_lease (lease_expires_at),
  KEY idx_player_crawl_schedule_backoff (backoff_until),
  KEY idx_player_crawl_schedule_priority (is_active, priority_score)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A player exceeding the configured maximum-consecutive-failure policy
-- (lib/ingestion/retry.ts) is set is_active = 0 rather than deleted —
-- historical battle contributions already collected remain valid (Section
-- 7.3's "inactive, not deleted" rule) and the row can be reactivated if the
-- tag becomes reachable again.
