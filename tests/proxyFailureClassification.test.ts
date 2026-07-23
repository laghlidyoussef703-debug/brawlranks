/**
 * Unit tests for classifyProxyFailure (lib/ingestion/retry.ts).
 *
 * Guards the Phase 10 player-crawl bug: proxy.brawlranks.com returns an outer
 * HTTP 502 for ANY upstream error and wraps the official-API status in the body
 * as { error: "upstream_api_error", upstreamStatus: N }. An official-API 404
 * wrapped in a 502 must classify as not_found (canonical player-not-found), not
 * server_error — while a genuine proxy/transport 502 must stay server_error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProxyFailure, extractUpstreamApiErrorStatus } from "../lib/ingestion/retry";

test("proxy 502 wrapping upstreamStatus 404 classifies as not_found, not server_error", () => {
  const { code, upstreamStatus } = classifyProxyFailure(502, undefined, { ok: false, error: "upstream_api_error", upstreamStatus: 404 });
  assert.equal(code, "not_found", "the upstream 404 is authoritative");
  assert.equal(upstreamStatus, 404, "the upstream status is surfaced for persistence");
});

test("a genuine proxy/server 502 WITHOUT an upstream_api_error envelope remains server_error", () => {
  // Bare 502 (proxy itself failed / no envelope).
  const bare = classifyProxyFailure(502, undefined, { ok: false, error: "bad_gateway" });
  assert.equal(bare.code, "server_error");
  assert.equal(bare.upstreamStatus, null);

  // 502 with a null/absent body.
  assert.equal(classifyProxyFailure(502, undefined, null).code, "server_error");
});

test("upstream status other than 404 classifies from the upstream status (not the outer 502)", () => {
  assert.equal(classifyProxyFailure(502, undefined, { error: "upstream_api_error", upstreamStatus: 500 }).code, "server_error");
  assert.equal(classifyProxyFailure(502, undefined, { error: "upstream_api_error", upstreamStatus: 503 }).code, "server_error");
  assert.equal(classifyProxyFailure(502, undefined, { error: "upstream_api_error", upstreamStatus: 429 }).code, "rate_limited");
  assert.equal(classifyProxyFailure(502, undefined, { error: "upstream_api_error", upstreamStatus: 403 }).code, "unauthorized");
});

test("a direct (non-proxied) 404 still classifies as not_found", () => {
  const { code, upstreamStatus } = classifyProxyFailure(404, undefined, null);
  assert.equal(code, "not_found");
  assert.equal(upstreamStatus, null, "no envelope -> nothing extra to persist");
});

test("transport errors are honored when there is no upstream envelope", () => {
  assert.equal(classifyProxyFailure(null, "proxy_timeout", null).code, "timeout");
  assert.equal(classifyProxyFailure(null, "proxy_unreachable", null).code, "proxy_unavailable");
  assert.equal(classifyProxyFailure(null, undefined, null).code, "network_failure");
});

test("extractUpstreamApiErrorStatus only matches the exact envelope shape", () => {
  assert.equal(extractUpstreamApiErrorStatus({ error: "upstream_api_error", upstreamStatus: 404 }), 404);
  assert.equal(extractUpstreamApiErrorStatus({ error: "other", upstreamStatus: 404 }), null, "wrong error key -> null");
  assert.equal(extractUpstreamApiErrorStatus({ error: "upstream_api_error" }), null, "missing upstreamStatus -> null");
  assert.equal(extractUpstreamApiErrorStatus({ error: "upstream_api_error", upstreamStatus: "404" }), null, "non-numeric upstreamStatus -> null");
  assert.equal(extractUpstreamApiErrorStatus(null), null);
  assert.equal(extractUpstreamApiErrorStatus("nope"), null);
});
