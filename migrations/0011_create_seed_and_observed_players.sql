-- Phase 3: Player-sampling foundation — deliberate seed set vs. organically
-- discovered candidates.
-- Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 7.3 (sampling strategy),
-- Section 7.21 (seed_players/observed_players).
--
-- seed_players is the deliberately-chosen starting set (from rankings/club
-- seeding); observed_players is the "pending promotion" holding area for
-- players discovered as battle participants or club members — never
-- directly promoted to the active crawl set (player_crawl_schedule,
-- migration 0012) without passing through the promotion-rule check in
-- lib/ingestion/sampling.ts, which prevents the sample from organically
-- drifting toward one social/region cluster (Section 7.3's stated risk).

CREATE TABLE seed_players (
  id CHAR(36) NOT NULL,
  player_tag VARCHAR(20) NOT NULL,
  seed_source VARCHAR(20) NOT NULL,
  region VARCHAR(10) NULL,
  trophy_bracket VARCHAR(20) NULL,
  latest_rank INT NULL,
  latest_trophies INT NULL,
  last_observed_at DATETIME(3) NULL,
  is_stale TINYINT(1) NOT NULL DEFAULT 0,
  added_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_seed_players_tag (player_tag),
  KEY idx_seed_players_source (seed_source),
  KEY idx_seed_players_region (region),
  KEY idx_seed_players_bracket (trophy_bracket),
  KEY idx_seed_players_stale (is_stale),
  CONSTRAINT chk_seed_players_source CHECK (
    seed_source IN ('global_rank', 'country_rank', 'club', 'manual', 'observed_promotion')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Failing to fetch one region never deletes the seed pool (Section 7.3's
-- "avoid destructive deletion" rule) — a region refresh failure only skips
-- updating is_stale/latest_* for that region's rows this cycle; existing
-- rows are left as-is, marked stale only once independently confirmed
-- absent from a *successful* subsequent refresh.

CREATE TABLE observed_players (
  id CHAR(36) NOT NULL,
  player_tag VARCHAR(20) NOT NULL,
  first_observed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  source_type VARCHAR(20) NOT NULL,
  source_detail LONGTEXT NULL,
  promoted_to_active TINYINT(1) NOT NULL DEFAULT 0,
  promoted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uniq_observed_players_tag (player_tag),
  KEY idx_observed_players_promoted (promoted_to_active),
  CONSTRAINT chk_observed_players_source_type CHECK (
    source_type IN ('battle_participant', 'club_member', 'ranking_adjacent')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- source_detail is a small LONGTEXT JSON context object (e.g. which battle
-- or club tag surfaced this player) for discovery-source traceability
-- (Section 7.3's "preserve source relationship" requirement) — never a
-- secret, never used as a join key.
