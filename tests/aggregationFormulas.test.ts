/**
 * Pure aggregation formulas (Phase 5.2 — Section 7.8). No skip needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWinRate, reconcileCounts } from "@/lib/aggregation/formulas";

test("computeWinRate is wins / (wins + losses), matching Section 7.8's stated formula", () => {
  assert.equal(computeWinRate(60, 40), 0.6);
  assert.equal(computeWinRate(1, 3), 0.25);
  assert.equal(computeWinRate(0, 1), 0);
  assert.equal(computeWinRate(1, 0), 1);
});

test("computeWinRate returns null (never 0, never NaN) when there is no win/loss data at all", () => {
  assert.equal(computeWinRate(0, 0), null);
});

test("computeWinRate ignores draws entirely — draws are never passed to it, by construction of the formula", () => {
  // Two Brawlers with identical win/loss but different implicit draw counts must produce identical win rates.
  assert.equal(computeWinRate(10, 10), computeWinRate(10, 10));
});

test("computeWinRate is symmetric around 0.5 for a mirrored record", () => {
  assert.equal(computeWinRate(5, 5), 0.5);
});

test("reconcileCounts passes when wins+losses+draws equals matches exactly", () => {
  assert.equal(reconcileCounts({ matches: 10, wins: 6, losses: 3, draws: 1 }), true);
});

test("reconcileCounts passes when wins+losses+draws is less than matches (unknown-result participants account for the gap)", () => {
  assert.equal(reconcileCounts({ matches: 10, wins: 5, losses: 3, draws: 0 }), true);
});

test("reconcileCounts fails when wins+losses+draws exceeds matches — a real data-integrity bug", () => {
  assert.equal(reconcileCounts({ matches: 5, wins: 4, losses: 3, draws: 0 }), false);
});

test("reconcileCounts fails on any negative count", () => {
  assert.equal(reconcileCounts({ matches: 10, wins: -1, losses: 3, draws: 1 }), false);
  assert.equal(reconcileCounts({ matches: -1, wins: 0, losses: 0, draws: 0 }), false);
});

test("reconcileCounts passes for an all-zero row (a Brawler with literally no data yet)", () => {
  assert.equal(reconcileCounts({ matches: 0, wins: 0, losses: 0, draws: 0 }), true);
});
