/**
 * Pure, DB-free ranking formulas (Phase 5.3), implementing the exact MVP
 * decisions from the Phase 5.3 owner-decision report verbatim — no value
 * here is reinterpreted or re-derived from the spec independently.
 */

// ---------------------------------------------------------------------------
// Recency + patch blend (decision report item 8/9)
// ---------------------------------------------------------------------------

/**
 * 1.0 within 30 days, linearly decaying to 0.5 at 90 days, continuing to
 * decay linearly to 0 at 180 days, 0 beyond. A single continuous
 * piecewise-linear curve — the direct, literal reading of "linear decay to
 * 0.5 at 90 days... 0 beyond 180 days" (the only reading that doesn't
 * silently invent a flat plateau the report never mentions).
 */
export function computeRecencyWeight(daysAgo: number): number {
  if (daysAgo <= 30) return 1.0;
  if (daysAgo <= 90) return 1.0 - 0.5 * ((daysAgo - 30) / 60);
  if (daysAgo <= 180) return 0.5 - 0.5 * ((daysAgo - 90) / 90);
  return 0;
}

/** decision report item 9: blend weight = min(1, current_patch_matches / 100). */
export function computePatchBlendWeight(currentPatchMatches: number): number {
  return Math.min(1, Math.max(0, currentPatchMatches) / 100);
}

/**
 * blended = blendWeight * currentPatchRate + (1 - blendWeight) * allDataRate.
 * Either input may be null (no qualifying data for that side) — a null
 * side contributes nothing and the other side is used at full weight,
 * never treated as a 0.
 */
export function blendWinRate(
  currentPatchRate: number | null,
  allDataRate: number | null,
  blendWeight: number
): number | null {
  if (currentPatchRate === null && allDataRate === null) return null;
  if (currentPatchRate === null) return allDataRate;
  if (allDataRate === null) return currentPatchRate;
  return blendWeight * currentPatchRate + (1 - blendWeight) * allDataRate;
}

// ---------------------------------------------------------------------------
// Per-player cap (decision report item 2 / Section 7.10)
// ---------------------------------------------------------------------------

export interface CappableRow {
  playerId: string;
  occurredAt: Date;
}

