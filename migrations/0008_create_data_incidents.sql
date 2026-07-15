-- Phase 2: Incident/quarantine records.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.24 (Data-Quality Gates,
-- quarantine behavior), Section 7.21 (data_incidents).
--
-- detail is LONGTEXT (JSON-serialized) and must never contain a database
-- password, the proxy shared secret, an Authorization header value, or any
-- other secret — enforced in lib/catalog/incidents.ts, which only ever
-- writes safe, pre-sanitized diagnostic fields.

CREATE TABLE data_incidents (
  id CHAR(36) NOT NULL,
  incident_type VARCHAR(50) NOT NULL,
  related_fetch_run_id CHAR(36) NULL,
  related_entity_type VARCHAR(50) NULL,
  related_entity_id VARCHAR(100) NULL,
  detail LONGTEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  resolved_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_data_incidents_incident_type (incident_type),
  KEY idx_data_incidents_status (status),
  KEY idx_data_incidents_fetch_run_id (related_fetch_run_id),
  CONSTRAINT fk_data_incidents_fetch_run
    FOREIGN KEY (related_fetch_run_id) REFERENCES data_fetch_runs (id),
  CONSTRAINT chk_data_incidents_type CHECK (
    incident_type IN (
      'schema_mismatch', 'invalid_value', 'unknown_entity',
      'volume_collapse', 'source_disagreement', 'partial_payload',
      'transaction_failure', 'checksum_inconsistency'
    )
  ),
  CONSTRAINT chk_data_incidents_status CHECK (
    status IN ('open', 'investigating', 'resolved', 'wont_fix')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
