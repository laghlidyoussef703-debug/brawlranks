-- =====================================================================
-- DATASET Phase 2 — restored-database validation suite (READ-ONLY)
-- =====================================================================
--
-- Run this against an ISOLATED restored copy only, never production.
-- Every statement is a SELECT. Nothing here mutates data — DATASET.md is
-- explicit: "Do not alter data merely to make validation pass."
--
-- Usage:
--   mysql --host=127.0.0.1 --port=3307 --user=root \
--     brawlranks_restoretest_YYYYMMDD < scripts/dataset/validate-restored-db.sql \
--     > restore-validation.txt
--
-- Each block prints a check name, the observed value, and the expected
-- value, so the output can be pasted into the backup manifest as evidence.
-- A check that returns FAIL is a real failure. Report it; do not fix the
-- data to make it pass.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 0. Guard: refuse to report success if this looks like production.
--    A human can still run this anywhere, so this is a loud warning, not
--    an enforcement mechanism — enforcement lives in restore-isolated.sh.
-- ---------------------------------------------------------------------
SELECT
  '00_target_identity' AS check_name,
  DATABASE()           AS observed,
  'must start with brawlranks_restoretest_' AS expected,
  CASE WHEN DATABASE() LIKE 'brawlranks\_restoretest\_%' THEN 'PASS'
       ELSE 'FAIL — THIS IS NOT AN ISOLATED RESTORE TARGET. STOP.' END AS verdict;


-- ---------------------------------------------------------------------
-- 1. Server semantics. Recorded as evidence for the compatibility gate.
-- ---------------------------------------------------------------------
SELECT '01_server' AS check_name, VERSION() AS version, @@version_comment AS comment,
       @@sql_mode AS sql_mode, @@time_zone AS time_zone,
       @@character_set_server AS charset, @@collation_server AS collation;


-- ---------------------------------------------------------------------
-- 2. Migration ledger. Compare `checksum` against the values printed by
--    `node scripts/dataset/schema-inventory.mjs --json` (migrations[].checksum).
--    Both are SHA-256 over the raw migration file, so they must match
--    exactly. Any difference means the restored schema was built from
--    different migration content than this repository holds.
-- ---------------------------------------------------------------------
SELECT '02_migration_count' AS check_name,
       COUNT(*) AS observed, 25 AS expected,
       CASE WHEN COUNT(*) = 25 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM schema_migrations;

SELECT '02_migrations' AS check_name, version, name, checksum
FROM schema_migrations ORDER BY version;


-- ---------------------------------------------------------------------
-- 3. Table inventory. 45 tables come from migrations, plus
--    schema_migrations created by scripts/migrate.mjs = 46 total.
-- ---------------------------------------------------------------------
SELECT '03_table_count' AS check_name,
       COUNT(*) AS observed, 46 AS expected_min,
       CASE WHEN COUNT(*) >= 46 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE();

-- Critical tables that must exist. A missing row here is a FAIL.
SELECT '03_critical_tables' AS check_name, t.expected_table,
       CASE WHEN ist.TABLE_NAME IS NULL THEN 'FAIL — MISSING' ELSE 'PASS' END AS verdict
FROM (
  SELECT 'normalized_battles' AS expected_table UNION ALL
  SELECT 'battle_participants' UNION ALL
  SELECT 'battle_teams' UNION ALL
  SELECT 'battle_observations' UNION ALL
  SELECT 'normalized_players' UNION ALL
  SELECT 'raw_api_snapshots' UNION ALL
  SELECT 'data_fetch_runs' UNION ALL
  SELECT 'aggregation_runs' UNION ALL
  SELECT 'matchup_aggregates' UNION ALL
  SELECT 'brawler_mode_aggregates' UNION ALL
  SELECT 'brawler_overall_aggregates' UNION ALL
  SELECT 'ranking_runs' UNION ALL
  SELECT 'ranking_results' UNION ALL
  SELECT 'matchup_results' UNION ALL
  SELECT 'published_snapshots' UNION ALL
  SELECT 'published_snapshot_items' UNION ALL
  SELECT 'published_matchup_items' UNION ALL
  SELECT 'canonical_brawlers' UNION ALL
  SELECT 'ranking_rule_sets' UNION ALL
  SELECT 'schema_migrations'
) t
LEFT JOIN information_schema.TABLES ist
  ON ist.TABLE_SCHEMA = DATABASE() AND ist.TABLE_NAME = t.expected_table;


-- ---------------------------------------------------------------------
-- 4. Engine and collation uniformity. A restore that silently changed
--    either would change comparison semantics.
-- ---------------------------------------------------------------------
SELECT '04_engine_collation' AS check_name, ENGINE, TABLE_COLLATION, COUNT(*) AS tables
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
GROUP BY ENGINE, TABLE_COLLATION;

