/**
 * Regression coverage for the production bug fixed in
 * lib/ingestion/sync/battleLogCrawlSync.ts: the DigitalOcean proxy nests
 * battle-log data under `payload` (the same envelope every proxy endpoint
 * uses — { ok, status, fetchedAt, payload: { items } }), never at the
 * envelope's top level. battleLogCrawlSync previously read `body.items`
 * directly, which is always undefined against the real envelope, so
 * every successful HTTP 200 battle-log fetch silently became zero
 * battles — confirmed in production: rawSnapshotCountByEndpoint.battle_log
 * = 50, normalizedBattleCount = 0, battlesIngested = 0.
 *
 * These tests exercise the exact data flow the fixed code now uses:
 * validateProxyEnvelope(proxyResult).payload.items ->
 * validateBattleLogItems(items) — the same two functions
 * lib/ingestion/sync/battleLogCrawlSync.ts calls in sequence.
 * tests/proxyEnvelope.test.ts already covers validateProxyEnvelope
 * generically; these focus on the battle-log-specific integration and the
 * "invalid envelope vs. valid-but-empty envelope" distinction the fix's
 * failure-handling branch depends on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProxyEnvelope, type ProxyBrawlersResult } from "@/lib/proxy";
import { validateBattleLogItems } from "@/lib/ingestion/schemas";

function proxyResult(body: unknown, httpStatus = 200): ProxyBrawlersResult {
  return { proxyReached: true, httpStatus, body };
}

function sampleBattleItem(overrides: Record<string, unknown> = {}) {
  return {
    battleTime: "20260716T120000.000Z",
    event: { id: 12345, mode: "brawlBall", map: "Center Stage" },
    battle: {
      type: "ranked",
      result: "victory",
      duration: 120,
      trophyChange: 8,
      teams: [
        [{ tag: "#PYLQ289", name: "PlayerA", brawler: { id: 16000000, name: "SHELLY", power: 11, trophies: 500 } }],
        [{ tag: "#RJCUV02", name: "PlayerB", brawler: { id: 16000001, name: "COLT", power: 9, trophies: 400 } }],
      ],
      ...overrides,
    },
  };
}

test("1. a valid envelope with payload.items is parsed by validateProxyEnvelope and its items are processed by validateBattleLogItems", () => {
  const result = proxyResult({
    ok: true,
    status: 200,
    fetchedAt: "2026-07-16T12:00:00.000Z",
    payload: { items: [sampleBattleItem()] },
  });

  const validated = validateProxyEnvelope(result);
  assert.ok(validated, "expected a well-formed battle-log envelope to validate");
  assert.equal(validated!.payload.items.length, 1);

  const { valid, rejected } = validateBattleLogItems(validated!.payload.items);
  assert.equal(valid.length, 1, "the battle carried in payload.items must reach validateBattleLogItems and parse successfully");
  assert.equal(rejected, 0);
  assert.equal(valid[0].mode, "brawlBall");
  assert.equal(valid[0].teams.length, 2);
});

test("2. the legacy/incorrect top-level items shape (the pre-fix bug shape) is rejected by validateProxyEnvelope, not silently emptied", () => {
  // This is exactly the shape the old `body.items` read needed to find
  // anything. The real proxy envelope never looks like this — proving the
  // old code path could never have worked against production traffic.
  const result = proxyResult({
    ok: true,
    status: 200,
    fetchedAt: "2026-07-16T12:00:00.000Z",
    items: [sampleBattleItem()],
  });

  const validated = validateProxyEnvelope(result);
  assert.equal(validated, null, "an envelope missing `payload` must not validate, even though `items` exists elsewhere in the body");
});

test("3. an invalid envelope is distinguishable from a valid envelope with zero battles — the exact branch battleLogCrawlSync's failure handling relies on", () => {
  // Before the fix, both of these cases produced `items = []` identically
  // — there was no way to tell "the proxy validly reported no new
  // battles" apart from "we failed to parse a malformed response". The
  // fix's `if (!validated) { ...mark fetch run failed...; continue; }`
  // branch depends on validateProxyEnvelope returning null in exactly the
  // first case and a real (possibly empty) payload in the second.
  const malformedEnvelope = proxyResult({ ok: true, status: 200, fetchedAt: "2026-07-16T12:00:00.000Z" }); // no `payload` at all
  const validButEmptyEnvelope = proxyResult({
    ok: true,
    status: 200,
    fetchedAt: "2026-07-16T12:00:00.000Z",
    payload: { items: [] },
  });

  const malformedResult = validateProxyEnvelope(malformedEnvelope);
  const emptyResult = validateProxyEnvelope(validButEmptyEnvelope);

  assert.equal(malformedResult, null, "a malformed envelope must be rejected (this is what now marks the fetch run as failed)");
  assert.ok(emptyResult, "a well-formed envelope reporting zero battles must still validate (this is a legitimate empty result, not a failure)");
  assert.equal(emptyResult!.payload.items.length, 0);
});
