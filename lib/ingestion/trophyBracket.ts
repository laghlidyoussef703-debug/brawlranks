/**
 * Trophy/rank-bracket strata (BRAWLRANKS_WEBSITE_SPEC.md Section 7.3 —
 * "the seed set deliberately spans brackets... tracked per-player so a
 * Brawler's score isn't accidentally just 'how good is this Brawler at the
 * very top of the leaderboard'").
 *
 * These are BrawlRanks-internal statistical strata for sampling/aggregation
 * purposes only — not official in-game league/rank names, and not claimed
 * to be. No CHECK constraint governs `trophy_bracket` at the database level
 * (it's a plain VARCHAR), so redefining these boundaries is a pure
 * application-code change with no migration required.
 *
 * Calibration note: today's ONLY seed source is the global top-players
 * ranking leaderboard (Phase 3), whose members are almost certainly all
 * clustered in the top one or two brackets below — the finer low/mid
 * granularity here exists for when Phase 4.1's regional seeding and
 * Phase 4.5's organic discovery actually populate it, not because it's
 * already populated today.
 */

export interface TrophyBracketDefinition {
  id: string;
  label: string;
  min: number;
  /** Exclusive upper bound; `null` means unbounded (the top bracket). */
  max: number | null;
  purpose: string;
}

/**
 * Monotonic, non-overlapping, gap-free over [0, +Infinity). Every bracket's
 * `max` is exactly the next bracket's `min`, so a boundary trophy value
 * (e.g. exactly 5000) always resolves to exactly one bracket, never zero
 * and never two.
 */
export const TROPHY_BRACKETS: TrophyBracketDefinition[] = [
  {
    id: "bracket_0_5k",
    label: "0 – 4,999",
    min: 0,
    max: 5_000,
    purpose: "Newer/casual players — without this stratum, every downstream statistic risks reflecting only how a Brawler performs for skilled players, not how most players actually experience it (Section 7.3's core concern).",
  },
  {
    id: "bracket_5k_15k",
    label: "5,000 – 14,999",
    min: 5_000,
    max: 15_000,
    purpose: "Regular, engaged casual players.",
  },
  {
    id: "bracket_15k_30k",
    label: "15,000 – 29,999",
    min: 15_000,
    max: 30_000,
    purpose: "Competent, dedicated players.",
  },
  {
    id: "bracket_30k_50k",
    label: "30,000 – 49,999",
    min: 30_000,
    max: 50_000,
    purpose: "Highly skilled players.",
  },
  {
    id: "bracket_50k_75k",
    label: "50,000 – 74,999",
    min: 50_000,
    max: 75_000,
    purpose: "Elite, near-top-of-leaderboard players.",
  },
  {
    id: "bracket_75k_plus",
    label: "75,000+",
    min: 75_000,
    max: null,
    purpose: "Top-of-global-leaderboard players — today's actual (and only) seed population.",
  },
];

/** Explicit, never-silent handling of a missing/invalid trophy value — never fabricated into a real bracket. */
export const UNRANKED_BRACKET_ID = "unranked";

/**
 * Deterministic: the same trophy value always resolves to the same bracket
 * id, independent of call order or prior state — required for the
 * "store bracket assignment deterministically" acceptance criterion.
 */
export function trophyBracketFor(trophies: number | null | undefined): string {
  if (trophies === null || trophies === undefined || !Number.isFinite(trophies) || trophies < 0) {
    return UNRANKED_BRACKET_ID;
  }
  for (const bracket of TROPHY_BRACKETS) {
    if (trophies >= bracket.min && (bracket.max === null || trophies < bracket.max)) {
      return bracket.id;
    }
  }
  // Unreachable given the bracket table is gap-free and unbounded at the
  // top, but never silently return an invalid value if it somehow is.
  return UNRANKED_BRACKET_ID;
}

export function isKnownTrophyBracket(bracketId: string): boolean {
  return bracketId === UNRANKED_BRACKET_ID || TROPHY_BRACKETS.some((b) => b.id === bracketId);
}
