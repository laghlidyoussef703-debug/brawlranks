-- Phase 5.3: adds the "data freshness" timestamp Section 7.8 already names
-- as part of this table family ("Data freshness | ... | Computed at
-- aggregation time") but migration 0022 did not yet populate. Needed by
-- the ranking layer's recency weighting (Section 7.10) — a patch-scoped
-- aggregate group's own most-recent contributing battle is how ranking
-- derives that group's age for the day-based decay curve, without
-- re-scanning raw battles.
--
-- Additive only: nullable columns, no data rewrite, no existing row
-- touched (existing rows simply have these new columns NULL until the
-- next aggregation run populates them).
--
-- matchup_aggregates also gains raw `wins`/`losses` columns here: Phase
-- 5.2 stored only the computed `win_rate` ratio, whose denominator
-- (wins + losses) is not the same as `matches` (which also includes
-- draws/unknowns) — reconstructing wins by multiplying win_rate back by
-- matches would silently lose precision. Phase 5.3 needs to POOL matchup
-- figures across several patch_id groups for one ordered pair, which
-- requires summing the real counts, not averaging an already-lossy ratio.

ALTER TABLE brawler_mode_aggregates
  ADD COLUMN latest_battle_at DATETIME(3) NULL AFTER win_rate;

ALTER TABLE brawler_overall_aggregates
  ADD COLUMN latest_battle_at DATETIME(3) NULL AFTER win_rate;

ALTER TABLE matchup_aggregates
  ADD COLUMN wins INT NULL AFTER matches,
  ADD COLUMN losses INT NULL AFTER wins,
  ADD COLUMN latest_battle_at DATETIME(3) NULL AFTER win_rate;