SELECT '04_non_innodb' AS check_name, COUNT(*) AS observed, 0 AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND ENGINE <> 'InnoDB';


-- ---------------------------------------------------------------------
-- 5. Constraint survival. A logical dump restored with FK checks disabled
--    can silently lose foreign keys — this is the check that catches it.
-- ---------------------------------------------------------------------
SELECT '05_foreign_key_count' AS check_name,
       COUNT(*) AS observed, 60 AS expected_min,
       CASE WHEN COUNT(*) >= 60 THEN 'PASS' ELSE 'FAIL — foreign keys were lost in the restore' END AS verdict
FROM information_schema.TABLE_CONSTRAINTS
WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'FOREIGN KEY';

SELECT '05_constraints_by_type' AS check_name, CONSTRAINT_TYPE, COUNT(*) AS observed
FROM information_schema.TABLE_CONSTRAINTS
WHERE TABLE_SCHEMA = DATABASE()
GROUP BY CONSTRAINT_TYPE;

-- Generated columns carry the single-current-row invariants. All 5 must survive.
SELECT '05_generated_columns' AS check_name,
       COUNT(*) AS observed, 5 AS expected,
       CASE WHEN COUNT(*) = 5 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND GENERATION_EXPRESSION IS NOT NULL AND GENERATION_EXPRESSION <> '';

-- The battle_key unique index IS the deduplication guarantee. Losing it is critical.
SELECT '05_battle_key_unique' AS check_name,
       COUNT(*) AS observed, 1 AS expected,
       CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL — dedupe guarantee lost' END AS verdict
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'normalized_battles'
  AND INDEX_NAME = 'uniq_normalized_battles_key' AND NON_UNIQUE = 0;


-- ---------------------------------------------------------------------
-- 6. Publication integrity — the invariant the public site depends on.
-- ---------------------------------------------------------------------
SELECT '06_current_snapshot_count' AS check_name,
       COUNT(*) AS observed, '0 or 1' AS expected,
       CASE WHEN COUNT(*) <= 1 THEN 'PASS'
            ELSE 'FAIL — impossible publication state, more than one current snapshot' END AS verdict
FROM published_snapshots WHERE is_current = 1;

SELECT '06_current_snapshot_detail' AS check_name,
       ps.id AS snapshot_id, ps.ranking_run_id, ps.published_at,
       COUNT(psi.id) AS item_count
FROM published_snapshots ps
LEFT JOIN published_snapshot_items psi ON psi.published_snapshot_id = ps.id
WHERE ps.is_current = 1
GROUP BY ps.id, ps.ranking_run_id, ps.published_at;

-- A current snapshot with zero items would render an empty public tier list.
SELECT '06_current_snapshot_not_empty' AS check_name,
       COALESCE((SELECT COUNT(*) FROM published_snapshot_items psi
                 JOIN published_snapshots ps ON ps.id = psi.published_snapshot_id
                 WHERE ps.is_current = 1), 0) AS observed,
       'greater than 0 when a current snapshot exists' AS expected,
       CASE
         WHEN (SELECT COUNT(*) FROM published_snapshots WHERE is_current = 1) = 0
           THEN 'N/A — nothing published yet (valid: production shows brawlersPublished 0)'
         WHEN (SELECT COUNT(*) FROM published_snapshot_items psi
               JOIN published_snapshots ps ON ps.id = psi.published_snapshot_id
               WHERE ps.is_current = 1) > 0 THEN 'PASS'
         ELSE 'FAIL — current snapshot has no items' END AS verdict;

-- Every published snapshot must point at a real ranking run.
SELECT '06_orphan_snapshots' AS check_name,
       COUNT(*) AS observed, 0 AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM published_snapshots ps
LEFT JOIN ranking_runs rr ON rr.id = ps.ranking_run_id
WHERE rr.id IS NULL;

-- Published items must never reference a snapshot that does not exist.
SELECT '06_orphan_published_items' AS check_name,
       COUNT(*) AS observed, 0 AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM published_snapshot_items psi
LEFT JOIN published_snapshots ps ON ps.id = psi.published_snapshot_id
WHERE ps.id IS NULL;

SELECT '06_orphan_published_matchups' AS check_name,
       COUNT(*) AS observed, 0 AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM published_matchup_items pmi
LEFT JOIN published_snapshots ps ON ps.id = pmi.published_snapshot_id
WHERE ps.id IS NULL;


