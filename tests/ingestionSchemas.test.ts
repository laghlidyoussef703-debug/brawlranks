import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validatePlayerPayload,
  validateClubPayload,
  validatePlayerRankingItems,
  validateClubRankingItems,
  validateBattleItem,
  validateBattleLogItems,
} from "@/lib/ingestion/schemas";

// --- Player ------------------------------------------------------------

test("player: valid payload with all fields", () => {
  const result = validatePlayerPayload({
    tag: "#ABC123",
    name: "TestPlayer",
    nameColor: "#ffffff",
    trophies: 50000,
    highestTrophies: 52000,
    expLevel: 200,
    club: { tag: "#CLUB123", name: "Test Club" },
  });
  assert.ok(result);
  assert.equal(result!.tag, "#ABC123");
  assert.equal(result!.clubTag, "#CLUB123");
});

test("player: valid payload with no club (unaffiliated player)", () => {
  const result = validatePlayerPayload({ tag: "#ABC123", name: "TestPlayer" });
  assert.ok(result);
  assert.equal(result!.clubTag, null);
});

test("player: missing tag is rejected (schema mismatch)", () => {
  assert.equal(validatePlayerPayload({ name: "NoTag" }), null);
});

test("player: non-object payload is rejected", () => {
  assert.equal(validatePlayerPayload("not-an-object"), null);
  assert.equal(validatePlayerPayload(null), null);
});

// --- Club ----------------------------------------------------------------

test("club: valid payload with members", () => {
  const result = validateClubPayload({
    tag: "#CLUB1",
    name: "My Club",
    type: "open",
    trophies: 100000,
    members: [
      { tag: "#M1", name: "Member1", role: "president", trophies: 40000 },
      { tag: "#M2", name: "Member2", role: "member" },
    ],
  });
  assert.ok(result);
  assert.equal(result!.members.length, 2);
});

test("club: malformed member entries are dropped without rejecting the club", () => {
  const result = validateClubPayload({
    tag: "#CLUB1",
    name: "My Club",
    members: [{ tag: "#M1", name: "Valid" }, { tag: "#M2" }, "not-an-object"],
  });
  assert.ok(result);
  assert.equal(result!.members.length, 1);
});

test("club: missing name is rejected", () => {
  assert.equal(validateClubPayload({ tag: "#CLUB1" }), null);
});

// --- Rankings --------------------------------------------------------------

test("rankings: valid player ranking items", () => {
  const { valid, rejected } = validatePlayerRankingItems([
    { tag: "#P1", name: "One", rank: 1, trophies: 80000, club: { name: "Club A" } },
    { tag: "#P2", name: "Two", rank: 2, trophies: 79000 },
  ]);
  assert.equal(valid.length, 2);
  assert.equal(rejected, 0);
  assert.equal(valid[0].clubName, "Club A");
  assert.equal(valid[1].clubName, null);
});

test("rankings: invalid entries (missing rank) are rejected individually", () => {
  const { valid, rejected } = validatePlayerRankingItems([{ tag: "#P1", name: "One" }]);
  assert.equal(valid.length, 0);
  assert.equal(rejected, 1);
});

test("rankings: pagination-style large list processes without error", () => {
  const items = Array.from({ length: 200 }, (_, i) => ({ tag: `#P${i}`, name: `Player${i}`, rank: i + 1 }));
  const { valid, rejected } = validatePlayerRankingItems(items);
  assert.equal(valid.length, 200);
  assert.equal(rejected, 0);
});

test("rankings: club ranking items validate independently", () => {
  const { valid, rejected } = validateClubRankingItems([{ tag: "#C1", name: "Club One", rank: 1, memberCount: 30 }]);
  assert.equal(valid.length, 1);
  assert.equal(rejected, 0);
});

// --- Battle log --------------------------------------------------------------

