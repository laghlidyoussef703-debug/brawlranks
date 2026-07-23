-- =====================================================================
-- DATASET Phase 1 — growth / duplicate-risk report (READ-ONLY)
-- =====================================================================
--
-- SAFETY CONTRACT — identical to production-size-report.sql:
--   * SELECT statements only. No write, no DDL, no OPTIMIZE.
--   * Sections marked EXPENSIVE are commented out behind an
--     "-- APPROVED:" guard. Uncomment only with explicit owner approval,
--     and prefer an isolated restored copy over production.
--   * This file answers "how fast is it growing and where", which is the
--     input to DATASET.md Phase 15's days_to_limit forecast.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. CHEAP — freshness bounds of the core fact tables. These use the
--    existing indexes (idx_normalized_battles_occurred_at,
--    idx_raw_api_snapshots_created_at) and are MIN/MAX index probes.
-- ---------------------------------------------------------------------
SELECT 'normalized_battles' AS table_name,
       MIN(occurred_at) AS oldest_event, MAX(occurred_at) AS newest_event
FROM normalized_battles;

SELECT 'raw_api_snapshots' AS table_name,
       MIN(created_at) AS oldest_row, MAX(created_at) AS newest_row
FROM raw_api_snapshots;

SELECT 'data_fetch_runs' AS table_name,
       MIN(started_at) AS oldest_row, MAX(started_at) AS newest_row
FROM data_fetch_runs;


-- ---------------------------------------------------------------------
-- 2. CHEAP — recent ingestion volume. Range scans on an indexed
--    timestamp; bounded by the window, not by table size.
--    A zero in the 1h bucket while collectors are supposed to be running
--    is DATASET.md Phase 15's "battles collected = zero" critical alert.
--    NOTE: with the production freeze in place, zeros here are EXPECTED
--    and are not evidence of a fault.
-- ---------------------------------------------------------------------
SELECT
  SUM(created_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR)  AS battles_last_1h,
  SUM(created_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY)   AS battles_last_24h,
  SUM(created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY)   AS battles_last_7d
FROM normalized_battles
WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY;

SELECT
  SUM(created_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR)  AS raw_snapshots_last_1h,
  SUM(created_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY)   AS raw_snapshots_last_24h,
  SUM(created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY)   AS raw_snapshots_last_7d
FROM raw_api_snapshots
WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 7 DAY;


-- ---------------------------------------------------------------------
-- 3. MODERATE — daily collection curve over the last 14 days. Bounded by
--    the WHERE window and served by the created_at index. This produces
--    the growth-per-day slope DATASET.md Phase 15 requires.
-- ---------------------------------------------------------------------
SELECT DATE(created_at) AS day, COUNT(*) AS battles_created
FROM normalized_battles
WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 14 DAY
GROUP BY DATE(created_at)
ORDER BY day;


-- ---------------------------------------------------------------------
-- 4. CHEAP — publication integrity. Reads only the tiny published_*
--    tables plus the unique current_flag index.
--    INVARIANT: current_snapshots must be exactly 1 once anything has
--    been published, and exactly 0 before the first publication.
-- ---------------------------------------------------------------------
SELECT COUNT(*) AS current_snapshots
FROM published_snapshots WHERE is_current = 1;

SELECT ps.id            AS snapshot_id,
       ps.ranking_run_id,
       ps.published_at,
       COUNT(psi.id)    AS published_items
FROM published_snapshots ps
LEFT JOIN published_snapshot_items psi ON psi.published_snapshot_id = ps.id
WHERE ps.is_current = 1
GROUP BY ps.id, ps.ranking_run_id, ps.published_at;

SELECT COUNT(*) AS total_snapshots_ever FROM published_snapshots;


-- ---------------------------------------------------------------------
-- 5. CHEAP — operational health. Confirms the production freeze is real
--    and that nothing is mid-flight before any migration action.
--    Expected under the freeze: zero running workflows, zero live locks.
-- ---------------------------------------------------------------------
SELECT status, COUNT(*) AS runs, MIN(started_at) AS oldest_started
FROM workflow_runs
GROUP BY status;

SELECT wd.slug, wr.id AS workflow_run_id, wr.started_at,
       TIMESTAMPDIFF(MINUTE, wr.started_at, UTC_TIMESTAMP()) AS running_minutes
FROM workflow_runs wr
JOIN workflow_definitions wd ON wd.id = wr.workflow_definition_id
WHERE wr.status = 'running'
ORDER BY wr.started_at;

SELECT wl.workflow_definition_id, wd.slug, wl.locked_at, wl.expires_at,
       (wl.expires_at <= UTC_TIMESTAMP(3)) AS is_expired
FROM workflow_locks wl
JOIN workflow_definitions wd ON wd.id = wl.workflow_definition_id
WHERE wl.released_at IS NULL;


-- ---------------------------------------------------------------------
-- 6. CHEAP — configuration invariants that a restore must preserve.
-- ---------------------------------------------------------------------
SELECT COUNT(*) AS current_rule_sets FROM ranking_rule_sets WHERE is_active = 1;
SELECT COUNT(*) AS active_patches     FROM patches            WHERE status = 'active';
SELECT version, name, checksum FROM schema_migrations ORDER BY version;


