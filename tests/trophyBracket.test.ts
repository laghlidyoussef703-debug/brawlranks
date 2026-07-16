/**
 * Trophy-bracket boundary semantics (Phase 4.2). Pure/DB-free — no skip needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { trophyBracketFor, isKnownTrophyBracket, TROPHY_BRACKETS, UNRANKED_BRACKET_ID } from "@/lib/ingestion/trophyBracket";

test("null, undefined, negative, and non-finite trophy values all resolve to the explicit unranked bracket, never a fabricated one", () => {
  assert.equal(trophyBracketFor(null), UNRANKED_BRACKET_ID);
  assert.equal(trophyBracketFor(undefined), UNRANKED_BRACKET_ID);
  assert.equal(trophyBracketFor(-1), UNRANKED_BRACKET_ID);
  assert.equal(trophyBracketFor(NaN), UNRANKED_BRACKET_ID);
  assert.equal(trophyBracketFor(Infinity), UNRANKED_BRACKET_ID);
});

test("0 resolves to the first bracket", () => {
  assert.equal(trophyBracketFor(0), "bracket_0_5k");
});

test("every declared upper boundary belongs to the NEXT bracket (max is exclusive), never the current one", () => {
  for (let i = 0; i < TROPHY_BRACKETS.length - 1; i += 1) {
    const bracket = TROPHY_BRACKETS[i];
    const next = TROPHY_BRACKETS[i + 1];
    assert.equal(bracket.max, next.min, `bracket ${bracket.id}'s max must equal ${next.id}'s min (gap-free)`);
    assert.equal(trophyBracketFor(bracket.max as number), next.id, `boundary value ${bracket.max} must resolve to ${next.id}, not ${bracket.id}`);
    assert.equal(trophyBracketFor((bracket.max as number) - 1), bracket.id, `value just below the boundary must still resolve to ${bracket.id}`);
  }
});

test("the top bracket is unbounded (max: null) and covers arbitrarily large trophy values", () => {
  const top = TROPHY_BRACKETS[TROPHY_BRACKETS.length - 1];
  assert.equal(top.max, null);
  assert.equal(trophyBracketFor(top.min), top.id);
  assert.equal(trophyBracketFor(10_000_000), top.id);
});

test("deterministic: the same input always produces the same output across repeated calls", () => {
  for (const value of [0, 4999, 5000, 14999, 75000, 999999]) {
    assert.equal(trophyBracketFor(value), trophyBracketFor(value));
  }
});

test("no overlaps: every integer trophy value in a swept range resolves to exactly one known bracket", () => {
  for (let trophies = 0; trophies <= 80_000; trophies += 137) {
    const id = trophyBracketFor(trophies);
    const matches = TROPHY_BRACKETS.filter((b) => trophies >= b.min && (b.max === null || trophies < b.max));
    assert.equal(matches.length, 1, `trophies=${trophies} matched ${matches.length} brackets`);
    assert.equal(id, matches[0].id);
  }
});

test("isKnownTrophyBracket recognizes every real bracket id and the unranked sentinel, rejects unknown strings", () => {
  for (const bracket of TROPHY_BRACKETS) {
    assert.equal(isKnownTrophyBracket(bracket.id), true);
  }
  assert.equal(isKnownTrophyBracket(UNRANKED_BRACKET_ID), true);
  assert.equal(isKnownTrophyBracket("not_a_real_bracket"), false);
});
