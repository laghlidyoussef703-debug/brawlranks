-- Phase 5.3: ranking calculation + publication snapshot schema.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 9 (Automatic Ranking Engine),
-- Section 11 (Matchups), Section 13 (Quality Gates), Section 25.2
-- (ranking_calculations/publication_runs family), Section 26 (Publication
-- Snapshot Model — the generated-column current-pointer pattern, same as
-- workflow_locks/patches/ranking_rule_sets).
--
-- `ranking_results`/`matchup_results` are the CANDIDATE/working layer
-- (Section 7.5 layer C) — every ranking run's full output, published or
-- not, kept for reproducibility (Section 9.8). `published_snapshots`/
-- `published_snapshot_items`/`published_matchup_items` are layer D — the
-- only tables any public read path may ever query (Section 7.25's hard
-- rule). A ranking_results/matchup_results row that never clears its
-- quality gate simply never gets a corresponding published_snapshot_items
-- row — there is no separate "candidate_snapshots" table, since a
-- candidate that fails to publish is already fully represented by its
-- ranking_run's status ('held'/'failed') and its (unpublished)
-- ranking_results rows.
--
-- Published item tables denormalize `patch_version_label` as a plain
-- string (not a patch_id FK) deliberately: a published snapshot must
-- remain byte-for-byte immutable even if the `patches` table is later
-- pruned/changed — Section 26.2's immutability guarantee.

