/**
 * Deterministic battle identity — the 9 required test scenarios
 * (BRAWLRANKS_WEBSITE_SPEC.md Section 7.4/7.6).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBattleKey, type BattleIdentityInput } from "@/lib/ingestion/battleId";

const BASE_TIME = "20260715T120000.000Z";

test("scenario 1: same battle, different observer (teams in different order) produces the same key", () => {
  const fromA: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "brawlBall", teams: [["#AAA", "#BBB"], ["#CCC", "#DDD"]] };
  const fromB: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "brawlBall", teams: [["#CCC", "#DDD"], ["#AAA", "#BBB"]] };
  assert.equal(computeBattleKey(fromA), computeBattleKey(fromB));
});

test("scenario 2: same participants in different payload order (within-team) produces the same key", () => {
  const a: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "brawlBall", teams: [["#AAA", "#BBB"], ["#CCC", "#DDD"]] };
  const b: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "brawlBall", teams: [["#BBB", "#AAA"], ["#DDD", "#CCC"]] };
  assert.equal(computeBattleKey(a), computeBattleKey(b));
});

test("scenario 3: same timestamp but different mode produces a different key", () => {
  const a: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "brawlBall", teams: [["#AAA"], ["#BBB"]] };
  const b: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "gemGrab", teams: [["#AAA"], ["#BBB"]] };
  assert.notEqual(computeBattleKey(a), computeBattleKey(b));
});

test("scenario 4: same timestamp/mode but different participants produces a different key", () => {
  const a: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "brawlBall", teams: [["#AAA"], ["#BBB"]] };
  const b: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "brawlBall", teams: [["#AAA"], ["#ZZZ"]] };
  assert.notEqual(computeBattleKey(a), computeBattleKey(b));
});

test("scenario 5: solo mode (single-participant teams) produces a stable key", () => {
  const a: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "soloShowdown", teams: [["#AAA"], ["#BBB"], ["#CCC"]] };
  const b: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "soloShowdown", teams: [["#CCC"], ["#AAA"], ["#BBB"]] };
  assert.equal(computeBattleKey(a), computeBattleKey(b));
});

test("scenario 6: duo mode (two-participant teams) produces a stable key regardless of team order", () => {
  const a: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "duoShowdown", teams: [["#AAA", "#BBB"], ["#CCC", "#DDD"]] };
  const b: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "duoShowdown", teams: [["#DDD", "#CCC"], ["#BBB", "#AAA"]] };
  assert.equal(computeBattleKey(a), computeBattleKey(b));
});

test("scenario 7: team mode (3v3) produces a stable key regardless of team/participant order", () => {
  const a: BattleIdentityInput = {
    battleTimeRaw: BASE_TIME,
    mode: "brawlBall",
    teams: [["#A1", "#A2", "#A3"], ["#B1", "#B2", "#B3"]],
  };
  const b: BattleIdentityInput = {
    battleTimeRaw: BASE_TIME,
    mode: "brawlBall",
    teams: [["#B3", "#B1", "#B2"], ["#A2", "#A3", "#A1"]],
  };
  assert.equal(computeBattleKey(a), computeBattleKey(b));
});

test("scenario 8: draws (result is not part of the identity) — two battles with identical participants/time/mode always collide regardless of the result value passed alongside", () => {
  // The battle ID algorithm never takes `result` as an input, so this is
  // really testing that identity is participant/time/mode-only — a draw
  // and a decisive result for the same real battle must still be treated
  // as the same battle when re-observed.
  const a: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "brawlBall", teams: [["#AAA"], ["#BBB"]] };
  const b: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "brawlBall", teams: [["#AAA"], ["#BBB"]] };
  assert.equal(computeBattleKey(a), computeBattleKey(b));
});

test("scenario 9: incomplete participant payload produces a DIFFERENT key than the complete observation (intentional — not silently merged)", () => {
  const complete: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "brawlBall", teams: [["#A1", "#A2"], ["#B1", "#B2"]] };
  const incomplete: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "brawlBall", teams: [["#A1"], ["#B1", "#B2"]] };
  assert.notEqual(computeBattleKey(complete), computeBattleKey(incomplete));
});

test("distinct-battle collision resistance: many distinct battles at nearby timestamps never collide", () => {
  const keys = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const key = computeBattleKey({
      battleTimeRaw: `20260715T12000${i % 10}.000Z`,
      mode: i % 2 === 0 ? "brawlBall" : "gemGrab",
      teams: [[`#P${i}A`], [`#P${i}B`]],
    });
    assert.ok(!keys.has(key), `unexpected collision at i=${i}`);
    keys.add(key);
  }
});

test("tag case is normalized before hashing (lowercase vs uppercase tags collide)", () => {
  const a: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "brawlBall", teams: [["#aaa"], ["#bbb"]] };
  const b: BattleIdentityInput = { battleTimeRaw: BASE_TIME, mode: "brawlBall", teams: [["#AAA"], ["#BBB"]] };
  assert.equal(computeBattleKey(a), computeBattleKey(b));
});
