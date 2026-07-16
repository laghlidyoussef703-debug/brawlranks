/**
 * Data retention policy (BRAWLRANKS_WEBSITE_SPEC.md Section 7.20 — Phase
 * 4.8 is the first phase to actually enforce it; previously documented as
 * a known limitation, never scheduled).
 *
 * Every window below is a CONFIGURED, CONSERVATIVE default — consistent
 * with every other "configured not measured" constant in this codebase
 * (rate budgets, cadence) — not a value derived from real storage-pressure
 * data, since no production access exists this session. Centralized here,
 * not scattered across call sites, matching the task's explicit
 * requirement.
 *
 * Explicitly OUT of scope for this phase (per the task's own retention
 * list): published/aggregated data (doesn't exist yet — Phase 5+),
 * normalized_snapshots/detected_changes (Phase 2's catalog change-
 * detection audit trail, untouched — "do not rebuild Phase 2 systems").
 *
 * "Unreachable/dead players" retention is deliberately NOT a deletion
 * policy: Section 7.3 is explicit that inactive players are deprioritized,
 * never deleted (their historical battle contributions remain valid) —
 * player_crawl_schedule.is_active = 0 (already implemented in Phase 3) IS
 * the retention mechanism for this category. Deleting a normalized_players
 * row would also violate the "normalized battles must not be deleted
 * prematurely" rule, since battle_participants.player_id references it.
 */

export const RETENTION_DAYS = {
  /** Section 7.20's own example figure for raw_api_snapshots. */
  RAW_SNAPSHOT: 90,
  /** Longer than raw snapshots — this is the actual Phase 5 aggregation input, plus a debugging buffer (Section 7.20). */
  NORMALIZED_BATTLE: 180,
  /** Section 7.20: "e.g., 12 months" for data_fetch_runs. */
  FETCH_RUN: 365,
  WORKFLOW_RUN: 365,
  /** Section 7.20: "6–12 months" for quarantined/resolved incidents. */
  RESOLVED_INCIDENT: 270,
  /** Section 7.21: observed_players "pruned periodically for players never promoted and not re-observed within a configured window." */
  UNPROMOTED_OBSERVED_PLAYER: 60,
  PLAYER_NAME_HISTORY: 365,
} as const;

/** Rows deleted per DELETE statement per table per sweep call — bounded so cleanup never locks a large table for a long period (Phase 4.8's explicit requirement). */
export const RETENTION_BATCH_SIZE = 500;
