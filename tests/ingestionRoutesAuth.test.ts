/**
 * Security: every new Phase 3 internal route rejects unauthorized requests
 * BEFORE touching the database (the auth check runs first in every route),
 * so these run without any DB connection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as rankingSeedRefresh } from "@/app/api/internal/cron/ranking-seed-refresh/route";
import { POST as playerDiscovery } from "@/app/api/internal/cron/player-discovery/route";
import { POST as playerCrawlBatch } from "@/app/api/internal/cron/player-crawl-batch/route";
import { POST as battleLogCrawlBatch } from "@/app/api/internal/cron/battle-log-crawl-batch/route";
import { POST as clubExpansion } from "@/app/api/internal/cron/club-expansion/route";
import { GET as ingestionHealth } from "@/app/api/internal/test/ingestion-health/route";

const ROUTES: Array<{ name: string; handler: (req: Request) => Promise<Response>; method: string; url: string }> = [
  { name: "ranking-seed-refresh", handler: rankingSeedRefresh, method: "POST", url: "http://localhost/api/internal/cron/ranking-seed-refresh" },
  { name: "player-discovery", handler: playerDiscovery, method: "POST", url: "http://localhost/api/internal/cron/player-discovery" },
  { name: "player-crawl-batch", handler: playerCrawlBatch, method: "POST", url: "http://localhost/api/internal/cron/player-crawl-batch" },
  { name: "battle-log-crawl-batch", handler: battleLogCrawlBatch, method: "POST", url: "http://localhost/api/internal/cron/battle-log-crawl-batch" },
  { name: "club-expansion", handler: clubExpansion, method: "POST", url: "http://localhost/api/internal/cron/club-expansion" },
  { name: "ingestion-health", handler: ingestionHealth, method: "GET", url: "http://localhost/api/internal/test/ingestion-health" },
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
}
