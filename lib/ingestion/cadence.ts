/**
 * Centralized crawl-cadence timing (BRAWLRANKS_WEBSITE_SPEC.md Section 7.3
 * "re-crawl priority... weighted by how much new battle data they're
 * likely to have produced," Section 7.23 "avoiding wasted requests").
 *
 * Before this module, cadence logic was split across
 * lib/ingestion/config.ts (a single flat DEFAULT_RECRAWL_INTERVAL_MS
 * applied to every successful crawl regardless of outcome) and
 * lib/ingestion/retry.ts's computeBackoffMs (a 2s–5min range designed for
 * in-request HTTP retries, reused unmodified as the crawl-schedule's
 * inter-cycle backoff — too short a horizon for "come back in a while").
 * Every cadence value now lives here, in one place, with its rationale.
 *
 * Stratum fairness (high-value underrepresented vs. oversampled strata) is
 * NOT handled by a second priority mechanism here — it's already handled
 * structurally by lib/ingestion/fairness.ts's round-robin-across-strata
 * selection, which gives every stratum with due players an equal turn
 * per round regardless of its size. Building a redundant weighting system
 * here would fight that mechanism rather than complement it.
 */

export const CRAWL_CADENCE = {
  /** A successful crawl that returned at least one new battle — this player is producing data, worth revisiting sooner. */
  ACTIVE_RECRAWL_MS: 2 * 60 * 60_000,
  /** A successful crawl that returned zero battles (an empty log, not a failure) — back off further than an active player, but far short of deactivating them; they may simply not have played recently. */
  EMPTY_LOG_BACKOFF_MS: 12 * 60 * 60_000,
  /** Base for a retryable crawl failure's inter-cycle backoff — deliberately a much longer horizon than lib/ingestion/retry.ts's in-request HTTP-retry backoff (2s–5min), because this is "try again next scheduled cycle," not "retry this same request immediately." */
  FAILURE_BASE_BACKOFF_MS: 10 * 60_000,
  /** Hard ceiling on inter-cycle backoff — no player is ever scheduled more than a day out purely from accumulated failures, so a transient outage can't wedge a player out of rotation indefinitely. */
  FAILURE_MAX_BACKOFF_MS: 24 * 60 * 60_000,
  /** Small, bounded within-stratum priority adjustment — nudges a repeatedly-failing-but-not-yet-dead player behind healthier same-stratum peers without starving it (next_due_at remains the primary sort key). */
  PRIORITY_DECAY_PER_FAILURE: 0.5,
  PRIORITY_RECOVERY_PER_SUCCESS: 0.1,
  PRIORITY_FLOOR: -10,
  PRIORITY_CEILING: 10,
} as const;

/** Next-due delay for a successful crawl, based on whether it actually produced new battle data — not a flat interval regardless of outcome. */
export function computeSuccessDelayMs(newBattleCount: number): number {
  return newBattleCount > 0 ? CRAWL_CADENCE.ACTIVE_RECRAWL_MS : CRAWL_CADENCE.EMPTY_LOG_BACKOFF_MS;
}

/**
 * Exponential-with-full-jitter backoff for a retryable crawl failure,
 * scaled to the crawl-schedule's cycle horizon (minutes-to-a-day), not the
 * in-request HTTP-retry horizon. `consecutiveFailureCount` is 1-indexed
 * (the count AFTER this failure).
 */
export function computeCrawlFailureBackoffMs(consecutiveFailureCount: number): number {
  const exponential = Math.min(
    CRAWL_CADENCE.FAILURE_MAX_BACKOFF_MS,
    CRAWL_CADENCE.FAILURE_BASE_BACKOFF_MS * 2 ** Math.max(0, consecutiveFailureCount - 1)
  );
  return Math.floor(Math.random() * exponential);
}
