-- Phase 5.1: Internal, inferred patch tracking.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.6 (patches are a canonical
-- entity, "never renamed after the fact"), Section 7.7 (Official Patch
-- Notes Pipeline), Section 7.8/9.1 (nearly every aggregation/ranking table
-- is patch_id-scoped), Section 25.1 (patches listed among existing content
-- tables), Section 26.4 (the generated-column single-active-row pattern).
--
-- Honesty note (this is a deliberate, scoped-down interpretation of Section
-- 7.7, not a full implementation of it): the official Brawl Stars API
-- exposes no version/patch field anywhere in the endpoints this app
-- actually calls (lib/proxy.ts has no patch-notes endpoint, and
-- lib/catalog/changeDetection.ts's own header comment already documents
-- that the catalog endpoint "carries no numeric stats, game modes, or
-- patch version"). No official patch-notes source is confirmed or wired up
-- this phase. `source` is therefore constrained to
-- 'inferred_from_catalog_change' only, for now — a patch record here is
-- BrawlRanks' own internal signal that "the canonical Brawler catalog
-- changed in a meaningful way," never a claim about Supercell's real
-- version identifier. `version_label` is deliberately timestamp-derived
-- and application-generated (see lib/patches/patchInference.ts), never a
-- fabricated Supercell version string.
--
-- Only one row may have status = 'active' at a time — enforced at the
-- database level via the same generated-column unique pattern already
-- used by workflow_locks (migration 0002) and normalized_snapshots
-- (migration 0005), not by application logic alone.

CREATE TABLE patches (
  id CHAR(36) NOT NULL,
  version_label VARCHAR(64) NOT NULL,
  source VARCHAR(40) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  detected_at DATETIME(3) NOT NULL,
  effective_at DATETIME(3) NOT NULL,
  triggering_fetch_run_id CHAR(36) NULL,
  triggering_change_summary LONGTEXT NULL,
  active_flag TINYINT GENERATED ALWAYS AS (IF(status = 'active', 1, NULL)) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_patches_version_label (version_label),
  UNIQUE KEY uniq_patches_active (active_flag),
  KEY idx_patches_detected_at (detected_at),
  KEY idx_patches_status (status),
  CONSTRAINT fk_patches_triggering_fetch_run
    FOREIGN KEY (triggering_fetch_run_id) REFERENCES data_fetch_runs (id),
  CONSTRAINT chk_patches_source CHECK (
    source IN ('inferred_from_catalog_change')
  ),
  CONSTRAINT chk_patches_status CHECK (
    status IN ('active', 'superseded')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- normalized_battles.patch_id already exists as a nullable CHAR(36) column
-- (migration 0014 — added ahead of time, explicitly documented there as
-- "left for Phase 4 to populate", i.e. this phase). It has never had an
-- index or a foreign key, since `patches` did not exist until now. Both are
-- added here, additively, with no data rewrite: every existing row's
-- patch_id is already NULL (Phase 3/4 never populated it), which remains
-- valid and permanent for battles collected before patch tracking existed
-- — never backfilled with a guess.
ALTER TABLE normalized_battles
  ADD KEY idx_normalized_battles_patch_id (patch_id),
  ADD CONSTRAINT fk_normalized_battles_patch
    FOREIGN KEY (patch_id) REFERENCES patches (id);
