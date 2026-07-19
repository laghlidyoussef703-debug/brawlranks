-- =====================================================================
-- DATASET Phase 1 — machine-readable schema/data evidence (READ-ONLY)
-- =====================================================================
--
-- Emits the twelve inventories DATASET.md Phase 1 requires as evidence,
-- entirely from information_schema plus bounded COUNT/size reads. Every
-- statement is a SELECT; nothing here mutates data.
--
-- Run this ONLY against an isolated, production-DERIVED restored copy
-- (a database named brawlranks_restoretest_*), never against production.
-- The restored copy carries production schema and data without exposing a
-- live mutable production connection.
--
-- Usage (tab-separated, header row per section, easy to diff/store):
--   mariadb --batch --host=127.0.0.1 --port=3307 --user=<ro-user> \
--     brawlranks_restoretest_YYYYMMDD < scripts/dataset/restore-evidence.sql \
--     > docs/dataset/evidence/<section>.tsv
--
-- In practice each numbered section is run individually into its own file
-- (see docs/dataset/evidence/README.md) so each inventory is a clean,
-- independently reviewable artifact.
-- =====================================================================

-- 00. Identity guard — refuse to be mistaken for production evidence.
SELECT '00_identity' AS section, DATABASE() AS database_name,
       CASE WHEN DATABASE() LIKE 'brawlranks\_restoretest\_%'
            THEN 'isolated_restore_copy' ELSE 'REFUSE_NOT_ISOLATED' END AS classification;

-- 01. Full table inventory (engine, collation, row estimate, bytes).
SELECT TABLE_NAME, ENGINE, TABLE_COLLATION, TABLE_ROWS,
       DATA_LENGTH, INDEX_LENGTH, (DATA_LENGTH + INDEX_LENGTH) AS total_bytes,
       CREATE_TIME, TABLE_COMMENT
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME;

-- 02. Columns and column types.
SELECT TABLE_NAME, ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
       COLUMN_DEFAULT, EXTRA, COLLATION_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, ORDINAL_POSITION;

-- 03. Foreign-key inventory.
SELECT kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME,
       kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
       rc.UPDATE_RULE, rc.DELETE_RULE
FROM information_schema.KEY_COLUMN_USAGE kcu
JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
  ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
 AND rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
WHERE kcu.TABLE_SCHEMA = DATABASE()
  AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION;

-- 04. Index inventory.
SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
       CARDINALITY, INDEX_TYPE
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- 05. Constraints (PK / UNIQUE / FK / CHECK) by table.
SELECT TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE
FROM information_schema.TABLE_CONSTRAINTS
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, CONSTRAINT_TYPE, CONSTRAINT_NAME;

-- 05b. CHECK constraint clauses (MariaDB exposes CHECK_CONSTRAINTS).
SELECT TABLE_NAME, CONSTRAINT_NAME, CHECK_CLAUSE
FROM information_schema.CHECK_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, CONSTRAINT_NAME;

-- 06. Generated columns (the single-current-row invariants).
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, EXTRA, GENERATION_EXPRESSION
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND GENERATION_EXPRESSION IS NOT NULL AND GENERATION_EXPRESSION <> ''
ORDER BY TABLE_NAME, COLUMN_NAME;

-- 07. Engine and collation inventory (aggregate).
SELECT ENGINE, TABLE_COLLATION, COUNT(*) AS tables
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
GROUP BY ENGINE, TABLE_COLLATION
ORDER BY tables DESC;

-- 08. Migration checksum inventory.
SELECT version, name, checksum, applied_at
FROM schema_migrations
ORDER BY version;

-- 09. Table row/count summary (exact counts on the disposable copy).
--     Emitted via information_schema estimate here; exact counts are in
--     validate-restored-db.sql sections 9/11 (already captured).
SELECT TABLE_NAME, TABLE_ROWS AS estimated_rows
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
ORDER BY TABLE_ROWS DESC;

-- 10. Largest-table size summary.
SELECT TABLE_NAME,
       ROUND(DATA_LENGTH  / 1024 / 1024, 2) AS data_mb,
       ROUND(INDEX_LENGTH / 1024 / 1024, 2) AS index_mb,
       ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS total_mb
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC
LIMIT 15;

-- 11. Current snapshot / ranking / rule-set identity.
SELECT 'published_snapshots_current' AS identity_kind, COUNT(*) AS n
FROM published_snapshots WHERE is_current = 1
UNION ALL
SELECT 'ranking_rule_sets_active', COUNT(*) FROM ranking_rule_sets WHERE is_active = 1
UNION ALL
SELECT 'patches_active', COUNT(*) FROM patches WHERE status = 'active';

SELECT ps.id AS snapshot_id, ps.ranking_run_id, ps.published_at,
       COUNT(psi.id) AS item_count
FROM published_snapshots ps
LEFT JOIN published_snapshot_items psi ON psi.published_snapshot_id = ps.id
WHERE ps.is_current = 1
GROUP BY ps.id, ps.ranking_run_id, ps.published_at;

-- 12. Workflow status and active-lock summary.
SELECT status, COUNT(*) AS runs FROM workflow_runs GROUP BY status ORDER BY status;

SELECT COUNT(*) AS unreleased_locks
FROM workflow_locks WHERE released_at IS NULL;