CREATE TABLE ranking_runs (
  id CHAR(36) NOT NULL,
  workflow_run_id CHAR(36) NOT NULL,
  ranking_rule_set_id CHAR(36) NOT NULL,
  mode_aggregation_run_id CHAR(36) NOT NULL,
  overall_aggregation_run_id CHAR(36) NOT NULL,
  matchup_aggregation_run_id CHAR(36) NOT NULL,
  patch_id CHAR(36) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  hold_reason VARCHAR(100) NULL,
  tier_move_ratio DECIMAL(6,5) NULL,
  brawlers_evaluated INT NULL,
  brawlers_published INT NULL,
  started_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ranking_runs_workflow_run_id (workflow_run_id),
  KEY idx_ranking_runs_started_at (started_at),
  CONSTRAINT fk_ranking_runs_workflow_run
    FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs (id),
  CONSTRAINT fk_ranking_runs_rule_set
    FOREIGN KEY (ranking_rule_set_id) REFERENCES ranking_rule_sets (id),
  CONSTRAINT fk_ranking_runs_mode_agg
    FOREIGN KEY (mode_aggregation_run_id) REFERENCES aggregation_runs (id),
  CONSTRAINT fk_ranking_runs_overall_agg
    FOREIGN KEY (overall_aggregation_run_id) REFERENCES aggregation_runs (id),
  CONSTRAINT fk_ranking_runs_matchup_agg
    FOREIGN KEY (matchup_aggregation_run_id) REFERENCES aggregation_runs (id),
  CONSTRAINT fk_ranking_runs_patch
    FOREIGN KEY (patch_id) REFERENCES patches (id),
  CONSTRAINT chk_ranking_runs_status CHECK (
    status IN ('running', 'succeeded', 'held', 'failed')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (brawler, mode nullable=overall) per ranking_run — the full
-- candidate output, append-only, whether or not it ends up published.
CREATE TABLE ranking_results (
  id CHAR(36) NOT NULL,
  ranking_run_id CHAR(36) NOT NULL,
  brawler_id CHAR(36) NOT NULL,
  game_mode_id CHAR(36) NULL,
  matches INT NOT NULL,
  win_rate DECIMAL(6,5) NULL,
  pick_rate DECIMAL(6,5) NULL,
  high_rank_win_rate DECIMAL(6,5) NULL,
  matchup_coverage DECIMAL(6,5) NULL,
  meta_score DECIMAL(6,2) NULL,
  tier VARCHAR(1) NULL,
  confidence VARCHAR(20) NOT NULL,
  meets_floor TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_ranking_results_scope (ranking_run_id, brawler_id, game_mode_id),
  KEY idx_ranking_results_brawler (brawler_id, game_mode_id),
  CONSTRAINT fk_ranking_results_run
    FOREIGN KEY (ranking_run_id) REFERENCES ranking_runs (id),
  CONSTRAINT fk_ranking_results_brawler
    FOREIGN KEY (brawler_id) REFERENCES canonical_brawlers (id),
  CONSTRAINT fk_ranking_results_mode
    FOREIGN KEY (game_mode_id) REFERENCES canonical_game_modes (id),
  CONSTRAINT chk_ranking_results_tier CHECK (
    tier IS NULL OR tier IN ('S', 'A', 'B', 'C', 'D')
  ),
  CONSTRAINT chk_ranking_results_confidence CHECK (
    confidence IN ('insufficient', 'low', 'medium', 'high')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per ordered (brawler, opponent, mode nullable) per ranking_run —
-- the classified candidate matchup output, pooled across whatever
-- patch_id groups exist in matchup_aggregates for that pair.
CREATE TABLE matchup_results (
  id CHAR(36) NOT NULL,
  ranking_run_id CHAR(36) NOT NULL,
  brawler_id CHAR(36) NOT NULL,
  opponent_brawler_id CHAR(36) NOT NULL,
  game_mode_id CHAR(36) NULL,
  matches INT NOT NULL,
  win_rate DECIMAL(6,5) NULL,
  relationship VARCHAR(20) NULL,
  confidence_level VARCHAR(30) NOT NULL,
  meets_floor TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_matchup_results_scope (ranking_run_id, brawler_id, opponent_brawler_id, game_mode_id),
  KEY idx_matchup_results_brawler (brawler_id, opponent_brawler_id),
  CONSTRAINT fk_matchup_results_run
    FOREIGN KEY (ranking_run_id) REFERENCES ranking_runs (id),
  CONSTRAINT fk_matchup_results_brawler
    FOREIGN KEY (brawler_id) REFERENCES canonical_brawlers (id),
  CONSTRAINT fk_matchup_results_opponent
    FOREIGN KEY (opponent_brawler_id) REFERENCES canonical_brawlers (id),
  CONSTRAINT fk_matchup_results_mode
    FOREIGN KEY (game_mode_id) REFERENCES canonical_game_modes (id),
  CONSTRAINT chk_matchup_results_distinct CHECK (brawler_id <> opponent_brawler_id),
  CONSTRAINT chk_matchup_results_relationship CHECK (
    relationship IS NULL OR relationship IN ('hard_counter', 'counter', 'neutral', 'strong', 'hard_advantage')
  ),
  CONSTRAINT chk_matchup_results_confidence CHECK (
    confidence_level IN ('insufficient', 'weak_signal', 'probable_counter', 'high_confidence_counter')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Exactly one row may ever have is_current = 1 (the generated-column
-- pattern already used by workflow_locks/patches/ranking_rule_sets,
-- Section 26.4). A single combined snapshot scope (the whole site's
-- current tier list + matchups) — no per-mode/per-scope split, since a
-- Brawler's mode tiers are nested inside its own published_snapshot_items
-- row (Section 26.2's "all consistent... publish together" atomicity).
CREATE TABLE published_snapshots (
  id CHAR(36) NOT NULL,
  ranking_run_id CHAR(36) NOT NULL,
  patch_id CHAR(36) NULL,
  is_current TINYINT(1) NOT NULL DEFAULT 1,
  current_flag TINYINT GENERATED ALWAYS AS (IF(is_current = 1, 1, NULL)) STORED,
  published_at DATETIME(3) NOT NULL,
  superseded_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_published_snapshots_ranking_run (ranking_run_id),
  UNIQUE KEY uniq_published_snapshots_current (current_flag),
  CONSTRAINT fk_published_snapshots_run
    FOREIGN KEY (ranking_run_id) REFERENCES ranking_runs (id),
  CONSTRAINT fk_published_snapshots_patch
    FOREIGN KEY (patch_id) REFERENCES patches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The exact public per-Brawler contract (Section 7.25). Build/AI fields
-- are deliberately absent as columns, not just unpopulated — there is no
-- usage data or AI layer to back them (see PHASE5.3 report).
CREATE TABLE published_snapshot_items (
  id CHAR(36) NOT NULL,
  published_snapshot_id CHAR(36) NOT NULL,
  brawler_id CHAR(36) NOT NULL,
  overall_tier VARCHAR(1) NOT NULL,
  overall_score DECIMAL(6,2) NOT NULL,
  overall_confidence VARCHAR(20) NOT NULL,
  mode_tiers LONGTEXT NOT NULL,
  patch_version_label VARCHAR(64) NULL,
  calculated_at DATETIME(3) NOT NULL,
  published_at DATETIME(3) NOT NULL,
  data_limitations LONGTEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_published_snapshot_items_brawler (published_snapshot_id, brawler_id),
  KEY idx_published_snapshot_items_snapshot (published_snapshot_id),
  CONSTRAINT fk_published_snapshot_items_snapshot
    FOREIGN KEY (published_snapshot_id) REFERENCES published_snapshots (id),
  CONSTRAINT fk_published_snapshot_items_brawler
    FOREIGN KEY (brawler_id) REFERENCES canonical_brawlers (id),
  CONSTRAINT chk_published_snapshot_items_tier CHECK (
    overall_tier IN ('S', 'A', 'B', 'C', 'D')
  ),
  CONSTRAINT chk_published_snapshot_items_confidence CHECK (
    overall_confidence IN ('low', 'medium', 'high')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE published_matchup_items (
  id CHAR(36) NOT NULL,
  published_snapshot_id CHAR(36) NOT NULL,
  brawler_id CHAR(36) NOT NULL,
  opponent_brawler_id CHAR(36) NOT NULL,
  relationship VARCHAR(20) NOT NULL,
  confidence_level VARCHAR(30) NOT NULL,
  win_rate DECIMAL(6,5) NOT NULL,
  sample_size INT NOT NULL,
  game_mode_id CHAR(36) NULL,
  patch_version_label VARCHAR(64) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_published_matchup_items_pair (published_snapshot_id, brawler_id, opponent_brawler_id, game_mode_id),
  KEY idx_published_matchup_items_brawler (published_snapshot_id, brawler_id),
  CONSTRAINT fk_published_matchup_items_snapshot
    FOREIGN KEY (published_snapshot_id) REFERENCES published_snapshots (id),
  CONSTRAINT fk_published_matchup_items_brawler
    FOREIGN KEY (brawler_id) REFERENCES canonical_brawlers (id),
  CONSTRAINT fk_published_matchup_items_opponent
    FOREIGN KEY (opponent_brawler_id) REFERENCES canonical_brawlers (id),
  CONSTRAINT fk_published_matchup_items_mode
    FOREIGN KEY (game_mode_id) REFERENCES canonical_game_modes (id),
  CONSTRAINT chk_published_matchup_items_distinct CHECK (brawler_id <> opponent_brawler_id),
  CONSTRAINT chk_published_matchup_items_relationship CHECK (
    relationship IN ('hard_counter', 'counter', 'neutral', 'strong', 'hard_advantage')
  ),
  CONSTRAINT chk_published_matchup_items_confidence CHECK (
    confidence_level IN ('probable_counter', 'high_confidence_counter')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
