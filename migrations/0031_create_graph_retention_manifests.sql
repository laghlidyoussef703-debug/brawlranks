-- DATASET Phase 14: archive-gated lifecycle for multi-table "graph" families —
-- the complete battle graph (normalized_battles + battle_teams +
-- battle_participants + battle_observations) and the workflow/fetch audit
-- families (workflow_runs + workflow_steps, data_fetch_runs).
--
-- Additive + forward-only. Adds ONLY new bookkeeping tables; touches no existing
-- table and enables no deletion by itself (the archive-verify-reimport-delete
-- gating lives in lib/retention/graph.ts). It mirrors the run-scoped manifest
-- design (migrations 0027/0029) but generalized to a `family` + multi-table
-- archive, because these families archive several tables atomically per batch
-- rather than one child table per run.
--
--   * retention_graph_manifests            — one immutable row per archived
--     batch (a deterministic set of anchor ids): row counts by table, natural
--     keys, source fetch refs, min/max timestamps, uncompressed+compressed
--     sizes, both SHA-256s, schema/format version, object location, and the
--     verification + staging-reimport status.
--   * retention_graph_verification_evidence — per verification pass (>=2).
--   * retention_graph_deletion_manifests    — one row per (family, archived
--     batch, table, batch_number, dry_run): auditable, resumable, idempotent.

CREATE TABLE retention_graph_manifests (
  id CHAR(36) NOT NULL,
  family VARCHAR(40) NOT NULL,
  archive_key VARCHAR(200) NOT NULL,
  format_version VARCHAR(60) NOT NULL,
  schema_version VARCHAR(20) NOT NULL,
  anchor_table VARCHAR(64) NOT NULL,
  anchor_count INT NOT NULL,
  row_counts LONGTEXT NOT NULL,
  natural_keys LONGTEXT NULL,
  source_refs LONGTEXT NULL,
  min_ts DATETIME(3) NULL,
  max_ts DATETIME(3) NULL,
  uncompressed_bytes BIGINT UNSIGNED NOT NULL,
  archive_bytes BIGINT UNSIGNED NULL,
  original_sha256 CHAR(64) NOT NULL,
  archive_sha256 CHAR(64) NULL,
  object_provider VARCHAR(30) NOT NULL,
  object_bucket VARCHAR(100) NOT NULL,
  object_key VARCHAR(512) NOT NULL,
  verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  verification_count INT NOT NULL DEFAULT 0,
  verification_results LONGTEXT NULL,
  staging_reimport_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  staging_reimport_result LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  verified_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_graph_manifest_object (object_bucket, object_key),
  UNIQUE KEY uniq_graph_manifest_key (family, archive_key),
  KEY idx_graph_manifest_family (family, verification_status),
  CONSTRAINT chk_graph_manifest_verification CHECK (verification_status IN ('pending', 'verified', 'failed')),
  CONSTRAINT chk_graph_manifest_reimport CHECK (staging_reimport_status IN ('pending', 'passed', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE retention_graph_verification_evidence (
  id CHAR(36) NOT NULL,
  manifest_id CHAR(36) NOT NULL,
  pass_number INT NOT NULL,
  object_size BIGINT UNSIGNED NULL,
  archive_sha256 CHAR(64) NULL,
  original_sha256 CHAR(64) NULL,
  row_count BIGINT UNSIGNED NULL,
  result VARCHAR(20) NOT NULL,
  failure_reason VARCHAR(120) NULL,
  verified_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_graph_verification_pass (manifest_id, pass_number, result),
  CONSTRAINT fk_graph_verification_manifest
    FOREIGN KEY (manifest_id) REFERENCES retention_graph_manifests (id),
  CONSTRAINT chk_graph_verification_result CHECK (result IN ('passed', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE retention_graph_deletion_manifests (
  id CHAR(36) NOT NULL,
  family VARCHAR(40) NOT NULL,
  manifest_id CHAR(36) NULL,
  table_name VARCHAR(64) NOT NULL,
  batch_number INT NOT NULL,
  batch_cursor VARCHAR(64) NULL,
  attempted_rows INT NOT NULL DEFAULT 0,
  rows_deleted INT NOT NULL DEFAULT 0,
  min_pk VARCHAR(64) NULL,
  max_pk VARCHAR(64) NULL,
  dry_run TINYINT(1) NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'planned',
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  failure_reason VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_graph_deletion_checkpoint (family, manifest_id, table_name, batch_number, dry_run),
  KEY idx_graph_deletion_status (family, manifest_id, table_name, status),
  CONSTRAINT fk_graph_deletion_manifest
    FOREIGN KEY (manifest_id) REFERENCES retention_graph_manifests (id),
  CONSTRAINT chk_graph_deletion_status CHECK (status IN ('planned', 'completed', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
