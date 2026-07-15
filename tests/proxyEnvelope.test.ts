/**
 * Regression coverage for the production bug fixed in
 * lib/ingestion/sync/rankingSeedSync.ts: the DigitalOcean proxy nests the
 * official API's data under `payload` (the same envelope every proxy
 * endpoint uses — { ok, status, fetchedAt, payload: { items } }), never at
 * the envelope's top level. rankingSeedSync previously read `body.items`
 * directly, which is always undefined against the real envelope shape, so
 * `entriesFetched` silently stayed 0 even on a real HTTP 200 with real
 * ranking data. The fix reuses validateProxyEnvelope (the same helper
 * lib/catalog/sync.ts already uses for /v1/brawlers) — these tests exercise
 * that exact function against a realistic proxy response shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProxyEnvelope, type ProxyBrawlersResult } from "@/lib/proxy";

function proxyResult(body: unknown, httpStatus = 200): ProxyBrawlersResult {
  return { proxyReached: true, httpStatus, body };
}

test("proxy envelope: a successful envelope with payload.items returns the entries", () => {
  const rankingEntries = [
    { tag: "#PYLQ289", name: "PlayerOne", rank: 1, trophies: 80000 },
    { tag: "#RJCUV02", name: "PlayerTwo", rank: 2, trophies: 79500 },
  ];
  const result = proxyResult({
    ok: true,
    status: 200,
    fetchedAt: "2026-07-16T00:00:00.000Z",
    payload: { items: rankingEntries },
  });

  const validated = validateProxyEnvelope(result);
  assert.ok(validated, "expected a well-formed envelope to validate successfully");
  assert.equal(validated!.payload.items.length, 2);
  assert.deepEqual(validated!.payload.items, rankingEntries);
});

test("proxy envelope: an empty items array is still a valid (zero-entry) envelope", () => {
  const result = proxyResult({ ok: true, status: 200, fetchedAt: "2026-07-16T00:00:00.000Z", payload: { items: [] } });
  const validated = validateProxyEnvelope(result);
  assert.ok(validated);
  assert.equal(validated!.payload.items.length, 0);
});

test("proxy envelope: the pre-fix bug shape (items at the top level, not under payload) is rejected, not silently emptied", () => {
  // This is exactly the shape the old `body.items` read would have needed
  // to find anything — proving the envelope the proxy actually sends does
  // NOT match it, so the old code could never have worked.
  const result = proxyResult({
    ok: true,
    status: 200,
    fetchedAt: "2026-07-16T00:00:00.000Z",
    items: [{ tag: "#PYLQ289", name: "PlayerOne", rank: 1, trophies: 80000 }],
  });
  const validated = validateProxyEnvelope(result);
  assert.equal(validated, null, "an envelope missing `payload` must not validate, even if the fields exist elsewhere");
});

test("proxy envelope: ok !== true is rejected even with a well-formed payload.items", () => {
  const result = proxyResult({
    ok: false,
    status: 200,
    fetchedAt: "2026-07-16T00:00:00.000Z",
    payload: { items: [{ tag: "#PYLQ289", name: "PlayerOne", rank: 1 }] },
  });
  assert.equal(validateProxyEnvelope(result), null);
});

test("proxy envelope: a non-200 outer HTTP status is rejected regardless of body content", () => {
  const result = proxyResult(
    { ok: true, status: 200, fetchedAt: "2026-07-16T00:00:00.000Z", payload: { items: [] } },
    502
  );
  assert.equal(validateProxyEnvelope(result), null);
});

test("proxy envelope: payload present but items is not an array is rejected", () => {
  const result = proxyResult({
    ok: true,
    status: 200,
    fetchedAt: "2026-07-16T00:00:00.000Z",
    payload: { items: "not-an-array" },
  });
  assert.equal(validateProxyEnvelope(result), null);
});
