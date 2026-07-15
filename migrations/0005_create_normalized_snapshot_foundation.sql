-- Phase 2: Normalized snapshot foundation (layer B input to change detection).
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.5 (layer B), Section 8 (change
-- detection compares "new normalized snapshot against the last accepted
-- normalized snapshot"), Section 25.2 (normalized_snapshots).
--
-- One row per (entity_type, entity_id) per fetch run. is_accepted marks the
-- current "last accepted" state for that entity — the generated-column
-- unique pattern guarantees at most one accepted row can exist per entity
-- at the database level, not just by application discipline.
--
-- entity_id is the SOURCE-native identifier (e.g. the official Brawler ID
-- as a string), not the internal canonical_brawlers.id UUID — this table is
-- the audit/diff trail that exists prior to canonical resolution.

CREATE TABLE normalized_snapshots (
  id CHAR(36) NOT NULL,
  data_fetch_run_id CHAR(36) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(100) NOT NULL,
  normalized_payload LONGTEXT NOT NULL,
  payload_checksum CHAR(64) NOT NULL,
  is_accepted TINYINT(1) NOT NULL DEFAULT 0,
  accepted_flag TINYINT GENERATED ALWAYS AS (IF(is_accepted = 1, 1, NULL)) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_normalized_snapshots_accepted (entity_type, entity_id, accepted_flag),
  KEY idx_normalized_snapshots_entity (entity_type, entity_id, is_accepted),
  KEY idx_normalized_snapshots_fetch_run_id (data_fetch_run_id),
  CONSTRAINT fk_normalized_snapshots_fetch_run
    FOREIGN KEY (data_fetch_run_id) REFERENCES data_fetch_runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