/** At most `maxRows` rows from any one player count toward a single Brawler's aggregate — keeps that player's most recent rows, drops the rest. */
export function applyPerPlayerCap<T extends CappableRow>(rows: T[], maxRows: number): T[] {
  const byPlayer = new Map<string, T[]>();
  for (const row of rows) {
    const list = byPlayer.get(row.playerId);
    if (list) list.push(row);
    else byPlayer.set(row.playerId, [row]);
  }
  const result: T[] = [];
  for (const list of byPlayer.values()) {
    list.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    result.push(...list.slice(0, maxRows));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scores (decision report items 3/4)
// ---------------------------------------------------------------------------

export interface OverallScoreInput {
  winRate: number;
  pickRate: number;
  highRankWinRate: number | null;
  matchupCoverage: number | null;
}

/**
 * meta_score = 0.50*win_rate + 0.20*pick_rate + 0.20*high_rank_win_rate +
 * 0.10*matchup_coverage, stored on a 0-100 scale. high_rank_win_rate falls
 * back to win_rate; matchup_coverage falls back to 0.5 — both exactly as
 * specified, never zeroed (which would misrepresent absent data as "bad").
 */
export function computeOverallScore(input: OverallScoreInput): number {
  const highRank = input.highRankWinRate ?? input.winRate;
  const coverage = input.matchupCoverage ?? 0.5;
  const raw = 0.5 * input.winRate + 0.2 * input.pickRate + 0.2 * highRank + 0.1 * coverage;
  return raw * 100;
}

export interface ModeScoreInput {
  modeWinRate: number;
  modePickRate: number;
}

/** mode_score = 0.70*mode_win_rate + 0.30*mode_pick_rate, 0-100 scale. Never incorporates the overall score (Section 9.1: modes are independently calculated). */
export function computeModeScore(input: ModeScoreInput): number {
  return (0.7 * input.modeWinRate + 0.3 * input.modePickRate) * 100;
}

// ---------------------------------------------------------------------------
// Percentile tiers (decision report item 5)
// ---------------------------------------------------------------------------

export type Tier = "S" | "A" | "B" | "C" | "D";

function tierForPercentile(percentile: number): Tier {
  if (percentile >= 90) return "S";
  if (percentile >= 70) return "A";
  if (percentile >= 30) return "B";
  if (percentile >= 10) return "C";
  return "D";
}

/**
 * Percentile of each score = (count of entries with score <= this score) /
 * total * 100 — ties therefore always share the same percentile, and so
 * always land in the same tier, satisfying "exact score ties at a boundary
 * remain together in the higher tier" by construction (no separate
 * tie-breaking step is needed). No forced min/max tier size.
 */
export function assignPercentileTiers(scores: number[]): Tier[] {
  const total = scores.length;
  if (total === 0) return [];
  const sorted = [...scores].sort((a, b) => a - b);
  return scores.map((score) => {
    // Count of entries <= score, using the sorted copy (stable regardless of input order).
    let countAtOrBelow = 0;
    for (const s of sorted) {
      if (s <= score) countAtOrBelow += 1;
      else break;
    }
    const percentile = (countAtOrBelow / total) * 100;
    return tierForPercentile(percentile);
  });
}

// ---------------------------------------------------------------------------
// Confidence bands (decision report item 6)
// ---------------------------------------------------------------------------

export type ConfidenceLabel = "insufficient" | "low" | "medium" | "high";

export interface ConfidenceGateInputs {
  recentBattleWithin30Days: boolean;
  distinctRegions: number;
  distinctTrophyBrackets: number;
}

function highConfidenceGateMet(gates: ConfidenceGateInputs): boolean {
  return gates.recentBattleWithin30Days && gates.distinctRegions >= 2 && gates.distinctTrophyBrackets >= 2;
}

export function computeOverallConfidence(matches: number, gates: ConfidenceGateInputs): ConfidenceLabel {
  if (matches < 100) return "insufficient";
  if (matches < 200) return "low";
  if (matches < 500) return "medium";
  return highConfidenceGateMet(gates) ? "high" : "medium";
}

export function computeModeConfidence(matches: number, gates: ConfidenceGateInputs): ConfidenceLabel {
  if (matches < 30) return "insufficient";
  if (matches < 60) return "low";
  if (matches < 150) return "medium";
  return highConfidenceGateMet(gates) ? "high" : "medium";
}

// ---------------------------------------------------------------------------
// Matchup classification (decision report item 7)
// ---------------------------------------------------------------------------

export type MatchupRelationship = "hard_counter" | "counter" | "neutral" | "strong" | "hard_advantage";

/** Below the 20-match floor: not classified, not published — never forced into a bucket. */
export function classifyMatchup(winRate: number | null, matches: number): MatchupRelationship | null {
  if (matches < 20 || winRate === null) return null;
  if (winRate <= 0.35) return "hard_counter";
  if (winRate < 0.45) return "counter";
  if (winRate <= 0.55) return "neutral";
  if (winRate < 0.65) return "strong";
  return "hard_advantage";
}

export type MatchupConfidenceLevel = "insufficient" | "weak_signal" | "probable_counter" | "high_confidence_counter";

export function computeMatchupConfidence(matches: number, consistentAcrossStrata: boolean): MatchupConfidenceLevel {
  if (matches < 20) return "insufficient";
  if (matches < 40) return "weak_signal";
  if (matches < 100) return "probable_counter";
  return consistentAcrossStrata ? "high_confidence_counter" : "probable_counter";
}

// ---------------------------------------------------------------------------
// Mass-movement guard + no-change rule (decision report item 10)
// ---------------------------------------------------------------------------

/** Fraction of ranked Brawlers whose overall tier differs between the new candidate and the previously published snapshot. */
export function computeTierMoveRatio(previousTiers: Map<string, Tier>, newTiers: Map<string, Tier>): number {
  if (newTiers.size === 0) return 0;
  let moved = 0;
  for (const [brawlerId, newTier] of newTiers) {
    const prevTier = previousTiers.get(brawlerId);
    if (prevTier !== undefined && prevTier !== newTier) moved += 1;
  }
  return moved / newTiers.size;
}

/** >25% of ranked Brawlers changing tier vs. the previous published run triggers a hold. Never applies to the first-ever run (Section 7.13's cold-start exemption — nothing to compare against). */
export function exceedsMassMovementGuard(tierMoveRatio: number, isFirstRun: boolean): boolean {
  if (isFirstRun) return false;
  return tierMoveRatio > 0.25;
}

export interface ChangeComparison {
  brawlerId: string;
  previousTier: Tier | null;
  newTier: Tier;
  previousScore: number | null;
  newScore: number;
}

/** No new snapshot publishes if nothing meaningfully changed (Section 8.2's "no fake freshness" principle, applied to ranking output): zero tier moves AND no meta_score moved by more than 0.01 (1 percentage point on the 0-100 scale, i.e. 1.0 in stored units). */
export function hasSignificantChange(comparisons: ChangeComparison[], isFirstRun: boolean): boolean {
  if (isFirstRun) return true;
  for (const c of comparisons) {
    if (c.previousTier === null) return true; // a brand-new published entry is itself a real change
    if (c.previousTier !== c.newTier) return true;
    if (c.previousScore === null || Math.abs(c.newScore - c.previousScore) > 1.0) return true;
  }
  return false;
}
