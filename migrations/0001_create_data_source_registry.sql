-- Phase 2: Data source and endpoint inventory.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 25.2 (data_sources), Section 7.21 (source_endpoints).
--
-- data_sources: registry of every configured external/internal data source.
-- Only the already-approved "Official Brawl Stars API" source is seeded by
-- this migration's companion seed script (scripts/seed-sources.mjs) — no
-- fictional sources are created here.

CREATE TABLE data_sources (
  id CHAR(36) NOT NULL,
  name VARCHAR(100) NOT NULL,
  source_type VARCHAR(30) NOT NULL,
  reliability_weight DECIMAL(4,3) NOT NULL DEFAULT 1.000,
  priority_rank INT NOT NULL DEFAULT 100,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  credentials_ref VARCHAR(255) NULL,
  config LONGTEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_data_sources_name (name),
  KEY idx_data_sources_source_type (source_type),
  KEY idx_data_sources_is_enabled (is_enabled),
  CONSTRAINT chk_data_sources_source_type CHECK (
    source_type IN ('official_api', 'official_notes', 'first_party_import', 'statistical_provider', 'internal')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- source_endpoints: catalogues confirmed, in-use endpoints per source.
-- "No endpoint may be used in production until it has been verified"
-- (Section 7.1) — verified_at is set only when a real, working fetch has
-- been confirmed through this endpoint, never speculatively.
CREATE TABLE source_endpoints (
  id CHAR(36) NOT NULL,
  data_source_id CHAR(36) NOT NULL,
  endpoint_category VARCHAR(50) NOT NULL,
  path VARCHAR(255) NOT NULL,
  method VARCHAR(10) NOT NULL DEFAULT 'GET',
  schema_version VARCHAR(20) NOT NULL DEFAULT 'v1',
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  verified_at DATETIME(3) NULL,
  verified_against_doc_version VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_source_endpoints_source_category (data_source_id, endpoint_category),
  KEY idx_source_endpoints_data_source_id (data_source_id),
  KEY idx_source_endpoints_endpoint_category (endpoint_category),
  CONSTRAINT fk_source_endpoints_data_source
    FOREIGN KEY (data_source_id) REFERENCES data_sources (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
