-- =====================================================================
-- DATASET Phase 1 — production size / capacity report (READ-ONLY)
-- =====================================================================
--
-- SAFETY CONTRACT
--   * Every statement below is a SELECT. There is no INSERT, UPDATE,
--     DELETE, ALTER, DROP, OPTIMIZE, ANALYZE or CREATE anywhere in this
--     file. Running it cannot modify data or schema.
--   * Sections 1-6 read only information_schema metadata and are cheap.
--   * Sections 7+ are marked EXPENSIVE: they touch real table data. Do
--     NOT run them against production without explicit owner approval,
--     and prefer running them against an isolated restored copy first.
--   * Run with a read-only database user wherever one is available.
--   * DATASET.md Phase 0 forbids OPTIMIZE TABLE under capacity pressure.
--     This file deliberately contains none.
--
-- USAGE
--   mysql --defaults-file=<protected-option-file> <database> \
--     < scripts/dataset/production-size-report.sql > size-report.txt
--
--   Never pass the password on the command line. Never paste the output
--   anywhere that would expose the host or credentials.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Server identity and semantics (needed for the MariaDB->MySQL gate)
--    Cost: trivial.
-- ---------------------------------------------------------------------
SELECT
  VERSION()                  AS server_version,
  @@version_comment          AS version_comment,
  @@sql_mode                 AS sql_mode,
  @@time_zone                AS time_zone,
  @@character_set_server     AS charset_server,
  @@collation_server         AS collation_server,
  @@max_connections          AS max_connections,
  DATABASE()                 AS current_database,
  UTC_TIMESTAMP(3)           AS report_taken_at_utc;


-- ---------------------------------------------------------------------
-- 2. Whole-database footprint against the 3072 MB Hostinger quota.
--    Cost: trivial (metadata only).
-- ---------------------------------------------------------------------
SELECT
  ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2)          AS total_mb,
  ROUND(SUM(DATA_LENGTH) / 1024 / 1024, 2)                         AS data_mb,
  ROUND(SUM(INDEX_LENGTH) / 1024 / 1024, 2)                        AS index_mb,
  ROUND(SUM(DATA_FREE) / 1024 / 1024, 2)                           AS free_mb,
  3072                                                             AS quota_mb,
  ROUND(SUM(DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024 / 3072 * 100, 2) AS pct_of_quota
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE();


-- ---------------------------------------------------------------------
-- 3. Per-table footprint, largest first. This is the primary evidence
--    for "which tables actually caused 3143 MB".
--    TABLE_ROWS is an InnoDB ESTIMATE, not an exact count — never quote
--    it as a measured row count. Section 7 has the exact counts.
--    Cost: trivial (metadata only).
-- ---------------------------------------------------------------------
SELECT
  TABLE_NAME,
  ENGINE,
  TABLE_COLLATION,
  TABLE_ROWS                                                        AS estimated_rows,
  ROUND(DATA_LENGTH / 1024 / 1024, 2)                               AS data_mb,
  ROUND(INDEX_LENGTH / 1024 / 1024, 2)                              AS index_mb,
  ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2)              AS total_mb,
  ROUND(DATA_FREE / 1024 / 1024, 2)                                 AS free_mb,
  CASE WHEN TABLE_ROWS > 0
       THEN ROUND((DATA_LENGTH + INDEX_LENGTH) / TABLE_ROWS, 1)
       ELSE NULL END                                                AS avg_bytes_per_row,
  CASE WHEN DATA_LENGTH > 0
       THEN ROUND(INDEX_LENGTH / DATA_LENGTH, 2)
       ELSE NULL END                                                AS index_to_data_ratio
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC;


-- ---------------------------------------------------------------------
-- 4. Foreign-key inventory. DATASET.md Phase 1 requires this saved with
--    the migration evidence. It is also the authority for deletion order
--    and for proving a table is NOT safe to purge.
--    Cost: trivial.
-- ---------------------------------------------------------------------
SELECT
  TABLE_NAME,
  CONSTRAINT_NAME,
  COLUMN_NAME,
  REFERENCED_TABLE_NAME,
  REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE()
  AND REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION;