-- =====================================================================
-- EXPENSIVE SECTIONS — EXPLICIT APPROVAL REQUIRED IN PRODUCTION
-- =====================================================================

-- ---------------------------------------------------------------------
-- 7. EXPENSIVE — deduplication proof for normalized_battles.
--    battle_key carries a UNIQUE constraint, so total MUST equal deduped.
--    A difference would mean the unique index is missing in the live
--    schema (drift) and is a CRITICAL finding.
--    Full index scan over the whole table.
-- ---------------------------------------------------------------------
-- APPROVED:
-- SELECT COUNT(*) AS total_battles, COUNT(DISTINCT battle_key) AS distinct_keys
-- FROM normalized_battles;

-- APPROVED: -- must return zero rows
-- SELECT battle_key, COUNT(*) AS occurrences
-- FROM normalized_battles GROUP BY battle_key HAVING COUNT(*) > 1;

-- ---------------------------------------------------------------------
-- 8. EXPENSIVE — orphan detection across the battle graph. Every count
--    must be 0. Non-zero means FK enforcement was bypassed or a partial
--    retention deletion left dangling children.
--    Anti-joins over the two largest tables; slow. Prefer an isolated
--    restored copy — validate-restored-db.sql runs exactly these.
-- ---------------------------------------------------------------------
-- APPROVED:
-- SELECT COUNT(*) AS orphan_participants
-- FROM battle_participants bp
-- LEFT JOIN normalized_battles b  ON b.id  = bp.battle_id
-- LEFT JOIN normalized_players  p ON p.id  = bp.player_id
-- LEFT JOIN canonical_brawlers cb ON cb.id = bp.brawler_id
-- WHERE b.id IS NULL OR p.id IS NULL OR cb.id IS NULL;

-- APPROVED:
-- SELECT COUNT(*) AS orphan_teams
-- FROM battle_teams bt
-- LEFT JOIN normalized_battles b ON b.id = bt.battle_id
-- WHERE b.id IS NULL;

-- APPROVED:
-- SELECT COUNT(*) AS orphan_observations
-- FROM battle_observations bo
-- LEFT JOIN normalized_battles b   ON b.id   = bo.battle_id
-- LEFT JOIN data_fetch_runs    dfr ON dfr.id = bo.data_fetch_run_id
-- WHERE b.id IS NULL OR dfr.id IS NULL;

-- ---------------------------------------------------------------------
-- 9. EXPENSIVE — battle graph child ratios. Confirms the DATASET.md
--    measured ratios (~7.69 participants, ~4.34 teams, ~1.38
--    observations per battle) that drive the storage forecast.
-- ---------------------------------------------------------------------
-- APPROVED:
-- SELECT
--   (SELECT COUNT(*) FROM normalized_battles)   AS battles,
--   (SELECT COUNT(*) FROM battle_participants)  AS participants,
--   (SELECT COUNT(*) FROM battle_teams)         AS teams,
--   (SELECT COUNT(*) FROM battle_observations)  AS observations;

-- ---------------------------------------------------------------------
-- 10. EXPENSIVE — duplicate-risk indicator for observations. The unique
--     key (battle_id, data_fetch_run_id) makes this structurally
--     impossible; a non-empty result is a CRITICAL drift finding.
-- ---------------------------------------------------------------------
-- APPROVED:
-- SELECT battle_id, data_fetch_run_id, COUNT(*) AS occurrences
-- FROM battle_observations
-- GROUP BY battle_id, data_fetch_run_id
-- HAVING COUNT(*) > 1;

-- ---------------------------------------------------------------------
-- 11. EXPENSIVE — player/discovery growth drivers.
-- ---------------------------------------------------------------------
-- APPROVED:
-- SELECT
--   (SELECT COUNT(*) FROM normalized_players)                            AS normalized_players,
--   (SELECT COUNT(*) FROM observed_players)                              AS observed_players,
--   (SELECT COUNT(*) FROM observed_players WHERE promoted_to_active = 0) AS unpromoted_observed,
--   (SELECT COUNT(*) FROM player_crawl_schedule WHERE is_active = 1)     AS active_crawl_rows,
--   (SELECT COUNT(*) FROM player_name_history)                           AS name_history_rows;

-- ---------------------------------------------------------------------
-- 12. EXPENSIVE — index footprint of the two dominant tables, used to
--     judge whether any index is redundant. DATASET.md Phase 5 forbids
--     dropping an index without EXPLAIN evidence; this is the input to
--     that decision, never a mandate to drop anything.
--     mysql.innodb_index_stats may not be readable by the app user on
--     shared hosting — a permission error here is expected, not a fault.
-- ---------------------------------------------------------------------
-- APPROVED:
-- SELECT TABLE_NAME, INDEX_NAME, STAT_NAME, STAT_VALUE
-- FROM mysql.innodb_index_stats
-- WHERE DATABASE_NAME = DATABASE()
--   AND TABLE_NAME IN ('matchup_aggregates', 'battle_participants')
-- ORDER BY TABLE_NAME, INDEX_NAME, STAT_NAME;

-- APPROVED:
-- EXPLAIN FORMAT=JSON
-- SELECT * FROM matchup_aggregates
-- WHERE aggregation_run_id = 'REPLACE_WITH_REAL_RUN_ID' AND brawler_id > ''
-- ORDER BY brawler_id LIMIT 8;
