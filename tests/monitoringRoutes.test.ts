/**
 * DATASET Phase 15 — internal monitoring route authentication (DB-free).
 * Every monitoring route must reject an unauthenticated request BEFORE touching
 * the database, and never leak a stack trace.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const GET_ROUTES = [
  "@/app/api/internal/monitoring/health/route",
  "@/app/api/internal/monitoring/capacity/route",
  "@/app/api/internal/monitoring/alerts/route",
] as const;
const POST_ROUTES = [
  "@/app/api/internal/cron/monitoring-snapshot/route",
  "@/app/api/internal/cron/monitoring-evaluate/route",
] as const;

for (const mod of GET_ROUTES) {
  test(`security: GET ${mod} rejects unauthenticated`, async () => {
    const { GET } = await import(mod);
    const res = await GET(new Request("http://localhost/x"));
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.equal(JSON.parse(text).ok, false);
    assert.doesNotMatch(text, /at [A-Za-z0-9_.]+ \(.*:\d+:\d+\)/, "no stack trace");
  });
}

for (const mod of POST_ROUTES) {
  test(`security: POST ${mod} rejects unauthenticated`, async () => {
    const { POST } = await import(mod);
    const res = await POST(new Request("http://localhost/x", { method: "POST" }));
    assert.equal(res.status, 401);
    assert.equal(JSON.parse(await res.text()).ok, false);
  });
}

test("security: a malformed bearer is rejected", async () => {
  const { GET } = await import("@/app/api/internal/monitoring/health/route");
  const res = await GET(new Request("http://localhost/x", { headers: { authorization: "NotBearer xyz" } }));
  assert.equal(res.status, 401);
});
