-- Phase 3: Normalized battle entities — deterministic identity, dedup, and
-- multi-observation traceability.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.4 (pipeline steps 6-13),
-- Section 7.6 (a battle's canonical id is DERIVED, not sourced directly —
-- "the API doesn't expose a stable global battle ID"), Section 7.21
-- (normalized_battles/battle_teams/battle_participants/battle_events).
--
-- normalized_battles.id is a normal application-generated UUID (consistent
-- with every other table in this schema); battle_key is the actual
-- deterministic dedup identity — a SHA-256 hex digest of the canonicalized
-- battle fields (see lib/ingestion/battleId.ts for the exact algorithm and
-- PHASE3.md for its full specification). Deduplication is enforced at the
-- database level via battle_key's UNIQUE constraint, not application logic
-- alone: a second observation of the same real battle always collides on
-- battle_key and is handled as a merge (battle_observations insert only),
-- never a second normalized_battles row.
--
-- Rows in normalized_battles/battle_teams/battle_participants are
-- append-only after first observation (Section 7.21: "upsert-on-first-
-- observation only, never mutated after") — richer detail from a later
-- observation of the same battle is captured via a new battle_observations
-- row, never by overwriting the first-observed row's content.

CREATE TABLE normalized_battles (
  id CHAR(36) NOT NULL,
  battle_key CHAR(64) NOT NULL,
  game_mode_id CHAR(36) NULL,
  map_id CHAR(36) NULL,
  event_source_id VARCHAR(50) NULL,
  battle_type VARCHAR(30) NULL,
  structure VARCHAR(20) NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  duration_seconds INT NULL,
  trophy_change INT NULL,
  patch_id CHAR(36) NULL,
  first_observed_fetch_run_id CHAR(36) NOT NULL,
  first_observed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_normalized_battles_key (battle_key),
  KEY idx_normalized_battles_mode_occurred (game_mode_id, occurred_at),
  KEY idx_normalized_battles_occurred_at (occurred_at),
  KEY idx_normalized_battles_map_id (map_id),
  CONSTRAINT fk_normalized_battles_game_mode
    FOREIGN KEY (game_mode_id) REFERENCES canonical_game_modes (id),
  CONSTRAINT fk_normalized_battles_map
    FOREIGN KEY (map_id) REFERENCES canonical_maps (id),
  CONSTRAINT fk_normalized_battles_fetch_run
    FOREIGN KEY (first_observed_fetch_run_id) REFERENCES data_fetch_runs (id),
  CONSTRAINT chk_normalized_battles_structure CHECK (
    structure IN ('teams', 'solo_ranked')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- structure = 'teams' for duo/3v3 battles (team grouping via battle_teams);
-- 'solo_ranked' for modes reporting a flat participant list with an
-- individual rank instead of a team result (e.g. Showdown), matching the
-- official API's teams-vs-players response shape (verified this session —
-- see PHASE3.md). patch_id is nullable: resolving a battle's occurred_at
-- against the patches table (Section 7.6/7.7) is out of scope for this
-- ingestion-only phase and is left for Phase 4 to populate.

CREATE TABLE battle_teams (
  id CHAR(36) NOT NULL,
  battle_id CHAR(36) NOT NULL,
  team_index INT NOT NULL,
  result VARCHAR(10) NOT NULL DEFAULT 'unknown',
  rank INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_battle_teams_battle_index (battle_id, team_index),
  KEY idx_battle_teams_battle_id (battle_id),
  CONSTRAINT fk_battle_teams_battle
    FOREIGN KEY (battle_id) REFERENCES normalized_battles (id),
  CONSTRAINT chk_battle_teams_result CHECK (
    result IN ('victory', 'defeat', 'draw', 'unknown')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- rank is populated only for solo_ranked-structure battles (e.g. Showdown
-- placement); NULL for team-result battles.

CREATE TABLE battle_participants (
  id CHAR(36) NOT NULL,
  battle_id CHAR(36) NOT NULL,
  battle_team_id CHAR(36) NULL,
  player_id CHAR(36) NOT NULL,
  brawler_id CHAR(36) NOT NULL,
  brawler_power INT NULL,
  brawler_trophies INT NULL,
  participant_index INT NOT NULL,
  is_star_player TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_battle_participants_battle_player (battle_id, player_id),
  KEY idx_battle_participants_battle_id (battle_id),
  KEY idx_battle_participants_brawler_id (brawler_id),
  KEY idx_battle_participants_player_id (player_id),
  CONSTRAINT fk_battle_participants_battle
    FOREIGN KEY (battle_id) REFERENCES normalized_battles (id),
  CONSTRAINT fk_battle_participants_team
    FOREIGN KEY (battle_team_id) REFERENCES battle_teams (id),
  CONSTRAINT fk_battle_participants_player
    FOREIGN KEY (player_id) REFERENCES normalized_players (id),
  CONSTRAINT fk_battle_participants_brawler
    FOREIGN KEY (brawler_id) REFERENCES canonical_brawlers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- No gadget_id/star_power_id/gear_ids columns: verified this session (three
-- independent mirrors of the official API, cross-checked against a typed
-- Rust client's battle-log struct — PHASE3.md "Endpoint verification")
-- that battle-log participants expose only {tag, name, brawler: {id, name,
-- power, trophies}} — Gadget/Star Power/Gear selection is confirmed NOT
-- present in this endpoint (Section 7.14's Build Data Limitation applies).
-- Adding these columns now would be inventing data the source doesn't
-- provide.

-- battle_observations: one row per (battle, fetch run) — the mechanism
-- that lets the same real battle be safely observed from many different
-- players' logs without ever duplicating the battle/team/participant rows
-- themselves.
CREATE TABLE battle_observations (
  id CHAR(36) NOT NULL,
  battle_id CHAR(36) NOT NULL,
  data_fetch_run_id CHAR(36) NOT NULL,
  observed_via_player_tag VARCHAR(20) NOT NULL,
  observed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_battle_observations_battle_run (battle_id, data_fetch_run_id),
  KEY idx_battle_observations_battle_id (battle_id),
  KEY idx_battle_observations_fetch_run_id (data_fetch_run_id),
  CONSTRAINT fk_battle_observations_battle
    FOREIGN KEY (battle_id) REFERENCES normalized_battles (id),
  CONSTRAINT fk_battle_observations_fetch_run
    FOREIGN KEY (data_fetch_run_id) REFERENCES data_fetch_runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
