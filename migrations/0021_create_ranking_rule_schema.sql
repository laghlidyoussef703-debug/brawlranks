-- Phase 5 rule/config schema — data-volume-independent structure ONLY.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 25.2 (`ranking_rule_sets`,
-- `ranking_rule_weights`, `tier_thresholds` — key columns quoted below are
-- taken directly from that section, not invented here), Section 9
-- (Automatic Ranking Engine), Section 9.3/7.13 (tier thresholds).
--
-- Deliberately empty: no row is inserted by this migration. Section 7.28
-- ("Minimum sample size?", "Fixed vs. percentile tiers?", "Overall-mode
-- weighting model?") and Section 48 ("Exact signal weights", "Minimum
-- sample-size floor... mass-movement-guard percentage") both mark the
-- actual weight/threshold VALUES this schema would hold as explicit,
-- still-open owner decisions — never resolved anywhere in this
-- specification. Populating a real ranking_rule_sets row with fabricated
-- numbers would violate that; this migration creates only the STRUCTURE
-- Section 25.2 already fully specifies, so a future task can populate real
-- values once those owner decisions are actually made, without a schema
-- change at that point. No aggregation/ranking code in this codebase reads
-- or writes these tables yet — that remains fully out of scope.
--
-- Adaptation note: Section 25.2 specifies `ranking_rule_sets.created_by`
-- as an FK to `authors`. This codebase (Phase 1-4, automation/ingestion
-- only) never built the original CMS `authors` table — there is no admin
-- dashboard and no human-author identity system anywhere in this
-- repository, consistent with this project's explicit "no manual
-- workflow" architecture. `created_by` is therefore a plain, nullable
-- label (e.g. "system") rather than a foreign key to a table that does
-- not exist here, not a deviation from the spec's intent (every row this
-- automated system would ever create has no human author to reference).

CREATE TABLE ranking_rule_sets (
  id CHAR(36) NOT NULL,
  version INT NOT NULL,
  description VARCHAR(500) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  activated_at DATETIME(3) NULL,
  created_by VARCHAR(100) NULL,
  active_flag TINYINT GENERATED ALWAYS AS (IF(is_active = 1, 1, NULL)) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_ranking_rule_sets_version (version),
  UNIQUE KEY uniq_ranking_rule_sets_active (active_flag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per weighted signal within a rule set (Section 9.2's input
-- signals — win rate, pick rate, sample size, freshness, etc.). extra_config
-- stores free-form per-signal configuration as LONGTEXT (this schema's
-- established JSON-payload convention, migrations 0001-0020 — MySQL native
-- JSON is never used, per Section 25's conventions and this project's own
-- migrations.test.ts structural check).
CREATE TABLE ranking_rule_weights (
  id CHAR(36) NOT NULL,
  ranking_rule_set_id CHAR(36) NOT NULL,
  signal_name VARCHAR(100) NOT NULL,
  weight DECIMAL(10,6) NOT NULL,
  min_sample_size INT NULL,
  extra_config LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_ranking_rule_weights_set_signal (ranking_rule_set_id, signal_name),
  KEY idx_ranking_rule_weights_set_id (ranking_rule_set_id),
  CONSTRAINT fk_ranking_rule_weights_set
    FOREIGN KEY (ranking_rule_set_id) REFERENCES ranking_rule_sets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- mode_scope references the already-existing canonical_game_modes table
-- (migration 0010) when set; NULL means "overall" (Section 9.3/25.2:
-- "mode_scope (overall/specific game_mode_id, nullable)"). threshold_type
-- is constrained to exactly the two values Section 25.2 names
-- ("fixed"/"percentile") — not an invented vocabulary.
CREATE TABLE tier_thresholds (
  id CHAR(36) NOT NULL,
  ranking_rule_set_id CHAR(36) NOT NULL,
  mode_scope CHAR(36) NULL,
  threshold_type VARCHAR(20) NOT NULL,
  s_cutoff DECIMAL(10,4) NOT NULL,
  a_cutoff DECIMAL(10,4) NOT NULL,
  b_cutoff DECIMAL(10,4) NOT NULL,
  c_cutoff DECIMAL(10,4) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_tier_thresholds_set_scope (ranking_rule_set_id, mode_scope),
  KEY idx_tier_thresholds_set_id (ranking_rule_set_id),
  CONSTRAINT fk_tier_thresholds_set
    FOREIGN KEY (ranking_rule_set_id) REFERENCES ranking_rule_sets (id),
  CONSTRAINT fk_tier_thresholds_mode
    FOREIGN KEY (mode_scope) REFERENCES canonical_game_modes (id),
  CONSTRAINT chk_tier_thresholds_type CHECK (
    threshold_type IN ('fixed', 'percentile')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
