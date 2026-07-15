-- Phase 3: Canonical player and club entities.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.6 (canonical entity model —
-- a renamed player is a name-history entry on the same row, never a new
-- canonical row), Section 7.20 (minimized PII: tag, in-game name, trophy
-- count, club tag, Brawler-usage history only — no real-world identity),
-- Section 7.21 (normalized_players/normalized_clubs).

CREATE TABLE normalized_clubs (
  id CHAR(36) NOT NULL,
  club_tag VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NULL,
  club_type VARCHAR(20) NULL,
  trophies INT NULL,
  required_trophies INT NULL,
  member_count INT NULL,
  last_synced_at DATETIME(3) NULL,
  last_fetch_run_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_normalized_clubs_tag (club_tag),
  KEY idx_normalized_clubs_last_synced (last_synced_at),
  CONSTRAINT fk_normalized_clubs_fetch_run
    FOREIGN KEY (last_fetch_run_id) REFERENCES data_fetch_runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- club_type is stored as observed (open/inviteOnly/closed per the official
-- API) with application-layer validation rather than a native ENUM,
-- consistent with Section 25's "VARCHAR + application validation" default.

CREATE TABLE normalized_players (
  id CHAR(36) NOT NULL,
  player_tag VARCHAR(20) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  name_color VARCHAR(20) NULL,
  trophies INT NULL,
  highest_trophies INT NULL,
  exp_level INT NULL,
  club_id CHAR(36) NULL,
  region VARCHAR(10) NULL,
  is_reachable TINYINT(1) NOT NULL DEFAULT 1,
  unreachable_reason VARCHAR(50) NULL,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  last_fetch_run_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_normalized_players_tag (player_tag),
  KEY idx_normalized_players_club_id (club_id),
  KEY idx_normalized_players_region (region),
  KEY idx_normalized_players_reachable (is_reachable),
  CONSTRAINT fk_normalized_players_club
    FOREIGN KEY (club_id) REFERENCES normalized_clubs (id),
  CONSTRAINT fk_normalized_players_fetch_run
    FOREIGN KEY (last_fetch_run_id) REFERENCES data_fetch_runs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- is_reachable/unreachable_reason distinguish a genuine stale/invalid tag
-- (404, Section 7.24) from a transient failure — a temporary failure
-- (timeout, 5xx) must never flip is_reachable to 0 (Section 7 task rules);
-- only a confirmed 404 does, and only after retry policy is exhausted
-- (lib/ingestion/retry.ts).

CREATE TABLE player_name_history (
  id CHAR(36) NOT NULL,
  player_id CHAR(36) NOT NULL,
  previous_name VARCHAR(100) NOT NULL,
  recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_player_name_history_player_id (player_id),
  CONSTRAINT fk_player_name_history_player
    FOREIGN KEY (player_id) REFERENCES normalized_players (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
