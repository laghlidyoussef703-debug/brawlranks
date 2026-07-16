/**
 * Deterministic stratified fair scheduling (Phase 4.3/4.4). Pure/DB-free —
 * no skip needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectFairBatch, candidateFetchLimit, type DueCandidate } from "@/lib/ingestion/fairness";

function candidate(id: string, region: string | null, bracket: string | null, dueOffsetMs = 0, priority = 0): DueCandidate {
  return {
    id,
    playerTag: `#${id}`,
    region,
    trophyBracket: bracket,
    nextDueAt: new Date(Date.now() + dueOffsetMs),
    priorityScore: priority,
  };
}

test("empty input returns empty output", () => {
  assert.deepEqual(selectFairBatch([], 10), []);
});

test("batchSize <= 0 returns empty output", () => {
  const candidates = [candidate("1", "us", "bracket_0_5k")];
  assert.deepEqual(selectFairBatch(candidates, 0), []);
  assert.deepEqual(selectFairBatch(candidates, -5), []);
});

test("a large stratum never starves a small stratum: every stratum with a due candidate gets at least one slot in round 1", () => {
  const candidates: DueCandidate[] = [];
  for (let i = 0; i < 50; i += 1) candidates.push(candidate(`big-${i}`, "us", "bracket_0_5k"));
  candidates.push(candidate("tiny", "au", "bracket_0_5k"));

  const selected = selectFairBatch(candidates, 5);
  assert.ok(
    selected.some((c) => c.id === "tiny"),
    "the single-candidate stratum must be represented within the first batchSize picks"
  );
});

test("balanced round-robin: two equal-size strata split evenly across a batch", () => {
  const candidates: DueCandidate[] = [];
  for (let i = 0; i < 10; i += 1) {
    candidates.push(candidate(`us-${i}`, "us", "bracket_0_5k"));
    candidates.push(candidate(`br-${i}`, "br", "bracket_0_5k"));
  }
  const selected = selectFairBatch(candidates, 10);
  const usCount = selected.filter((c) => c.region === "us").length;
  const brCount = selected.filter((c) => c.region === "br").length;
  assert.equal(usCount, 5);
  assert.equal(brCount, 5);
});

test("a stratum with only one due candidate contributes it in round 1 then drops out without blocking others", () => {
  const candidates: DueCandidate[] = [candidate("solo", "au", "bracket_0_5k")];
  for (let i = 0; i < 5; i += 1) candidates.push(candidate(`us-${i}`, "us", "bracket_0_5k"));

  const selected = selectFairBatch(candidates, 6);
  assert.equal(selected.length, 6);
  assert.equal(selected.filter((c) => c.region === "au").length, 1);
  assert.equal(selected.filter((c) => c.region === "us").length, 5);
});

test("within a stratum, candidates are ordered oldest-due-first", () => {
  const candidates: DueCandidate[] = [
    candidate("newer", "us", "bracket_0_5k", 60_000),
    candidate("older", "us", "bracket_0_5k", -60_000),
  ];
  const selected = selectFairBatch(candidates, 1);
  assert.equal(selected[0].id, "older");
});

test("within a stratum, priorityScore descending breaks a nextDueAt tie", () => {
  const now = new Date();
  const candidates: DueCandidate[] = [
    { id: "low", playerTag: "#low", region: "us", trophyBracket: "bracket_0_5k", nextDueAt: now, priorityScore: 0 },
    { id: "high", playerTag: "#high", region: "us", trophyBracket: "bracket_0_5k", nextDueAt: now, priorityScore: 5 },
  ];
  const selected = selectFairBatch(candidates, 1);
  assert.equal(selected[0].id, "high");
});

test("id ascending is the final deterministic tie-breaker when nextDueAt and priorityScore both tie", () => {
  const now = new Date();
  const candidates: DueCandidate[] = [
    { id: "zzz", playerTag: "#zzz", region: "us", trophyBracket: "bracket_0_5k", nextDueAt: now, priorityScore: 0 },
    { id: "aaa", playerTag: "#aaa", region: "us", trophyBracket: "bracket_0_5k", nextDueAt: now, priorityScore: 0 },
  ];
  const selected = selectFairBatch(candidates, 1);
  assert.equal(selected[0].id, "aaa");
});

test("stable/deterministic: repeated calls with identical input produce an identical order", () => {
  const candidates: DueCandidate[] = [];
  for (let i = 0; i < 30; i += 1) {
    candidates.push(candidate(`p-${i}`, i % 3 === 0 ? "us" : i % 3 === 1 ? "br" : "au", i % 2 === 0 ? "bracket_0_5k" : "bracket_5k_15k", i * 1000));
  }
  const first = selectFairBatch(candidates, 15).map((c) => c.id);
  const second = selectFairBatch(candidates, 15).map((c) => c.id);
  assert.deepEqual(first, second);
});

test("null region/bracket forms its own valid stratum rather than crashing or being dropped", () => {
  const candidates: DueCandidate[] = [candidate("unknown-1", null, null), candidate("unknown-2", null, null)];
  const selected = selectFairBatch(candidates, 2);
  assert.equal(selected.length, 2);
});

test("never returns more than batchSize even when far more candidates are due", () => {
  const candidates: DueCandidate[] = [];
  for (let i = 0; i < 100; i += 1) candidates.push(candidate(`p-${i}`, "us", "bracket_0_5k", i));
  const selected = selectFairBatch(candidates, 7);
  assert.equal(selected.length, 7);
});

test("returns fewer than batchSize (never duplicates/pads) when the pool is smaller than batchSize", () => {
  const candidates: DueCandidate[] = [candidate("only-1", "us", "bracket_0_5k"), candidate("only-2", "br", "bracket_0_5k")];
  const selected = selectFairBatch(candidates, 10);
  assert.equal(selected.length, 2);
  const ids = selected.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("candidateFetchLimit is bounded between a floor and a ceiling and scales with batchSize", () => {
  assert.equal(candidateFetchLimit(1), 200);
  assert.equal(candidateFetchLimit(10), 200);
  assert.equal(candidateFetchLimit(100), 800);
  assert.equal(candidateFetchLimit(10_000), 2000);
});
