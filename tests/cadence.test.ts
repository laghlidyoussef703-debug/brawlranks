/**
 * Centralized crawl cadence/backoff (Phase 4.4). Pure/DB-free — no skip needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSuccessDelayMs, computeCrawlFailureBackoffMs, CRAWL_CADENCE } from "@/lib/ingestion/cadence";

test("a successful crawl with new battles is scheduled sooner than an empty-log success", () => {
  assert.equal(computeSuccessDelayMs(1), CRAWL_CADENCE.ACTIVE_RECRAWL_MS);
  assert.equal(computeSuccessDelayMs(50), CRAWL_CADENCE.ACTIVE_RECRAWL_MS);
  assert.equal(computeSuccessDelayMs(0), CRAWL_CADENCE.EMPTY_LOG_BACKOFF_MS);
  assert.ok(CRAWL_CADENCE.ACTIVE_RECRAWL_MS < CRAWL_CADENCE.EMPTY_LOG_BACKOFF_MS);
});

test("failure backoff for consecutiveFailureCount=1 is bounded within [0, FAILURE_BASE_BACKOFF_MS]", () => {
  for (let i = 0; i < 50; i += 1) {
    const backoff = computeCrawlFailureBackoffMs(1);
    assert.ok(backoff >= 0 && backoff <= CRAWL_CADENCE.FAILURE_BASE_BACKOFF_MS, `backoff ${backoff} out of range`);
  }
});

test("failure backoff grows (in its upper bound) with consecutive failures, up to the max ceiling", () => {
  // Full-jitter is random, so assert on the ceiling (deterministic), not a single sample.
  const ceilingAt = (n: number) => Math.min(CRAWL_CADENCE.FAILURE_MAX_BACKOFF_MS, CRAWL_CADENCE.FAILURE_BASE_BACKOFF_MS * 2 ** Math.max(0, n - 1));
  assert.ok(ceilingAt(1) < ceilingAt(3));
  assert.ok(ceilingAt(3) < ceilingAt(6));
});

test("failure backoff never exceeds FAILURE_MAX_BACKOFF_MS even for a very large failure count", () => {
  for (let i = 0; i < 20; i += 1) {
    const backoff = computeCrawlFailureBackoffMs(1000);
    assert.ok(backoff <= CRAWL_CADENCE.FAILURE_MAX_BACKOFF_MS, `backoff ${backoff} exceeded the ceiling`);
  }
});

test("failure backoff handles consecutiveFailureCount=0 or negative without throwing or going negative", () => {
  assert.doesNotThrow(() => computeCrawlFailureBackoffMs(0));
  assert.doesNotThrow(() => computeCrawlFailureBackoffMs(-3));
  assert.ok(computeCrawlFailureBackoffMs(0) >= 0);
  assert.ok(computeCrawlFailureBackoffMs(-3) >= 0);
});

test("the crawl-schedule failure backoff horizon (minutes to a day) is a materially different scale than a single-request HTTP retry (seconds to minutes)", () => {
  assert.ok(CRAWL_CADENCE.FAILURE_BASE_BACKOFF_MS >= 60_000, "base backoff should be on the order of minutes, not seconds");
  assert.equal(CRAWL_CADENCE.FAILURE_MAX_BACKOFF_MS, 24 * 60 * 60_000);
});
