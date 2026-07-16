/**
 * Security: the three Phase 4 internal routes reject unauthorized requests
 * BEFORE touching the database (auth check runs first in every route), so
 * these run without any DB connection — same pattern as
 * tests/ingestionRoutesAuth.test.ts for the Phase 3 routes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as retentionSweep } from "@/app/api/internal/cron/retention-sweep/route";
import { GET as datasetCoverage } from "@/app/api/internal/test/dataset-coverage/route";
import { GET as phase5Readiness } from "@/app/api/internal/test/phase5-readiness/route";

const ROUTES: Array<{ name: string; handler: (req: Request) => Promise<Response>; method: string; url: string }> = [
  { name: "retention-sweep", handler: retentionSweep, method: "POST", url: "http://localhost/api/internal/cron/retention-sweep" },
  { name: "dataset-coverage", handler: datasetCoverage, method: "GET", url: "http://localhost/api/internal/test/dataset-coverage" },
  { name: "phase5-readiness", handler: phase5Readiness, method: "GET", url: "http://localhost/api/internal/test/phase5-readiness" },
];

for (const route of ROUTES) {
  test(`security: ${route.name} rejects a request with no authorization header`, async () => {
    const request = new Request(route.url, { method: route.method });
    const response = await route.handler(request);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.ok, false);
  });

  test(`security: ${route.name} rejects a request with an obviously wrong bearer token`, async () => {
    const request = new Request(route.url, {
      method: route.method,
      headers: { authorization: "Bearer definitely-not-the-real-secret" },
    });
    const response = await route.handler(request);
    assert.equal(response.status, 401);
  });

  test(`security: ${route.name} rejects a secret passed via query string instead of the header`, async () => {
    const request = new Request(`${route.url}?secret=whatever&token=whatever`, { method: route.method });
    const response = await route.handler(request);
    assert.equal(response.status, 401);
  });

  test(`security: ${route.name} never leaks a stack trace in the 401 response body`, async () => {
    const request = new Request(route.url, { method: route.method });
    const response = await route.handler(request);
    const text = await response.text();
    assert.doesNotMatch(text, /at [A-Za-z0-9_.]+ \(.*:\d+:\d+\)/, "response body looks like it contains a stack trace frame");
  });
}

test("security: retention-sweep with an unauthorized request and a malformed JSON body still returns 401, not a 500 from body parsing", async () => {
  const request = new Request("http://localhost/api/internal/cron/retention-sweep", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json",
  });
  const response = await retentionSweep(request);
  assert.equal(response.status, 401);
});
