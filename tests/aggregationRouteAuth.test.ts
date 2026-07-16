/**
 * Security: the Phase 5.2 aggregation-run route rejects unauthorized
 * requests BEFORE touching the database (auth checked first), so these run
 * without any DB connection — same pattern as every prior phase's routes-
 * auth test file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as aggregationRun } from "@/app/api/internal/cron/aggregation-run/route";

const URL = "http://localhost/api/internal/cron/aggregation-run";

test("security: aggregation-run rejects a request with no authorization header", async () => {
  const response = await aggregationRun(new Request(URL, { method: "POST" }));
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
});

test("security: aggregation-run rejects a request with an obviously wrong bearer token", async () => {
  const response = await aggregationRun(
    new Request(URL, { method: "POST", headers: { authorization: "Bearer definitely-not-the-real-secret" } })
  );
  assert.equal(response.status, 401);
});

test("security: aggregation-run rejects a secret passed via query string instead of the header", async () => {
  const response = await aggregationRun(new Request(`${URL}?secret=whatever&token=whatever`, { method: "POST" }));
  assert.equal(response.status, 401);
});

test("security: aggregation-run never leaks a stack trace in the 401 response body", async () => {
  const response = await aggregationRun(new Request(URL, { method: "POST" }));
  const text = await response.text();
  assert.doesNotMatch(text, /at [A-Za-z0-9_.]+ \(.*:\d+:\d+\)/);
});
