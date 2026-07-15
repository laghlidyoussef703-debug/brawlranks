import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAndNormalizeTag, encodeTagForPath } from "@/lib/ingestion/tags";
import { classifyHttpStatus, classifyMysqlError, decideRetry, computeBackoffMs } from "@/lib/ingestion/retry";

// --- Tag normalization -----------------------------------------------------

// Valid tag characters are restricted to Supercell's tag alphabet
// (0289PYLQGRJCUV) — letters/digits easily confused with each other
// (1, I, O, 0-lookalikes, etc.) are deliberately excluded from real tags.

test("tags: valid tag without leading # gets normalized", () => {
  const result = validateAndNormalizeTag("pylq289");
  assert.equal(result.valid, true);
  assert.equal(result.normalized, "#PYLQ289");
});

test("tags: valid tag with leading # is preserved and uppercased", () => {
  const result = validateAndNormalizeTag("#pylq289");
  assert.equal(result.valid, true);
  assert.equal(result.normalized, "#PYLQ289");
});

test("tags: empty string is invalid", () => {
  const result = validateAndNormalizeTag("");
  assert.equal(result.valid, false);
  assert.equal(result.reason, "empty");
});

test("tags: invalid characters (e.g. 'I', 'O', 'B', 'D' are not in the tag alphabet) are rejected", () => {
  const result = validateAndNormalizeTag("#IOBD1");
  assert.equal(result.valid, false);
  assert.equal(result.reason, "invalid_characters");
});

test("tags: encodeTagForPath percent-encodes the leading #", () => {
  assert.equal(encodeTagForPath("#ABC123"), "%23ABC123");
});

// --- Failure classification -------------------------------------------------

test("retry: classifies 429 as rate_limited", () => {
  assert.equal(classifyHttpStatus(429), "rate_limited");
});

test("retry: classifies 404 as not_found", () => {
  assert.equal(classifyHttpStatus(404), "not_found");
});

test("retry: classifies 401/403 as unauthorized", () => {
  assert.equal(classifyHttpStatus(401), "unauthorized");
  assert.equal(classifyHttpStatus(403), "unauthorized");
});

test("retry: classifies 5xx as server_error", () => {
  assert.equal(classifyHttpStatus(500), "server_error");
  assert.equal(classifyHttpStatus(503), "server_error");
});

test("retry: classifies proxy timeout transport error as timeout", () => {
  assert.equal(classifyHttpStatus(null, "proxy_timeout"), "timeout");
});

test("retry: classifies proxy unreachable as proxy_unavailable", () => {
  assert.equal(classifyHttpStatus(null, "proxy_unreachable"), "proxy_unavailable");
});

test("retry: classifies invalid JSON response as schema_mismatch", () => {
  assert.equal(classifyHttpStatus(200, "invalid_json_response"), "schema_mismatch");
});

test("retry: classifies a MySQL deadlock error code", () => {
  assert.equal(classifyMysqlError({ code: "ER_LOCK_DEADLOCK" }), "deadlock");
});

test("retry: classifies a MySQL lock-wait-timeout error code", () => {
  assert.equal(classifyMysqlError({ code: "ER_LOCK_WAIT_TIMEOUT" }), "lock_timeout");
});

test("retry: an unrecognized MySQL error falls back to transaction_failure", () => {
  assert.equal(classifyMysqlError({ code: "ER_SOMETHING_ELSE" }), "transaction_failure");
});

// --- Retry decisions ---------------------------------------------------------

test("retry: not_found is never retried, even on the first attempt", () => {
  const decision = decideRetry("not_found", 1);
  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.terminalStatus, "dead");
});

test("retry: schema_mismatch is never retried", () => {
  const decision = decideRetry("schema_mismatch", 1);
  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.terminalStatus, "dead");
});

test("retry: a timeout is retried below its max attempts", () => {
  const decision = decideRetry("timeout", 1);
  assert.equal(decision.shouldRetry, true);
  assert.equal(decision.terminalStatus, "failed");
});

test("retry: a timeout stops retrying once max attempts is reached (no tight retry loop)", () => {
  const decision = decideRetry("timeout", 3);
  assert.equal(decision.shouldRetry, false);
});

test("retry: rate_limited allows more attempts than a generic timeout", () => {
  const timeoutDecision = decideRetry("timeout", 4);
  const rateLimitDecision = decideRetry("rate_limited", 4);
  assert.equal(timeoutDecision.shouldRetry, false);
  assert.equal(rateLimitDecision.shouldRetry, true);
});

test("retry: Retry-After is honored exactly when present", () => {
  const delay = computeBackoffMs(1, 30);
  assert.equal(delay, 30_000);
});

test("retry: exponential backoff grows with attempt count (bounded by jitter ceiling)", () => {
  // computeBackoffMs uses full jitter, so we assert the ceiling grows, not
  // the exact sampled value.
  const samples = (attempt: number) =>
    Array.from({ length: 20 }, () => computeBackoffMs(attempt)).reduce((max, v) => Math.max(max, v), 0);
  const ceilingAttempt1 = samples(1);
  const ceilingAttempt4 = samples(4);
  assert.ok(ceilingAttempt4 >= ceilingAttempt1);
});

test("retry: backoff never exceeds the configured maximum delay", () => {
  const delay = computeBackoffMs(20);
  assert.ok(delay <= 5 * 60_000);
});
