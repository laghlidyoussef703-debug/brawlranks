/**
 * Player discovery promotion fairness (Phase 4.5) — selectPromotionBatch is
 * pure/DB-free, no skip needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPromotionBatch } from "@/lib/ingestion/sync/playerDiscoverySync";
import type { UnpromotedObservedPlayer } from "@/lib/ingestion/repository";

function observed(tag: string, sourceType: string, clubTag: string | null = null): UnpromotedObservedPlayer {
  return { tag, sourceType, clubTag };
}

test("empty candidate pool returns empty output", () => {
  assert.deepEqual(selectPromotionBatch([], {}, 10), []);
});

test("batchSize <= 0 returns empty output", () => {
  assert.deepEqual(selectPromotionBatch([observed("#a", "battle_participant")], {}, 0), []);
});

test("a large single club never dominates: a 100-member club and one battle_participant observation split evenly per round", () => {
  const candidates: UnpromotedObservedPlayer[] = [];
  for (let i = 0; i < 100; i += 1) candidates.push(observed(`#club-${i}`, "club_member", "BIGCLUB"));
  candidates.push(observed("#solo", "battle_participant"));

  const selected = selectPromotionBatch(candidates, {}, 2);
  assert.equal(selected.length, 2);
  assert.ok(selected.some((c) => c.tag === "#solo"), "the non-club stratum must get a slot within the first round");
});

test("club_member observations are sub-grouped by club tag: two different clubs are two separate strata, neither dominates the other", () => {
  const candidates: UnpromotedObservedPlayer[] = [];
  for (let i = 0; i < 20; i += 1) candidates.push(observed(`#a-${i}`, "club_member", "CLUBA"));
  for (let i = 0; i < 3; i += 1) candidates.push(observed(`#b-${i}`, "club_member", "CLUBB"));

  const selected = selectPromotionBatch(candidates, {}, 6);
  const fromA = selected.filter((c) => c.tag.startsWith("#a-")).length;
  const fromB = selected.filter((c) => c.tag.startsWith("#b-")).length;
  assert.equal(fromA, 3);
  assert.equal(fromB, 3);
});

test("underrepresented-first: a coarse source type with fewer currently-active players is visited before a well-represented one", () => {
  const candidates: UnpromotedObservedPlayer[] = [
    observed("#underrep", "battle_opponent"),
    observed("#overrep", "battle_participant"),
  ];
  const currentCounts = { battle_participant: 1000, battle_opponent: 1 };

  const selected = selectPromotionBatch(candidates, currentCounts, 1);
  assert.equal(selected[0].tag, "#underrep");
});

test("deterministic: repeated calls with identical input produce an identical selection", () => {
  const candidates: UnpromotedObservedPlayer[] = [];
  for (let i = 0; i < 25; i += 1) {
    candidates.push(observed(`#p-${i}`, i % 2 === 0 ? "club_member" : "battle_participant", i % 2 === 0 ? `CLUB${i % 3}` : null));
  }
  const counts = { club_member: 5, battle_participant: 2 };
  const first = selectPromotionBatch(candidates, counts, 12).map((c) => c.tag);
  const second = selectPromotionBatch(candidates, counts, 12).map((c) => c.tag);
  assert.deepEqual(first, second);
});

test("never returns more than batchSize and never duplicates a candidate", () => {
  const candidates: UnpromotedObservedPlayer[] = [];
  for (let i = 0; i < 50; i += 1) candidates.push(observed(`#p-${i}`, "battle_participant"));
  const selected = selectPromotionBatch(candidates, {}, 9);
  assert.equal(selected.length, 9);
  assert.equal(new Set(selected.map((c) => c.tag)).size, 9);
});

test("a club_member with a null clubTag (unknown) is still handled as its own stratum, not dropped or thrown", () => {
  const candidates: UnpromotedObservedPlayer[] = [observed("#mystery", "club_member", null)];
  const selected = selectPromotionBatch(candidates, {}, 1);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].tag, "#mystery");
});
