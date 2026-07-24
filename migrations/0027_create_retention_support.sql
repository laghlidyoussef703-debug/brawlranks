-- DATASET Phase 5: historical aggregate/ranking retention — support tables.
-- Spec: DATASET.md Phase 5 ("Historical aggregate retention").
--
-- Additive only. This migration adds NO destructive behavior and touches no
-- existing table. It provides the durable bookkeeping the archive-gated
-- retention system requires:
--   * retention_holds            — explicit investigation / retention holds that
--                                  BLOCK a run's child rows from ever being a
--                                  deletion candidate while the hold is open.
--   * archived_run_manifests     — immutable per-run archive evidence (both
--                                  integrity hashes, counts, code/rule/patch
--                                  context, object key, verification + staging
--                                  re-import status). One row per (run, source
--                                  table) export.
--   * retention_deletion_manifests — a record of every deletion batch (dry-run
--                                  and real), so a deletion is always auditable
--                                  and resumable.
--
-- NOTE: run metadata (aggregation_runs, ranking_runs) is NEVER deleted by this
-- system. Only child/detail rows are ever deletion candidates, and only after
-- every hard gate in DATASET.md Phase 5 passes.

-- Explicit holds. target is polymorphic (a run or a workflow), validated in
-- code; a CHECK constrains the vocabulary. An open hold (released_at IS NULL)
-- blocks deletion of the target and everything transitively under it.
CREATE TABLE retention_holds (
  id CHAR(36) NOT NULL,
  hold_type VARCHAR(20) NOT NULL,
  target_kind VARCHAR(20) NOT NULL,
  target_id CHAR(36) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  released_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_retention_holds_target (target_kind, target_id, released_at),
  CONSTRAINT chk_retention_holds_type CHECK (
    hold_type IN ('investigation', 'retention', 'manual')
  ),
  CONSTRAINT chk_retention_holds_target_kind CHECK (
    target_kind IN ('aggregation_run', 'ranking_run', 'workflow_run')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutable archive manifest, one row per (run, source_table) export. All
-- integrity + provenance fields DATASET.md Phase 5 requires. No secret is ever
-- stored here (object key/provider only; never a credential).
CREATE TABLE archived_run_manifests (
  id CHAR(36) NOT NULL,
  run_kind VARCHAR(20) NOT NULL,
  run_id CHAR(36) NOT NULL,
  source_table VARCHAR(64) NOT NULL,
  schema_version VARCHAR(20) NOT NULL,
  row_count BIGINT UNSIGNED NOT NULL,
  min_id CHAR(36) NULL,
  max_id CHAR(36) NULL,
  min_created_at DATETIME(3) NULL,
  max_created_at DATETIME(3) NULL,
  uncompressed_bytes BIGINT UNSIGNED NOT NULL,
  archive_bytes BIGINT UNSIGNED NULL,
  original_sha256 CHAR(64) NOT NULL,
  archive_sha256 CHAR(64) NULL,
  code_version VARCHAR(64) NULL,
  rule_set_version VARCHAR(64) NULL,
  patch_context VARCHAR(64) NULL,
  object_provider VARCHAR(30) NOT NULL,
  object_bucket VARCHAR(100) NOT NULL,
  object_key VARCHAR(512) NOT NULL,
  verification_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  verification_count INT NOT NULL DEFAULT 0,
  staging_reimport_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  verified_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_archived_run_object (object_bucket, object_key),
  UNIQUE KEY uniq_archived_run_source (run_kind, run_id, source_table),
  KEY idx_archived_run_lookup (run_kind, run_id),
  CONSTRAINT chk_archived_run_kind CHECK (run_kind IN ('aggregation_run', 'ranking_run')),
  CONSTRAINT chk_archived_run_verification CHECK (
    verification_status IN ('pending', 'verified', 'failed')
  ),
  CONSTRAINT chk_archived_run_reimport CHECK (
    staging_reimport_status IN ('pending', 'passed', 'failed')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per deletion batch (dry-run OR real). Records exactly what was (or
-- would be) removed, so deletion is auditable, resumable, and idempotent.
CREATE TABLE retention_deletion_manifests (
  id CHAR(36) NOT NULL,
  run_kind VARCHAR(20) NOT NULL,
  run_id CHAR(36) NOT NULL,
  source_table VARCHAR(64) NOT NULL,
  batch_number INT NOT NULL,
  rows_deleted INT NOT NULL,
  min_pk CHAR(36) NULL,
  max_pk CHAR(36) NULL,
  dry_run TINYINT(1) NOT NULL DEFAULT 1,
  archived_run_manifest_id CHAR(36) NULL,
  executed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_retention_deletion_run (run_kind, run_id, source_table),
  CONSTRAINT fk_retention_deletion_manifest
    FOREIGN KEY (archived_run_manifest_id) REFERENCES archived_run_manifests (id),
  CONSTRAINT chk_retention_deletion_kind CHECK (run_kind IN ('aggregation_run', 'ranking_run'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