-- ---------------------------------------------------------------------
-- 7. Configuration invariants.
-- ---------------------------------------------------------------------
SELECT '07_current_rule_sets' AS check_name,
       COUNT(*) AS observed, 1 AS expected,
       CASE WHEN COUNT(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM ranking_rule_sets WHERE is_active = 1;

SELECT '07_active_patches' AS check_name,
       COUNT(*) AS observed, '0 or 1' AS expected,
       CASE WHEN COUNT(*) <= 1 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM patches WHERE status = 'active';

SELECT '07_rule_weights' AS check_name, COUNT(*) AS observed, 6 AS expected_from_migration_0025,
       CASE WHEN COUNT(*) >= 6 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM ranking_rule_weights;


-- ---------------------------------------------------------------------
-- 8. Workflow / lock sanity. After an isolated restore from a frozen
--    source there should be no live lock and nothing mid-flight.
-- ---------------------------------------------------------------------
SELECT '08_workflow_status' AS check_name, status, COUNT(*) AS runs
FROM workflow_runs GROUP BY status;

SELECT '08_unreleased_locks' AS check_name, COUNT(*) AS observed,
       '0 expected after a clean restore of a frozen source' AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'REVIEW — a lock survived the dump' END AS verdict
FROM workflow_locks WHERE released_at IS NULL;

SELECT '08_orphan_steps' AS check_name, COUNT(*) AS observed, 0 AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM workflow_steps ws
LEFT JOIN workflow_runs wr ON wr.id = ws.workflow_run_id
WHERE wr.id IS NULL;


-- ---------------------------------------------------------------------
-- 9. Row counts for the critical tables, recorded as restore evidence.
--    These must be compared against the source cutoff manifest.
--    NOTE: exact COUNT(*) on the large tables is slow but acceptable here
--    because this runs against a disposable copy, not production.
-- ---------------------------------------------------------------------
SELECT '09_counts' AS check_name,
  (SELECT COUNT(*) FROM normalized_battles)         AS normalized_battles,
  (SELECT COUNT(*) FROM battle_participants)        AS battle_participants,
  (SELECT COUNT(*) FROM battle_teams)               AS battle_teams,
  (SELECT COUNT(*) FROM battle_observations)        AS battle_observations,
  (SELECT COUNT(*) FROM normalized_players)         AS normalized_players,
  (SELECT COUNT(*) FROM raw_api_snapshots)          AS raw_api_snapshots,
  (SELECT COUNT(*) FROM data_fetch_runs)            AS data_fetch_runs;

SELECT '09_counts_derived' AS check_name,
  (SELECT COUNT(*) FROM aggregation_runs)           AS aggregation_runs,
  (SELECT COUNT(*) FROM matchup_aggregates)         AS matchup_aggregates,
  (SELECT COUNT(*) FROM brawler_mode_aggregates)    AS brawler_mode_aggregates,
  (SELECT COUNT(*) FROM brawler_overall_aggregates) AS brawler_overall_aggregates,
  (SELECT COUNT(*) FROM ranking_runs)               AS ranking_runs,
  (SELECT COUNT(*) FROM ranking_results)            AS ranking_results,
  (SELECT COUNT(*) FROM matchup_results)            AS matchup_results;


-- ---------------------------------------------------------------------
-- 10. Timestamp bounds — proves the restore covers the expected window.
-- ---------------------------------------------------------------------
SELECT '10_battle_window' AS check_name,
       MIN(occurred_at) AS oldest_battle, MAX(occurred_at) AS newest_battle,
       MIN(created_at)  AS oldest_row,    MAX(created_at)  AS newest_row
FROM normalized_battles;

SELECT '10_raw_window' AS check_name,
       MIN(created_at) AS oldest, MAX(created_at) AS newest
FROM raw_api_snapshots;


-- ---------------------------------------------------------------------
-- 11. Deduplication proof. total MUST equal deduped — battle_key is
--     UNIQUE, so any difference means the constraint did not survive.
-- ---------------------------------------------------------------------
SELECT '11_battle_dedupe' AS check_name,
       COUNT(*) AS total, COUNT(DISTINCT battle_key) AS deduped,
       CASE WHEN COUNT(*) = COUNT(DISTINCT battle_key) THEN 'PASS'
            ELSE 'FAIL — duplicate battle_key present' END AS verdict
FROM normalized_battles;


-- ---------------------------------------------------------------------
-- 12. Orphan checks across the battle graph. All must be 0.
-- ---------------------------------------------------------------------
SELECT '12_orphan_participants' AS check_name, COUNT(*) AS observed, 0 AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM battle_participants bp
LEFT JOIN normalized_battles b  ON b.id  = bp.battle_id
LEFT JOIN normalized_players  p ON p.id  = bp.player_id
LEFT JOIN canonical_brawlers cb ON cb.id = bp.brawler_id
WHERE b.id IS NULL OR p.id IS NULL OR cb.id IS NULL;

SELECT '12_orphan_teams' AS check_name, COUNT(*) AS observed, 0 AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM battle_teams bt
LEFT JOIN normalized_battles b ON b.id = bt.battle_id
WHERE b.id IS NULL;

SELECT '12_orphan_observations' AS check_name, COUNT(*) AS observed, 0 AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM battle_observations bo
LEFT JOIN normalized_battles b   ON b.id   = bo.battle_id
LEFT JOIN data_fetch_runs    dfr ON dfr.id = bo.data_fetch_run_id
WHERE b.id IS NULL OR dfr.id IS NULL;

SELECT '12_orphan_aggregates' AS check_name, COUNT(*) AS observed, 0 AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM matchup_aggregates ma
LEFT JOIN aggregation_runs ar ON ar.id = ma.aggregation_run_id
WHERE ar.id IS NULL;

SELECT '12_orphan_ranking_results' AS check_name, COUNT(*) AS observed, 0 AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM ranking_results rr
LEFT JOIN ranking_runs run ON run.id = rr.ranking_run_id
WHERE run.id IS NULL;

-- Every ranking run must reference three real aggregation runs.
SELECT '12_ranking_agg_links' AS check_name, COUNT(*) AS observed, 0 AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM ranking_runs rr
LEFT JOIN aggregation_runs am ON am.id = rr.mode_aggregation_run_id
LEFT JOIN aggregation_runs ao ON ao.id = rr.overall_aggregation_run_id
LEFT JOIN aggregation_runs ax ON ax.id = rr.matchup_aggregation_run_id
WHERE am.id IS NULL OR ao.id IS NULL OR ax.id IS NULL;


-- ---------------------------------------------------------------------
-- 13. Representative read queries — proves the restored DB can actually
--     serve the application's real access patterns, not just hold rows.
--     These mirror lib/publishedSnapshots/repository.ts, which is the
--     ONLY module any public read path may use.
-- ---------------------------------------------------------------------
-- Mirrors getCurrentSnapshotMeta().
SELECT '13_public_meta_query' AS check_name, id, published_at, patch_id
FROM published_snapshots WHERE is_current = 1 LIMIT 1;

-- Mirrors getCurrentPublishedBrawlers()'s join shape.
SELECT '13_public_items_query' AS check_name,
       psi.brawler_id, cb.slug, cb.name, psi.overall_tier, psi.overall_score,
       psi.overall_confidence, psi.patch_version_label
FROM published_snapshot_items psi
JOIN canonical_brawlers cb ON cb.id = psi.brawler_id
JOIN published_snapshots ps ON ps.id = psi.published_snapshot_id
WHERE ps.is_current = 1
ORDER BY psi.overall_score DESC
LIMIT 5;

-- Mirrors the aggregation layer's run-scoped batch read (indexed by run id).
SELECT '13_aggregation_batch_query' AS check_name, aggregation_run_id, COUNT(*) AS rows_in_run
FROM matchup_aggregates
GROUP BY aggregation_run_id
ORDER BY aggregation_run_id
LIMIT 20;


-- ---------------------------------------------------------------------
-- 14. Secret-leakage sweep. The schema stores diagnostic JSON in several
--     LONGTEXT columns that application code is required to sanitize.
--     A non-zero count is a CRITICAL finding: it means a secret reached
--     the database and is now inside every backup.
-- ---------------------------------------------------------------------
SELECT '14_incident_detail_leak' AS check_name, COUNT(*) AS observed, 0 AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL — CRITICAL, secret-shaped text in data_incidents.detail' END AS verdict
FROM data_incidents
WHERE detail LIKE '%password%' OR detail LIKE '%Authorization%'
   OR detail LIKE '%BRAWL_DB_SECRET%' OR detail LIKE '%Bearer %';

SELECT '14_fetch_context_leak' AS check_name, COUNT(*) AS observed, 0 AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL — CRITICAL, secret-shaped text in data_fetch_runs.request_context' END AS verdict
FROM data_fetch_runs
WHERE request_context LIKE '%password%' OR request_context LIKE '%Authorization%'
   OR request_context LIKE '%BRAWL_DB_SECRET%' OR request_context LIKE '%Bearer %';

SELECT '14_workflow_output_leak' AS check_name, COUNT(*) AS observed, 0 AS expected,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL — CRITICAL, secret-shaped text in workflow_steps.output_summary' END AS verdict
FROM workflow_steps
WHERE output_summary LIKE '%password%' OR output_summary LIKE '%Authorization%'
   OR output_summary LIKE '%BRAWL_DB_SECRET%' OR output_summary LIKE '%Bearer %';


-- =====================================================================
-- END. Record every verdict in the backup manifest's restoreTest block.
-- A restore is only "proven" when section 0 passes AND no check reports
-- FAIL. Passing this suite on a restored copy is what closes the
-- DATASET.md Phase 2 restorability gate — nothing else does.
-- =====================================================================
