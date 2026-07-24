-- DATASET Phase 14: raw_api_snapshots payload lifecycle (payload nulling after a
-- verified external archive + grace period). Spec: DATASET.md Phase 14
-- (`raw_api_snapshots` row: "metadata forever; payload through verified archive +
-- 7-day grace ... only payload becomes NULL").
--
-- Additive + forward-only. It does two things, neither destructive:
--
--  1. Widens raw_api_snapshots.payload to NULL. This is the ONE sanctioned
--     exception to the table's append-only convention (migration 0004): a
--     VERIFIED, grace-passed, re-verified archived snapshot may have ONLY its
--     `payload` set to NULL — the row and every other column (metadata) are
--     preserved forever, and no row is ever deleted. Widening a NOT NULL column
--     to NULL rewrites no data and cannot fail on existing rows.
--
--  2. Adds raw_payload_removal_manifests: one row per payload-removal SWEEP
--     (dry-run AND real), recording candidates, removed, skipped, failed,
--     reclaimed bytes, timings, and a details JSON (per-reason skip counts +
--     failures), so every sweep is auditable, resumable, and idempotent.
--
-- Nulling the payload requires: an archive row in `verified` status with a stored
-- object + original SHA-256, at least a 7-day grace since verified_at, and a
-- re-verification of the object AND the live payload immediately before removal.
-- That gating lives in lib/retention/rawPayload.ts, not in this migration.

ALTER TABLE raw_api_snapshots
  MODIFY COLUMN payload LONGTEXT NULL;

CREATE TABLE raw_payload_removal_manifests (
  id CHAR(36) NOT NULL,
  workflow_run_id CHAR(36) NULL,
  dry_run TINYINT(1) NOT NULL DEFAULT 1,
  destructive_enabled TINYINT(1) NOT NULL DEFAULT 0,
  grace_days INT NOT NULL,
  batch_size INT NOT NULL,
  scan_limit INT NOT NULL,
  candidates INT NOT NULL DEFAULT 0,
  removed INT NOT NULL DEFAULT 0,
  skipped INT NOT NULL DEFAULT 0,
  failed INT NOT NULL DEFAULT 0,
  reclaimed_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  details LONGTEXT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_raw_payload_removal_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
