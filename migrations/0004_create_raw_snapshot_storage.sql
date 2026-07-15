-- Phase 2: Immutable raw source snapshot storage.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.5 (layer A), Section 7.21
-- (raw_api_snapshots).
--
-- Rows in this table are never UPDATEd or DELETEd by application code —
-- append-only by convention, enforced in lib/catalog/repository.ts (no
-- UPDATE/DELETE statement targets this table anywhere in the codebase).
--
-- payload is LONGTEXT, not the MySQL JSON type: MariaDB's JSON type is a
-- LONGTEXT alias with a CHECK(JSON_VALID()) constraint, and MariaDB does
-- not support CAST(? AS JSON) the way MySQL 8 does (proven in production,
-- commit 3f48b38). Storing as plain LONGTEXT with valid JSON text avoids
-- that incompatibility entirely while remaining fully queryable via
-- JSON_EXTRACT() if ever needed.

CREATE TABLE raw_api_snapshots (
  id CHAR(36) NOT NULL,
  data_fetch_run_id CHAR(36) NOT NULL,
  endpoint_category VARCHAR(50) NOT NULL,
  payload LONGTEXT NOT NULL,
  checksum CHAR(64) NOT NULL,
  http_status INT NULL,
  source_reported_at DATETIME(3) NULL,
  received_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_raw_api_snapshots_fetch_run_id (data_fetch_run_id),
  KEY idx_raw_api_snapshots_endpoint_category (endpoint_category),
  KEY idx_raw_api_snapshots_created_at (created_at),
  CONSTRAINT fk_raw_api_snapshots_fetch_run
    FOREIGN KEY (data_fetch_run_id) REFERENCES data_fetch_runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