-- ---------------------------------------------------------------------
-- 5. Index inventory. Compare against scripts/dataset/schema-inventory.mjs
--    output: any difference is SCHEMA DRIFT and must be investigated
--    before any migration decision.
--    Cost: trivial.
-- ---------------------------------------------------------------------
SELECT
  TABLE_NAME,
  INDEX_NAME,
  NON_UNIQUE,
  GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS index_columns
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE
ORDER BY TABLE_NAME, INDEX_NAME;


-- ---------------------------------------------------------------------
-- 6. Drift detectors: generated columns and CHECK constraints actually
--    present in the live server. These are the constructs most likely to
--    behave differently on MySQL 8.4 (DATASET.md Phase 6 gate).
--    Cost: trivial.
-- ---------------------------------------------------------------------
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, EXTRA, GENERATION_EXPRESSION
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND GENERATION_EXPRESSION IS NOT NULL
  AND GENERATION_EXPRESSION <> ''
ORDER BY TABLE_NAME, COLUMN_NAME;

SELECT TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE
FROM information_schema.TABLE_CONSTRAINTS
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, CONSTRAINT_TYPE, CONSTRAINT_NAME;


-- =====================================================================
-- EXPENSIVE SECTIONS BELOW — EXPLICIT APPROVAL REQUIRED IN PRODUCTION
-- Each statement below scans real table data. On a database that is
-- already over quota and serving public reads, run these one at a time,
-- during a quiet period, ideally against an isolated restored copy.
-- Remove the leading "-- APPROVED:" guard comment only when approved.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 7. EXPENSIVE — exact row counts for the tables that dominate size.
--    COUNT(*) on InnoDB is a full index scan. matchup_aggregates and
--    battle_participants are the two largest; expect these to be slow.
--    Run individually, not as one statement.
-- ---------------------------------------------------------------------
-- APPROVED: SELECT COUNT(*) AS exact_rows FROM matchup_aggregates;
-- APPROVED: SELECT COUNT(*) AS exact_rows FROM battle_participants;
-- APPROVED: SELECT COUNT(*) AS exact_rows FROM battle_teams;
-- APPROVED: SELECT COUNT(*) AS exact_rows FROM battle_observations;
-- APPROVED: SELECT COUNT(*) AS exact_rows FROM normalized_battles;
-- APPROVED: SELECT COUNT(*) AS exact_rows FROM normalized_players;
-- APPROVED: SELECT COUNT(*) AS exact_rows FROM observed_players;
-- APPROVED: SELECT COUNT(*) AS exact_rows FROM raw_api_snapshots;

-- ---------------------------------------------------------------------
-- 8. EXPENSIVE — aggregate accumulation by run. This is the single most
--    important query for the capacity story: it shows how many complete
--    aggregate sets are being retained. DATASET.md Phase 5 measured
--    ~8.76 full sets of ~115,720 matchup rows each.
--    Indexed by idx_matchup_aggregates_run_id, so this is a grouped
--    index scan rather than a full table scan.
-- ---------------------------------------------------------------------
-- APPROVED:
-- SELECT ar.id                AS aggregation_run_id,
--        ar.scope,
--        ar.status,
--        ar.started_at,
--        ar.completed_at,
--        ar.brawlers_processed
-- FROM aggregation_runs ar
-- ORDER BY ar.started_at DESC;

-- APPROVED:
-- SELECT aggregation_run_id, COUNT(*) AS rows_in_run
-- FROM matchup_aggregates
-- GROUP BY aggregation_run_id
-- ORDER BY aggregation_run_id;

-- APPROVED:
-- SELECT aggregation_run_id, COUNT(*) AS rows_in_run
-- FROM brawler_mode_aggregates
-- GROUP BY aggregation_run_id
-- ORDER BY aggregation_run_id;

-- APPROVED:
-- SELECT aggregation_run_id, COUNT(*) AS rows_in_run
-- FROM brawler_overall_aggregates
-- GROUP BY aggregation_run_id
-- ORDER BY aggregation_run_id;

