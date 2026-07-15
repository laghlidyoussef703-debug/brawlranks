-- Phase 2: Change detection event storage.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 8 (Change Detection), Section
-- 25.2 (detected_changes).
--
-- Append-only. A no-change run writes zero rows here (Section 8.2: "the run
-- stops ... does not proceed to recalculation or publication") — the
-- absence of rows, combined with data_fetch_runs.changes_detected_count = 0
-- and status = 'success', IS the record of a no-change run.

CREATE TABLE detected_changes (
  id CHAR(36) NOT NULL,
  data_fetch_run_id CHAR(36) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id VARCHAR(100) NOT NULL,
  change_type VARCHAR(50) NOT NULL,
  field VARCHAR(100) NULL,
  old_value LONGTEXT NULL,
  new_value LONGTEXT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'info',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_detected_changes_entity (entity_type, entity_id, created_at),
  KEY idx_detected_changes_change_type (change_type),
  KEY idx_detected_changes_fetch_run_id (data_fetch_run_id),
  CONSTRAINT fk_detected_changes_fetch_run
    FOREIGN KEY (data_fetch_run_id) REFERENCES data_fetch_runs (id),
  CONSTRAINT chk_detected_changes_change_type CHECK (
    change_type IN (
      'new_brawler', 'brawler_removed_or_deprecated', 'stat_change',
      'gadget_change', 'star_power_change', 'gear_change',
      'new_game_mode', 'patch_version_change', 'schema_change',
      'missing_source_data', 'unexpected_mass_change'
    )
  ),
  CONSTRAINT chk_detected_changes_severity CHECK (
    severity IN ('info', 'warning', 'critical')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
