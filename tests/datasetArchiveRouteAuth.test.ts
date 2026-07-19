/**
 * DATASET Phase 4 — the raw-snapshot-archive cron route rejects unauthorized
 * requests BEFORE touching storage or the database (auth checked first), so
 * these run with no DB/S3 connection — same pattern as every other routes-auth
 * test file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as archiveRoute } from "@/app/api/internal/cron/raw-snapshot-archive/route";

const URL = "http://localhost/api/internal/cron/raw-snapshot-archive";

test("security: raw-snapshot-archive rejects a request with no authorization header", async () => {
  const response = await archiveRoute(new Request(URL, { method: "POST" }));
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
});

test("security: raw-snapshot-archive rejects an obviously wrong bearer token", async () => {
  const response = await archiveRoute(
    new Request(URL, { method: "POST", headers: { authorization: "Bearer not-the-real-secret" } })
  );
  assert.equal(response.status, 401);
});

test("security: raw-snapshot-archive rejects a secret passed via query string", async () => {
  const response = await archiveRoute(new Request(`${URL}?secret=x&token=y`, { method: "POST" }));
  assert.equal(response.status, 401);
});

test("security: raw-snapshot-archive never leaks a stack trace in the 401 body", async () => {
  const response = await archiveRoute(new Request(URL, { method: "POST" }));
  const text = await response.text();
  assert.doesNotMatch(text, /at [A-Za-z0-9_.]+ \(.*:\d+:\d+\)/);
});
