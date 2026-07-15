-- Phase 3: Canonical game mode and map catalog.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.6 (canonical entity model —
-- modes/maps get the same alias-on-rename treatment as Brawlers), Section
-- 7.21 (canonical_game_modes/canonical_maps/mode_aliases/map_aliases).
--
-- source_mode_id is the mode's string identifier as reported by the
-- official API's event.mode field (e.g. "brawlBall") — the API does not
-- expose a separate numeric mode id, so the string itself is the stable
-- external identity (verified via three independent third-party mirrors of
-- the official API this session — see PHASE3.md "Endpoint verification").
-- source_map_id is the map's string name (event.map) for the same reason.
-- event.id (a numeric rotation-slot identifier) is NOT the map's identity —
-- it identifies a specific rotation occurrence and is stored on
-- battle_events/normalized_battles instead (migration 0014).

CREATE TABLE canonical_game_modes (
  id CHAR(36) NOT NULL,
  source_mode_id VARCHAR(100) NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  deactivated_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_canonical_game_modes_source_id (source_mode_id),
  KEY idx_canonical_game_modes_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE mode_aliases (
  id CHAR(36) NOT NULL,
  game_mode_id CHAR(36) NOT NULL,
  alias VARCHAR(100) NOT NULL,
  alias_type VARCHAR(20) NOT NULL DEFAULT 'name_history',
  recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_mode_aliases_mode_alias (game_mode_id, alias),
  KEY idx_mode_aliases_mode_id (game_mode_id),
  CONSTRAINT fk_mode_aliases_mode
    FOREIGN KEY (game_mode_id) REFERENCES canonical_game_modes (id),
  CONSTRAINT chk_mode_aliases_type CHECK (
    alias_type IN ('name_history', 'old_slug')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A map is associated with one primary mode (game_mode_id nullable only
-- because a small number of maps/rotations may appear before mode
-- resolution completes within the same sync — never left permanently null
-- by design).
CREATE TABLE canonical_maps (
  id CHAR(36) NOT NULL,
  source_map_id VARCHAR(150) NOT NULL,
  name VARCHAR(150) NOT NULL,
  game_mode_id CHAR(36) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  deactivated_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_canonical_maps_source_id (source_map_id),
  KEY idx_canonical_maps_is_active (is_active),
  KEY idx_canonical_maps_game_mode_id (game_mode_id),
  CONSTRAINT fk_canonical_maps_game_mode
    FOREIGN KEY (game_mode_id) REFERENCES canonical_game_modes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE map_aliases (
  id CHAR(36) NOT NULL,
  map_id CHAR(36) NOT NULL,
  alias VARCHAR(150) NOT NULL,
  alias_type VARCHAR(20) NOT NULL DEFAULT 'name_history',
  recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_map_aliases_map_alias (map_id, alias),
  KEY idx_map_aliases_map_id (map_id),
  CONSTRAINT fk_map_aliases_map
    FOREIGN KEY (map_id) REFERENCES canonical_maps (id),
  CONSTRAINT chk_map_aliases_type CHECK (
    alias_type IN ('name_history', 'old_slug')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
