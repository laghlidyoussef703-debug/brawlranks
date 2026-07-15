-- Phase 2: Canonical Brawler catalog — the first production vertical slice.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.6 (canonical entity model),
-- Section 7.21 (canonical_brawlers refinement, gadgets, star_powers),
-- Section 25.1 (brawlers/brawler_aliases/gadgets/star_powers as existing
-- content tables).
--
-- Deliberately does NOT include rarity, class, description, or image
-- columns: the official API payload shape has not been independently
-- verified in this session (see PHASE2.md "Known Limitations"), and the
-- task rules are explicit that unverified fields must not be assumed.
-- These columns can be added by a later migration once confirmed.
--
-- source_brawler_id is the external identity (Section 7.6's "Official
-- API's Brawler identifier ... mapped 1:1"). slug is generated once at
-- first sync and never changes meaning — a rename produces a
-- brawler_aliases row, never a new canonical_brawlers row or a slug change
-- (Section 7.6's alias-handling rule).

CREATE TABLE canonical_brawlers (
  id CHAR(36) NOT NULL,
  source_brawler_id VARCHAR(50) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  deactivated_at DATETIME(3) NULL,
  last_fetch_run_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_canonical_brawlers_source_id (source_brawler_id),
  UNIQUE KEY uniq_canonical_brawlers_slug (slug),
  KEY idx_canonical_brawlers_is_active (is_active),
  CONSTRAINT fk_canonical_brawlers_last_fetch_run
    FOREIGN KEY (last_fetch_run_id) REFERENCES data_fetch_runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- brawler_aliases: name-change history. A renamed Brawler gets a new alias
-- row here, never a new canonical_brawlers row (Section 7.6).
CREATE TABLE brawler_aliases (
  id CHAR(36) NOT NULL,
  brawler_id CHAR(36) NOT NULL,
  alias VARCHAR(100) NOT NULL,
  alias_type VARCHAR(20) NOT NULL DEFAULT 'name_history',
  recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_brawler_aliases_brawler_alias (brawler_id, alias),
  KEY idx_brawler_aliases_brawler_id (brawler_id),
  CONSTRAINT fk_brawler_aliases_brawler
    FOREIGN KEY (brawler_id) REFERENCES canonical_brawlers (id),
  CONSTRAINT chk_brawler_aliases_type CHECK (
    alias_type IN ('name_history', 'old_slug', 'localized')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- gadgets / star_powers: normalized only because the official catalog
-- endpoint is expected to expose stable per-item identifiers alongside each
-- Brawler (Section 7.1's capability table lists this as an expected field
-- to verify). Ingestion is defensive: if a sync's payload omits these
-- arrays for a Brawler, nothing is written and nothing errors — see
-- lib/catalog/normalize.ts. Gears are NOT created here: their availability
-- in the catalog endpoint has not been confirmed, and the task rules
-- prohibit inventing gear data.
CREATE TABLE gadgets (
  id CHAR(36) NOT NULL,
  brawler_id CHAR(36) NOT NULL,
  source_gadget_id VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_gadgets_brawler_source_id (brawler_id, source_gadget_id),
  KEY idx_gadgets_brawler_id (brawler_id),
  CONSTRAINT fk_gadgets_brawler
    FOREIGN KEY (brawler_id) REFERENCES canonical_brawlers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE star_powers (
  id CHAR(36) NOT NULL,
  brawler_id CHAR(36) NOT NULL,
  source_star_power_id VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_star_powers_brawler_source_id (brawler_id, source_star_power_id),
  KEY idx_star_powers_brawler_id (brawler_id),
  CONSTRAINT fk_star_powers_brawler
    FOREIGN KEY (brawler_id) REFERENCES canonical_brawlers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
