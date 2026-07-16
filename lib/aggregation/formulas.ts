/**
 * Pure, DB-free aggregation formulas (Phase 5.2 — BRAWLRANKS_WEBSITE_SPEC.md
 * Section 7.8). Deliberately limited to the metrics Section 7.8 states with
 * a concrete, unambiguous formula and no outstanding owner decision — see
 * migration 0022's header for the full scope explanation. Pick rate,
 * confidence, and tier assignment are NOT here: they depend on values
 * Section 7.28/48 explicitly leave "Unresolved."
 */

export interface RawResultCounts {
  matches: number;
  wins: number;
  losses: number;
  draws: number;
}

/**
 * Section 7.8's Win rate row: "Win count | Win count + Loss count (draws
 * excluded from the denominator by default...)". Returns null — never 0,
 * never NaN — when there is no qualifying win/loss data at all, since a
 * fabricated 0% win rate from an empty denominator would misrepresent
 * "no data" as "always loses."
 */
export function computeWinRate(wins: number, losses: number): number | null {
  const denominator = wins + losses;
  if (denominator <= 0) return null;
  return wins / denominator;
}

/**
 * Section 7.24's "Aggregation totals reconcile" data-quality gate: wins +
 * losses + draws must never exceed the match count (equality holds only
 * when every participant-row's result was a recognized win/loss/draw
 * value; a real "unknown" result, Section 7.4, accounts for any shortfall
 * without being its own tracked column here). A mechanical, zero-parameter
 * invariant — not a business threshold.
 */
export function reconcileCounts(counts: RawResultCounts): boolean {
  const { matches, wins, losses, draws } = counts;
  if (matches < 0 || wins < 0 || losses < 0 || draws < 0) return false;
  return wins + losses + draws <= matches;
}