function teamBattle(overrides: Record<string, unknown> = {}) {
  return {
    battleTime: "20260715T120000.000Z",
    event: { id: 12345, mode: "brawlBall", map: "Center Stage" },
    battle: {
      type: "ranked",
      result: "victory",
      duration: 120,
      trophyChange: 8,
      teams: [
        [
          { tag: "#A1", name: "PlayerA1", brawler: { id: 16000000, name: "SHELLY", power: 11, trophies: 500 } },
          { tag: "#A2", name: "PlayerA2", brawler: { id: 16000001, name: "COLT", power: 9, trophies: 400 } },
        ],
        [
          { tag: "#B1", name: "PlayerB1", brawler: { id: 16000002, name: "BULL", power: 10, trophies: 450 } },
          { tag: "#B2", name: "PlayerB2", brawler: { id: 16000003, name: "BROCK", power: 8, trophies: 300 } },
        ],
      ],
      ...overrides,
    },
  };
}

test("battle: valid team battle parses with teams structure", () => {
  const result = validateBattleItem(teamBattle());
  assert.ok(result);
  assert.equal(result!.structure, "teams");
  assert.equal(result!.teams.length, 2);
  assert.equal(result!.teams[0].length, 2);
});

test("battle: valid solo/showdown battle (players array, no teams) parses as solo_ranked", () => {
  const raw = {
    battleTime: "20260715T120000.000Z",
    event: { id: 1, mode: "soloShowdown", map: "Skull Creek" },
    battle: {
      rank: 3,
      duration: 180,
      players: [
        { tag: "#A1", name: "P1", brawler: { id: 16000000, name: "SHELLY", power: 11 } },
        { tag: "#A2", name: "P2", brawler: { id: 16000001, name: "COLT", power: 9 } },
      ],
    },
  };
  const result = validateBattleItem(raw);
  assert.ok(result);
  assert.equal(result!.structure, "solo_ranked");
  assert.equal(result!.teams.length, 2);
  assert.equal(result!.results[0].rank, 3);
});

test("battle: missing battleTime is rejected (quarantine candidate)", () => {
  const raw = teamBattle();
  delete (raw as Record<string, unknown>).battleTime;
  assert.equal(validateBattleItem(raw), null);
});

test("battle: missing event.mode is rejected", () => {
  const raw = teamBattle();
  (raw as { event: Record<string, unknown> }).event = { id: 1, map: "X" };
  assert.equal(validateBattleItem(raw), null);
});

test("battle: draw result is accepted and normalized", () => {
  const result = validateBattleItem(teamBattle({ result: "draw" }));
  assert.ok(result);
  assert.equal(result!.results[0].result, "draw");
});

test("battle: unrecognized result value normalizes to 'unknown', not rejected", () => {
  const result = validateBattleItem(teamBattle({ result: "somethingNew" }));
  assert.ok(result);
  assert.equal(result!.results[0].result, "unknown");
});

test("battle: a malformed participant within one team is dropped without rejecting the whole battle", () => {
  const raw = teamBattle();
  (raw.battle.teams as unknown[][])[0].push({ tag: "#BAD" } as never);
  const result = validateBattleItem(raw);
  assert.ok(result);
  assert.equal(result!.teams[0].length, 2);
});

test("battle: an entirely empty teams array is rejected (no participants at all)", () => {
  const raw = teamBattle({ teams: [] });
  assert.equal(validateBattleItem(raw), null);
});

test("battle: gadget/star power/gear selection is never extracted (not present in the verified payload shape)", () => {
  const result = validateBattleItem(teamBattle());
  assert.ok(result);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.toLowerCase().includes("gadget"));
  assert.ok(!serialized.toLowerCase().includes("starpower"));
  assert.ok(!serialized.toLowerCase().includes("gear"));
});

test("battle log: partial payload (some valid, some invalid battles) processes the valid ones", () => {
  const { valid, rejected } = validateBattleLogItems([teamBattle(), { battleTime: "x" }, teamBattle()]);
  assert.equal(valid.length, 2);
  assert.equal(rejected, 1);
});
