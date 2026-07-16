-- Phase 4: Supporting indexes for stratified fair crawl selection
-- (lib/ingestion/fairness.ts) and the dataset-coverage report
-- (app/api/internal/test/dataset-coverage). Both now GROUP BY / filter on
-- (region, trophy_bracket) against player_crawl_schedule, which had no
-- composite index covering that access pattern — only the separate
-- single-column indexes from migration 0012 (due-selection and priority),
-- neither of which helps a region/bracket-grouped query.

ALTER TABLE player_crawl_schedule
  ADD KEY idx_player_crawl_schedule_region_bracket (region, trophy_bracket);

-- normalized_battles.occurred_at is already indexed (migration 0014) for
-- the "battles by day" / freshness-window queries the coverage report
-- needs; no change required there.
