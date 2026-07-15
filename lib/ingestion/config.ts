/**
 * Configuration constants for Phase 3 ingestion. Deliberately conservative
 * defaults (Section 7.3/7.23/7.28's owner-decision placeholders) — none of
 * these are verified-optimal values, they are safe starting points meant
 * to be tuned once real usage is observed. See PHASE3.md.
 */

export const DATA_SOURCE_NAME = "official-brawl-stars-api";

export const ENDPOINT_CATEGORY = {
  BRAWLERS_CATALOG: "brawlers_catalog",
  PLAYER_RANKINGS: "player_rankings",
  CLUB_RANKINGS: "club_rankings",
  BRAWLER_RANKINGS: "brawler_rankings",
  PLAYER_PROFILE: "player_profile",
  BATTLE_LOG: "battle_log",
  CLUB_PROFILE: "club_profile",
  EVENTS_ROTATION: "events_rotation",
} as const;

/** Curated initial region set (Section 7.28 owner decision — "a curated initial subset" recommendation). */
export const INITIAL_RANKING_REGIONS = ["global"];

export const DEFAULT_CRAWL_BATCH_SIZE = 25;
export const DEFAULT_LEASE_SECONDS = 120;
export const DEFAULT_DISCOVERY_PROMOTION_BATCH_SIZE = 20;

/** A player deactivated from the active crawl set after this many consecutive failures (Section 7's "maximum consecutive failure policy"). */
export const MAX_CONSECUTIVE_CRAWL_FAILURES = 5;

/** Minimum re-crawl interval for a successfully-crawled player (Section 7.22's battle-log crawl cadence, conservative starting point). */
export const DEFAULT_RECRAWL_INTERVAL_MS = 3 * 60 * 60_000;

/** Mass-removal-style guard for seed pool refreshes: a region losing more than this fraction of its previously-seen seed rows in one refresh is suspect, not applied destructively. */
export const SEED_STALE_RATIO_GUARD = 0.5;
