/**
 * Pure Phase 5.3 ranking formulas — implementing the exact MVP decisions
 * from the Phase 5.3 owner-decision report. No skip needed (DB-free).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeRecencyWeight,
  computePatchBlendWeight,
  blendWinRate,
  applyPerPlayerCap,
  computeOverallScore,
  computeModeScore,
  assignPercentileTiers,
  computeOverallConfidence,
  computeModeConfidence,
  classifyMatchup,
  computeMatchupConfidence,
  computeTierMoveRatio,
  exceedsMassMovementGuard,
  hasSignificantChange,
} from "@/lib/ranking/formulas";

// --- Recency weight ---

test("computeRecencyWeight is 1.0 at and within 30 days", () => {
  assert.equal(computeRecencyWeight(0), 1.0);
  assert.equal(computeRecencyWeight(30), 1.0);
});

test("computeRecencyWeight decays linearly from 1.0 to 0.5 between 30 and 90 days", () => {
  assert.equal(computeRecencyWeight(60), 0.75); // halfway
  assert.ok(Math.abs(computeRecencyWeight(90) - 0.5) < 1e-9);
});

test("computeRecencyWeight decays linearly from 0.5 to 0 between 90 and 180 days", () => {
  assert.ok(Math.abs(computeRecencyWeight(135) - 0.25) < 1e-9); // halfway
  assert.ok(Math.abs(computeRecencyWeight(180) - 0) < 1e-9);
});

test("computeRecencyWeight is exactly 0 beyond 180 days", () => {
  assert.equal(computeRecencyWeight(181), 0);
  assert.equal(computeRecencyWeight(10000), 0);
});

// --- Patch blend ---

test("computePatchBlendWeight is min(1, matches/100)", () => {
  assert.equal(computePatchBlendWeight(0), 0);
  assert.equal(computePatchBlendWeight(50), 0.5);
  assert.equal(computePatchBlendWeight(100), 1);
  assert.equal(computePatchBlendWeight(500), 1);
});

test("blendWinRate at weight 0 returns the all-data rate (first run / no current-patch data)", () => {
  assert.equal(blendWinRate(0.9, 0.4, 0), 0.4);
});

test("blendWinRate at weight 1 returns the current-patch rate", () => {
  assert.equal(blendWinRate(0.9, 0.4, 1), 0.9);
});

test("blendWinRate at weight 0.5 is the midpoint", () => {
  assert.ok(Math.abs((blendWinRate(0.8, 0.4, 0.5) as number) - 0.6) < 1e-9);
});

test("blendWinRate falls back to whichever side is non-null when the other is null, never treats missing data as 0", () => {
  assert.equal(blendWinRate(null, 0.6, 1), 0.6);
  assert.equal(blendWinRate(0.6, null, 0), 0.6);
  assert.equal(blendWinRate(null, null, 0.5), null);
});

// --- Per-player cap ---

test("applyPerPlayerCap keeps at most maxRows per player, the most recent ones", () => {
  const now = Date.now();
  const rows = Array.from({ length: 30 }, (_, i) => ({ playerId: "p1", occurredAt: new Date(now - i * 1000) }));
  const capped = applyPerPlayerCap(rows, 20);
  assert.equal(capped.length, 20);
  // The 20 most recent (smallest i) must be kept.
  const keptIndices = capped.map((r) => rows.findIndex((x) => x === r));
  assert.ok(keptIndices.every((i) => i < 20));
});

test("applyPerPlayerCap never truncates a player already under the cap", () => {
  const rows = [{ playerId: "p1", occurredAt: new Date() }, { playerId: "p2", occurredAt: new Date() }];
  assert.equal(applyPerPlayerCap(rows, 20).length, 2);
});

test("applyPerPlayerCap caps independently per player — one hyperactive player never reduces another player's rows", () => {
  const now = Date.now();
  const heavy = Array.from({ length: 50 }, (_, i) => ({ playerId: "heavy", occurredAt: new Date(now - i * 1000) }));
  const light = [{ playerId: "light", occurredAt: new Date() }];
  const capped = applyPerPlayerCap([...heavy, ...light], 20);
  assert.equal(capped.filter((r) => r.playerId === "heavy").length, 20);
  assert.equal(capped.filter((r) => r.playerId === "light").length, 1);
});

// --- Overall / mode score ---

test("computeOverallScore matches the exact weighted formula (0.50/0.20/0.20/0.10), 0-100 scale", () => {
  const score = computeOverallScore({ winRate: 0.6, pickRate: 0.5, highRankWinRate: 0.7, matchupCoverage: 0.4 });
  const expected = (0.5 * 0.6 + 0.2 * 0.5 + 0.2 * 0.7 + 0.1 * 0.4) * 100;
  assert.ok(Math.abs(score - expected) < 1e-9);
});

test("computeOverallScore falls back high_rank_win_rate to win_rate when null", () => {
  const withFallback = computeOverallScore({ winRate: 0.6, pickRate: 0.5, highRankWinRate: null, matchupCoverage: 0.5 });
  const asIfEqual = computeOverallScore({ winRate: 0.6, pickRate: 0.5, highRankWinRate: 0.6, matchupCoverage: 0.5 });
  assert.ok(Math.abs(withFallback - asIfEqual) < 1e-9);
});

test("computeOverallScore falls back matchup_coverage to 0.5 when null, never to 0", () => {
  const withFallback = computeOverallScore({ winRate: 0.5, pickRate: 0.5, highRankWinRate: 0.5, matchupCoverage: null });
  const asIfZero = computeOverallScore({ winRate: 0.5, pickRate: 0.5, highRankWinRate: 0.5, matchupCoverage: 0 });
  assert.notEqual(withFallback, asIfZero);
  const asIfHalf = computeOverallScore({ winRate: 0.5, pickRate: 0.5, highRankWinRate: 0.5, matchupCoverage: 0.5 });
  assert.ok(Math.abs(withFallback - asIfHalf) < 1e-9);
});

test("computeModeScore matches the exact weighted formula (0.70/0.30), 0-100 scale, no overall contribution", () => {
  const score = computeModeScore({ modeWinRate: 0.6, modePickRate: 0.3 });
  assert.ok(Math.abs(score - (0.7 * 0.6 + 0.3 * 0.3) * 100) < 1e-9);
});

// --- Percentile tiers ---

test("assignPercentileTiers: top ~10% is S, matching the 90th-percentile cutoff", () => {
  const scores = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100, unique, ascending
  const tiers = assignPercentileTiers(scores);
  // Score 100 is the max -> 100th percentile -> S. Score 91 is the 91st smallest -> 91st percentile -> S. Score 90 -> 90th percentile -> S (>=90 inclusive).
  assert.equal(tiers[99], "S"); // score 100
  assert.equal(tiers[89], "S"); // score 90
  assert.equal(tiers[88], "A"); // score 89 -> 89th percentile -> A
});

test("assignPercentileTiers boundaries: exactly at 70/30/10 percentile land in the higher tier", () => {
  const scores = Array.from({ length: 100 }, (_, i) => i + 1);
  const tiers = assignPercentileTiers(scores);
  assert.equal(tiers[69], "A"); // score 70 -> 70th percentile -> A (>=70)
  assert.equal(tiers[68], "B"); // score 69 -> 69th percentile -> B
  assert.equal(tiers[29], "B"); // score 30 -> 30th percentile -> B (>=30)
  assert.equal(tiers[28], "C"); // score 29 -> 29th percentile -> C
  assert.equal(tiers[9], "C"); // score 10 -> 10th percentile -> C (>=10)
  assert.equal(tiers[8], "D"); // score 9 -> 9th percentile -> D
});

test("assignPercentileTiers: exact score ties at a boundary always land together in the SAME (higher) tier", () => {
  // 10 entries, all tied at the same score -> every entry has the same percentile (100th) -> all S.
  const scores = Array.from({ length: 10 }, () => 42);
  const tiers = assignPercentileTiers(scores);
  assert.ok(tiers.every((t) => t === tiers[0]), "a tie must never split across two different tiers");
});

test("assignPercentileTiers: a tie straddling a boundary count still resolves to one shared tier for all tied entries", () => {
  // 100 distinct scores 1..99, plus a 10th entry tied with the 90th value (90), all at position ~90th percentile.
  const scores = [...Array.from({ length: 99 }, (_, i) => i + 1), 90];
  const tiers = assignPercentileTiers(scores);
  const tierOf90 = tiers.filter((_, i) => scores[i] === 90);
  assert.ok(tierOf90.every((t) => t === tierOf90[0]));
});

test("assignPercentileTiers returns an empty array for an empty input", () => {
  assert.deepEqual(assignPercentileTiers([]), []);
});

test("assignPercentileTiers imposes no minimum/maximum tier size — a single-entry list is entirely S", () => {
  assert.deepEqual(assignPercentileTiers([50]), ["S"]);
});

// --- Confidence bands ---

test("computeOverallConfidence: insufficient/low/medium bands match the exact 100/200/500 breakpoints", () => {
  const noGate = { recentBattleWithin30Days: false, distinctRegions: 0, distinctTrophyBrackets: 0 };
  assert.equal(computeOverallConfidence(99, noGate), "insufficient");
  assert.equal(computeOverallConfidence(100, noGate), "low");
  assert.equal(computeOverallConfidence(199, noGate), "low");
  assert.equal(computeOverallConfidence(200, noGate), "medium");
  assert.equal(computeOverallConfidence(499, noGate), "medium");
});

test("computeOverallConfidence: 500+ matches without the gate stays medium, never high", () => {
  assert.equal(computeOverallConfidence(1000, { recentBattleWithin30Days: false, distinctRegions: 5, distinctTrophyBrackets: 5 }), "medium");
});

test("computeOverallConfidence: 500+ matches WITH the freshness+coverage gate reaches high", () => {
  const gate = { recentBattleWithin30Days: true, distinctRegions: 2, distinctTrophyBrackets: 2 };
  assert.equal(computeOverallConfidence(500, gate), "high");
});

test("computeOverallConfidence: the gate requires ALL three conditions, not just one", () => {
  assert.equal(computeOverallConfidence(1000, { recentBattleWithin30Days: true, distinctRegions: 1, distinctTrophyBrackets: 2 }), "medium");
  assert.equal(computeOverallConfidence(1000, { recentBattleWithin30Days: true, distinctRegions: 2, distinctTrophyBrackets: 1 }), "medium");
  assert.equal(computeOverallConfidence(1000, { recentBattleWithin30Days: false, distinctRegions: 2, distinctTrophyBrackets: 2 }), "medium");
});

test("computeModeConfidence: insufficient/low/medium bands match the exact 30/60/150 breakpoints", () => {
  const noGate = { recentBattleWithin30Days: false, distinctRegions: 0, distinctTrophyBrackets: 0 };
  assert.equal(computeModeConfidence(29, noGate), "insufficient");
  assert.equal(computeModeConfidence(30, noGate), "low");
  assert.equal(computeModeConfidence(59, noGate), "low");
  assert.equal(computeModeConfidence(60, noGate), "medium");
  assert.equal(computeModeConfidence(149, noGate), "medium");
  const gate = { recentBattleWithin30Days: true, distinctRegions: 2, distinctTrophyBrackets: 2 };
  assert.equal(computeModeConfidence(150, gate), "high");
  assert.equal(computeModeConfidence(150, noGate), "medium");
});

// --- Matchup classification ---

test("classifyMatchup boundaries match the exact +/-15pp bands around 50%", () => {
  assert.equal(classifyMatchup(0.35, 100), "hard_counter");
  assert.equal(classifyMatchup(0.36, 100), "counter");
  assert.equal(classifyMatchup(0.44, 100), "counter");
  assert.equal(classifyMatchup(0.45, 100), "neutral");
  assert.equal(classifyMatchup(0.55, 100), "neutral");
  assert.equal(classifyMatchup(0.56, 100), "strong");
  assert.equal(classifyMatchup(0.64, 100), "strong");
  assert.equal(classifyMatchup(0.65, 100), "hard_advantage");
});

test("classifyMatchup returns null below the 20-match floor — never forced into a bucket", () => {
  assert.equal(classifyMatchup(0.9, 19), null);
  assert.equal(classifyMatchup(0.1, 0), null);
});

test("classifyMatchup returns null when winRate itself is null regardless of sample size", () => {
  assert.equal(classifyMatchup(null, 500), null);
});

test("classifyMatchup preserves A-vs-B / B-vs-A inverse consistency across every boundary", () => {
  const pairs: [number, number][] = [[0.7, 0.3], [0.35, 0.65], [0.5, 0.5], [0.62, 0.38], [0.2, 0.8]];
  const inverseOf: Record<string, string> = {
    hard_counter: "hard_advantage",
    counter: "strong",
    neutral: "neutral",
    strong: "counter",
    hard_advantage: "hard_counter",
  };
  for (const [a, b] of pairs) {
    const classA = classifyMatchup(a, 100)!;
    const classB = classifyMatchup(b, 100)!;
    assert.equal(inverseOf[classA], classB, `win rates ${a}/${b} must classify as mathematical inverses`);
  }
});

test("computeMatchupConfidence bands match the exact 20/40/100 breakpoints, gated by cross-strata consistency at the top", () => {
  assert.equal(computeMatchupConfidence(19, false), "insufficient");
  assert.equal(computeMatchupConfidence(20, false), "weak_signal");
  assert.equal(computeMatchupConfidence(39, false), "weak_signal");
  assert.equal(computeMatchupConfidence(40, false), "probable_counter");
  assert.equal(computeMatchupConfidence(99, false), "probable_counter");
  assert.equal(computeMatchupConfidence(100, false), "probable_counter");
  assert.equal(computeMatchupConfidence(100, true), "high_confidence_counter");
});

// --- Mass-movement guard + no-change rule ---

test("computeTierMoveRatio counts only Brawlers present in the new run whose tier actually changed", () => {
  const prev = new Map([["a", "S" as const], ["b", "A" as const], ["c", "B" as const], ["d", "C" as const]]);
  const next = new Map([["a", "S" as const], ["b", "B" as const], ["c", "C" as const], ["d", "C" as const]]);
  assert.equal(computeTierMoveRatio(prev, next), 0.5); // b and c moved, a and d didn't
});

test("computeTierMoveRatio ignores a brand-new Brawler with no previous tier (not counted as a 'move')", () => {
  const prev = new Map([["a", "S" as const]]);
  const next = new Map([["a", "S" as const], ["new", "D" as const]]);
  assert.equal(computeTierMoveRatio(prev, next), 0);
});

test("exceedsMassMovementGuard never triggers on the first-ever run regardless of ratio", () => {
  assert.equal(exceedsMassMovementGuard(0.9, true), false);
});

test("exceedsMassMovementGuard triggers exactly above 25%, not at exactly 25%", () => {
  assert.equal(exceedsMassMovementGuard(0.25, false), false);
  assert.equal(exceedsMassMovementGuard(0.2501, false), true);
});

test("hasSignificantChange is always true on the first run (there is nothing to compare against, so it always publishes)", () => {
  assert.equal(hasSignificantChange([], true), true);
});

test("hasSignificantChange is false when nothing moved (no tier change, score delta <= 0.01pp-equivalent)", () => {
  const comparisons = [{ brawlerId: "a", previousTier: "S" as const, newTier: "S" as const, previousScore: 80, newScore: 80.5 }];
  assert.equal(hasSignificantChange(comparisons, false), false);
});

test("hasSignificantChange is true when any Brawler's tier changed", () => {
  const comparisons = [{ brawlerId: "a", previousTier: "S" as const, newTier: "A" as const, previousScore: 80, newScore: 79 }];
  assert.equal(hasSignificantChange(comparisons, false), true);
});

test("hasSignificantChange is true when a score moved by more than the 1.0-unit (0.01) threshold even with no tier change", () => {
  const comparisons = [{ brawlerId: "a", previousTier: "S" as const, newTier: "S" as const, previousScore: 80, newScore: 81.5 }];
  assert.equal(hasSignificantChange(comparisons, false), true);
});

test("hasSignificantChange is true for a brand-new published entry (no previous tier at all)", () => {
  const comparisons = [{ brawlerId: "new", previousTier: null, newTier: "B" as const, previousScore: null, newScore: 50 }];
  assert.equal(hasSignificantChange(comparisons, false), true);
});
