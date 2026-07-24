-- DATASET Phase 5: compact aggregate trend preservation.
-- Spec: DATASET.md Phase 5 policy point 3 ("Keep daily/patch trend summaries in
-- a small future aggregate_trend_summaries table; never delete all history").
--
-- WHY THIS TABLE (the exact analytical history that would otherwise be lost):
-- Phase 5 archives + deletes the historical CHILD detail of old, unreferenced
-- aggregation runs — brawler_mode_aggregates, brawler_overall_aggregates, and
-- (dominantly) matchup_aggregates. Each aggregation run is a full recomputation
-- at a point in time, so the sequence of runs encodes a TIME SERIES:
--   "how did brawler X's win rate and match volume in mode M evolve run over
--    run / patch over patch?"
-- Once the child rows for an old run are deleted (recoverable only from the
-- object archive), that trajectory can no longer be queried in MySQL. This
-- table preserves a COMPACT rollup of exactly that per-brawler (and per-mode)
-- trajectory — matches/wins/losses/draws/win_rate keyed by run date, patch,
-- brawler, mode, and scope — so trend queries survive in-DB forever without
-- retaining the full multi-hundred-MB aggregate sets.
--
-- Scope note on what is NOT summarized here: the matchup PAIR trajectory
-- (matchup_aggregates, ~100k rows/run) is far too large to mirror in-DB; its
-- history is preserved only in the verified object archive. This table captures
-- the per-brawler / per-mode single-entity trend, which is small and bounded
-- (~106 brawlers x modes x runs). It is written from the SAME aggregate rows
-- before they are archived, and is NEVER a deletion target.
--
-- One row per (summary_date, patch, brawler, mode, scope). scope 'overall' rows
-- have game_mode_id = NULL (there is no per-mode split for the overall rollup).
-- source_aggregation_run_id keeps provenance back to the run the summary came
-- from (metadata-only reference; that run's metadata is kept forever).

CREATE TABLE aggregate_trend_summaries (
  id CHAR(36) NOT NULL,
  summary_date DATE NOT NULL,
  patch_id CHAR(36) NULL,
  brawler_id CHAR(36) NOT NULL,
  game_mode_id CHAR(36) NULL,
  scope VARCHAR(20) NOT NULL,
  matches INT NOT NULL,
  wins INT NOT NULL,
  losses INT NOT NULL,
  draws INT NOT NULL,
  win_rate DECIMAL(6,5) NULL,
  source_aggregation_run_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_trend_summary_scope (summary_date, patch_id, brawler_id, game_mode_id, scope),
  KEY idx_trend_summary_brawler (brawler_id, game_mode_id, summary_date),
  KEY idx_trend_summary_source_run (source_aggregation_run_id),
  CONSTRAINT fk_trend_summary_brawler
    FOREIGN KEY (brawler_id) REFERENCES canonical_brawlers (id),
  CONSTRAINT fk_trend_summary_mode
    FOREIGN KEY (game_mode_id) REFERENCES canonical_game_modes (id),
  CONSTRAINT fk_trend_summary_patch
    FOREIGN KEY (patch_id) REFERENCES patches (id),
  CONSTRAINT fk_trend_summary_source_run
    FOREIGN KEY (source_aggregation_run_id) REFERENCES aggregation_runs (id),
  CONSTRAINT chk_trend_summary_scope CHECK (scope IN ('overall', 'per_mode'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
