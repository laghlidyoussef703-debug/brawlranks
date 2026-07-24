-- DATASET Phase 5 additive hardening. 0027/0028 were already applied before
-- these issues were found, so they remain byte-for-byte immutable and every
-- correction is forward-only here.

ALTER TABLE archived_run_manifests
  ADD COLUMN verification_results LONGTEXT NULL AFTER staging_reimport_status,
  ADD COLUMN staging_reimport_result LONGTEXT NULL AFTER verification_results;

ALTER TABLE retention_deletion_manifests
  ADD COLUMN batch_cursor CHAR(36) NULL AFTER batch_number,
  ADD COLUMN attempted_rows INT NOT NULL DEFAULT 0 AFTER batch_cursor,
  ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'planned' AFTER archived_run_manifest_id,
  ADD COLUMN started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER status,
  ADD COLUMN completed_at DATETIME(3) NULL AFTER started_at,
  ADD COLUMN failure_reason VARCHAR(255) NULL AFTER completed_at,
  ADD UNIQUE KEY uniq_retention_deletion_checkpoint (run_kind, run_id, source_table, batch_number, dry_run),
  ADD KEY idx_retention_deletion_status (run_kind, run_id, source_table, status),
  ADD CONSTRAINT chk_retention_deletion_status CHECK (status IN ('planned', 'completed', 'failed'));

CREATE TABLE archived_run_verification_evidence (
  id CHAR(36) NOT NULL,
  archived_run_manifest_id CHAR(36) NOT NULL,
  pass_number INT NOT NULL,
  object_size BIGINT UNSIGNED NULL,
  archive_sha256 CHAR(64) NULL,
  original_sha256 CHAR(64) NULL,
  row_count BIGINT UNSIGNED NULL,
  result VARCHAR(20) NOT NULL,
  failure_reason VARCHAR(80) NULL,
  verified_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_archived_run_verification_pass (archived_run_manifest_id, pass_number, result),
  CONSTRAINT fk_archived_run_verification_manifest
    FOREIGN KEY (archived_run_manifest_id) REFERENCES archived_run_manifests (id),
  CONSTRAINT chk_archived_run_verification_result CHECK (result IN ('passed', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE retention_environment_attestations (
  environment_id CHAR(36) NOT NULL,
  purpose VARCHAR(30) NOT NULL,
  confirmed_by VARCHAR(64) NOT NULL,
  evidence_reference VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (environment_id),
  CONSTRAINT chk_retention_environment_purpose CHECK (purpose IN ('isolated_staging'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE aggregate_trend_summaries
  DROP INDEX uniq_trend_summary_scope,
  ADD COLUMN patch_key CHAR(36) NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000' AFTER patch_id,
  ADD COLUMN game_mode_key CHAR(36) NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000' AFTER game_mode_id;

UPDATE aggregate_trend_summaries
   SET patch_key = IFNULL(patch_id, '00000000-0000-0000-0000-000000000000'),
       game_mode_key = IFNULL(game_mode_id, '00000000-0000-0000-0000-000000000000');

ALTER TABLE aggregate_trend_summaries
  ADD UNIQUE KEY uniq_trend_summary_scope (summary_date, patch_key, brawler_id, game_mode_key, scope);
