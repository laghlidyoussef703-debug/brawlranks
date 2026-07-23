-- DATASET Phase 4: raw API snapshot archival metadata.
-- Spec: DATASET.md Phase 4 ("Raw API snapshot archival").
--
-- Companion table to raw_api_snapshots. It records, per snapshot, where the
-- gzip'd payload was durably archived (object storage), the two integrity
-- hashes, and the state-machine status of the copy/verify pipeline. It NEVER
-- stores the payload itself, and this migration does NOT alter raw_api_snapshots
-- in any way — the payload stays NOT NULL. Making the payload nullable is a
-- separate, later, separately-approved migration (DATASET.md WP5) and is out of
-- scope here.
--
-- One archive row per snapshot: PRIMARY KEY (raw_snapshot_id). raw_snapshot_id
-- both identifies and foreign-keys to raw_api_snapshots(id) (CHAR(36) UUID).
--
-- original_checksum is the SHA-256 of the raw payload bytes — the SAME value
-- already stored in raw_api_snapshots.checksum (verified: checksum = SHA2(
-- payload,256)). The worker re-verifies it against the live payload before
-- upload. object_checksum is the SHA-256 of the COMPRESSED object bytes; it is
-- NULL until the object is uploaded and verified. Do not treat an S3/Spaces
-- multipart ETag as a SHA-256.
--
-- Lease columns (lease_owner, lease_expires_at) extend the DATASET.md draft.
-- They are justified: the state machine must recover an 'uploading' row whose
-- worker died mid-upload. A worker claims a row by stamping lease_owner (its
-- workflow/run id) and a future lease_expires_at; another worker may reclaim an
-- 'uploading'/'failed' row only once its lease has expired. upload_started_at
-- alone cannot express "who holds it" or "when it may be safely reclaimed", so
-- these two columns are added deliberately rather than overloading timestamps.
--
-- archive_status values (also enforced by chk_raw_archive_status):
--   pending    — row enqueued, no upload attempted yet
--   uploading  — a worker holds a lease and is copying/verifying
--   verified   — object present and both hashes confirmed (payload still NOT
--                NULL in raw_api_snapshots; nulling is a separate later step)
--   failed     — an attempt failed; eligible for retry after next_attempt_at

CREATE TABLE raw_snapshot_archives (
  raw_snapshot_id CHAR(36) NOT NULL,
  object_provider VARCHAR(30) NOT NULL,
  object_bucket VARCHAR(100) NOT NULL,
  object_key VARCHAR(512) NOT NULL,
  compression VARCHAR(10) NOT NULL,
  original_size_bytes BIGINT UNSIGNED NOT NULL,
  object_size_bytes BIGINT UNSIGNED NULL,
  original_checksum CHAR(64) NOT NULL,
  object_checksum CHAR(64) NULL,
  archive_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempt_count INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NULL,
  last_error_code VARCHAR(80) NULL,
  lease_owner VARCHAR(64) NULL,
  lease_expires_at DATETIME(3) NULL,
  upload_started_at DATETIME(3) NULL,
  archived_at DATETIME(3) NULL,
  verified_at DATETIME(3) NULL,
  payload_removed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (raw_snapshot_id),
  UNIQUE KEY uniq_raw_archive_object (object_bucket, object_key),
  KEY idx_raw_archive_queue (archive_status, next_attempt_at),
  KEY idx_raw_archive_lease (archive_status, lease_expires_at),
  CONSTRAINT fk_raw_archive_snapshot
    FOREIGN KEY (raw_snapshot_id) REFERENCES raw_api_snapshots (id),
  CONSTRAINT chk_raw_archive_status CHECK (
    archive_status IN ('pending', 'uploading', 'verified', 'failed')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
