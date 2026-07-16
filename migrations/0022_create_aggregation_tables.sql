-- Phase 5.2: Statistical aggregation layer.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.8 (Statistical Aggregation —
-- every column below traces to a named row/field in that section's metric
-- table), Section 7.21/25.2 (aggregation_runs, brawler_mode_aggregates,
-- brawler_overall_aggregates, matchup_aggregates).
--
-- IMPORTANT SCOPE NOTE (read before assuming this is the full ranking
-- pipeline): only the metrics Section 7.8 defines with a concrete,
-- unambiguous formula and no outstanding owner decision are computed by
-- the code that writes to these tables (lib/aggregation/*) — match count,
-- win count, loss count, draw count, win rate (wins / (wins + losses)),
-- and matchup win rate between opposing-team Brawlers. Pick rate,
-- confidence scores, tier assignment, and matchup relationship
-- classification are NOT computed this phase: Section 7.28/48 leave the
-- pick-rate formula, minimum sample-size floors, tier-threshold model, and
-- ranking-engine signal weights explicitly "Unresolved" — populating those
-- would mean fabricating numbers this specification deliberately does not
-- supply. Columns whose value depends on one of those unresolved
-- decisions (pick_rate, rank_bracket_breakdown, region_breakdown,
-- data_maturity_stage, confidence_level) are still included, matching
-- Section 25.2's schema exactly, but are always NULL until that decision
-- is made and a future phase populates them — the same "schema now,
-- values later" pattern already used for ranking_rule_sets/
-- ranking_rule_weights/tier_thresholds in migration 0021.
--
-- JSON-shaped columns are LONGTEXT, not MySQL's native JSON type, matching
-- this schema's established convention (Section 25's conventions;
-- tests/migrations.test.ts structurally rejects a bare JSON column).

CREATE TABLE aggregation_runs (
  id CHAR(36) NOT NULL,
  workflow_run_id CHAR(36) NOT NULL,
  scope VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  brawlers_processed INT NULL,
  started_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_aggregation_runs_workflow_run_id (workflow_run_id),
  KEY idx_aggregation_runs_started_at (started_at),
  CONSTRAINT fk_aggregation_runs_workflow_run
    FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs (id),
  CONSTRAINT chk_aggregation_runs_scope CHECK (
    scope IN ('overall', 'per_mode', 'matchup')
  ),
  CONSTRAINT chk_aggregation_runs_status CHECK (
    status IN ('running', 'succeeded', 'succeeded_with_warnings', 'failed')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per (brawler, game_mode, patch) — patch_id is nullable and groups
-- naturally with whatever real data exists: battles collected before
-- Phase 5.1 (or before any patch was ever inferred) aggregate into a
-- patch_id = NULL row rather than being discarded, so this phase's real
-- accumulated dataset is not thrown away just because most of it predates
-- patch tracking.
CREATE TABLE brawler_mode_aggregates (
  id CHAR(36) NOT NULL,
  aggregation_run_id CHAR(36) NOT NULL,
  brawler_id CHAR(36) NOT NULL,
  game_mode_id CHAR(36) NOT NULL,
  patch_id CHAR(36) NULL,
  matches INT NOT NULL,
  wins INT NOT NULL,
  losses INT NOT NULL,
  draws INT NOT NULL,
  win_rate DECIMAL(6,5) NULL,
  pick_rate DECIMAL(6,5) NULL,
  rank_bracket_breakdown LONGTEXT NULL,
  region_breakdown LONGTEXT NULL,
  data_maturity_stage VARCHAR(20) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_brawler_mode_aggregates_scope (brawler_id, game_mode_id, patch_id, aggregation_run_id),
  KEY idx_brawler_mode_aggregates_lookup (brawler_id, game_mode_id, patch_id),
  KEY idx_brawler_mode_aggregates_run_id (aggregation_run_id),
  CONSTRAINT fk_brawler_mode_aggregates_run
    FOREIGN KEY (aggregation_run_id) REFERENCES aggregation_runs (id),
  CONSTRAINT fk_brawler_mode_aggregates_brawler
    FOREIGN KEY (brawler_id) REFERENCES canonical_brawlers (id),
  CONSTRAINT fk_brawler_mode_aggregates_mode
    FOREIGN KEY (game_mode_id) REFERENCES canonical_game_modes (id),
  CONSTRAINT fk_brawler_mode_aggregates_patch
    FOREIGN KEY (patch_id) REFERENCES patches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per (brawler, patch) across every mode combined. mode_coverage_count is
-- the real, spec-named column (Section 25.2: "plus mode_coverage_count and
-- the per-mode weighting breakdown used to compose it") — only the count
-- itself (a plain COUNT(DISTINCT game_mode_id), no weighting decision
-- needed) is populated; the weighting breakdown depends on the unresolved
-- overall-vs-mode weighting model (Section 7.12/7.28) and is therefore not
-- a column here yet.
CREATE TABLE brawler_overall_aggregates (
  id CHAR(36) NOT NULL,
  aggregation_run_id CHAR(36) NOT NULL,
  brawler_id CHAR(36) NOT NULL,
  patch_id CHAR(36) NULL,
  matches INT NOT NULL,
  wins INT NOT NULL,
  losses INT NOT NULL,
  draws INT NOT NULL,
  win_rate DECIMAL(6,5) NULL,
  mode_coverage_count INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_brawler_overall_aggregates_scope (brawler_id, patch_id, aggregation_run_id),
  KEY idx_brawler_overall_aggregates_lookup (brawler_id, patch_id),
  KEY idx_brawler_overall_aggregates_run_id (aggregation_run_id),
  CONSTRAINT fk_brawler_overall_aggregates_run
    FOREIGN KEY (aggregation_run_id) REFERENCES aggregation_runs (id),
  CONSTRAINT fk_brawler_overall_aggregates_brawler
    FOREIGN KEY (brawler_id) REFERENCES canonical_brawlers (id),
  CONSTRAINT fk_brawler_overall_aggregates_patch
    FOREIGN KEY (patch_id) REFERENCES patches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per ordered (brawler, opponent_brawler, game_mode nullable, patch
-- nullable) pair. "Opponent" is derived directly from the existing
-- battle_teams grouping: a co-participant on a DIFFERENT battle_team_id
-- within the same battle (the ordinary meaning of "opponent" given a
-- schema that already groups participants into teams) — never an invented
-- threshold. Mirror matches (brawler_id = opponent_brawler_id) are
-- excluded, per Section 7.10's explicit instruction ("excluded from
-- matchup-pair aggregation specifically"). confidence_level is the exact
-- column Section 25.2 names but is always NULL this phase: Section 7.15's
-- four-level model requires sample-size thresholds that are themselves
-- part of the unresolved "Minimum sample size" decision (Section 7.28).
-- No relationship classification (hard counter/counter/neutral/strong/
-- hard advantage, Section 11.1) is stored anywhere yet, for the same
-- reason — those cutoffs are never given a number anywhere in the spec.
CREATE TABLE matchup_aggregates (
  id CHAR(36) NOT NULL,
  aggregation_run_id CHAR(36) NOT NULL,
  brawler_id CHAR(36) NOT NULL,
  opponent_brawler_id CHAR(36) NOT NULL,
  game_mode_id CHAR(36) NULL,
  patch_id CHAR(36) NULL,
  matches INT NOT NULL,
  win_rate DECIMAL(6,5) NULL,
  confidence_level VARCHAR(30) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_matchup_aggregates_scope (brawler_id, opponent_brawler_id, game_mode_id, patch_id, aggregation_run_id),
  KEY idx_matchup_aggregates_lookup (brawler_id, opponent_brawler_id, patch_id),
  KEY idx_matchup_aggregates_run_id (aggregation_run_id),
  CONSTRAINT fk_matchup_aggregates_run
    FOREIGN KEY (aggregation_run_id) REFERENCES aggregation_runs (id),
  CONSTRAINT fk_matchup_aggregates_brawler
    FOREIGN KEY (brawler_id) REFERENCES canonical_brawlers (id),
  CONSTRAINT fk_matchup_aggregates_opponent
    FOREIGN KEY (opponent_brawler_id) REFERENCES canonical_brawlers (id),
  CONSTRAINT fk_matchup_aggregates_mode
    FOREIGN KEY (game_mode_id) REFERENCES canonical_game_modes (id),
  CONSTRAINT fk_matchup_aggregates_patch
    FOREIGN KEY (patch_id) REFERENCES patches (id),
  CONSTRAINT chk_matchup_aggregates_distinct_brawlers CHECK (
    brawler_id <> opponent_brawler_id
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