-- ---------------------------------------------------------------------
-- 9. EXPENSIVE — which aggregation runs are actually REFERENCED and
--    therefore NOT archivable. Any run id returned here must be kept hot.
--    DATASET.md Phase 5 rule: never delete a run reachable from
--    published_snapshots -> ranking_runs -> aggregation_runs.
-- ---------------------------------------------------------------------
-- APPROVED:
-- SELECT DISTINCT agg_id FROM (
--   SELECT rr.mode_aggregation_run_id    AS agg_id FROM ranking_runs rr
--   UNION ALL
--   SELECT rr.overall_aggregation_run_id AS agg_id FROM ranking_runs rr
--   UNION ALL
--   SELECT rr.matchup_aggregation_run_id AS agg_id FROM ranking_runs rr
-- ) referenced;

-- APPROVED: -- the subset reachable from a PUBLISHED snapshot (never deletable)
-- SELECT DISTINCT agg_id FROM (
--   SELECT rr.mode_aggregation_run_id    AS agg_id
--     FROM published_snapshots ps JOIN ranking_runs rr ON rr.id = ps.ranking_run_id
--   UNION ALL
--   SELECT rr.overall_aggregation_run_id
--     FROM published_snapshots ps JOIN ranking_runs rr ON rr.id = ps.ranking_run_id
--   UNION ALL
--   SELECT rr.matchup_aggregation_run_id
--     FROM published_snapshots ps JOIN ranking_runs rr ON rr.id = ps.ranking_run_id
-- ) published_referenced;

-- ---------------------------------------------------------------------
-- 10. EXPENSIVE — ranking candidate accumulation, including runs that
--     were HELD. Held runs still persist their full candidate row set.
-- ---------------------------------------------------------------------
-- APPROVED:
-- SELECT status, hold_reason, COUNT(*) AS runs,
--        MIN(started_at) AS oldest, MAX(started_at) AS newest
-- FROM ranking_runs
-- GROUP BY status, hold_reason;

-- APPROVED:
-- SELECT ranking_run_id, COUNT(*) AS candidate_rows
-- FROM ranking_results GROUP BY ranking_run_id ORDER BY ranking_run_id;

-- APPROVED:
-- SELECT ranking_run_id, COUNT(*) AS candidate_rows
-- FROM matchup_results GROUP BY ranking_run_id ORDER BY ranking_run_id;

-- ---------------------------------------------------------------------
-- 11. EXPENSIVE — raw payload size distribution. Confirms the measured
--     ~78 MB/day raw growth and sizes the object-storage archive.
--     LENGTH() over a LONGTEXT column is a full table scan. Consider
--     restricting to a recent window first (second form).
-- ---------------------------------------------------------------------
-- APPROVED:
-- SELECT endpoint_category,
--        COUNT(*)                                   AS snapshots,
--        ROUND(SUM(LENGTH(payload)) / 1024 / 1024, 2) AS payload_mb,
--        ROUND(AVG(LENGTH(payload)))                AS avg_payload_bytes,
--        MAX(LENGTH(payload))                       AS max_payload_bytes,
--        MIN(created_at)                            AS oldest,
--        MAX(created_at)                            AS newest
-- FROM raw_api_snapshots
-- GROUP BY endpoint_category;

-- APPROVED: -- cheaper bounded variant: last 24 hours only
-- SELECT endpoint_category,
--        COUNT(*)                                   AS snapshots,
--        ROUND(SUM(LENGTH(payload)) / 1024 / 1024, 2) AS payload_mb
-- FROM raw_api_snapshots
-- WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 1 DAY
-- GROUP BY endpoint_category;

-- ---------------------------------------------------------------------
-- 12. EXPENSIVE — workflow/audit history volume.
-- ---------------------------------------------------------------------
-- APPROVED:
-- SELECT wd.slug, wr.status, COUNT(*) AS runs,
--        MIN(wr.started_at) AS oldest, MAX(wr.started_at) AS newest
-- FROM workflow_runs wr
-- JOIN workflow_definitions wd ON wd.id = wr.workflow_definition_id
-- GROUP BY wd.slug, wr.status
-- ORDER BY runs DESC;

-- APPROVED: SELECT COUNT(*) AS workflow_step_rows FROM workflow_steps;
