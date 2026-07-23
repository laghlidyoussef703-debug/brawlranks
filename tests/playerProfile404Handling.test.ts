/**
 * Phase 10 player-crawl 404 handling — end-to-end (DB integration).
 *
 * Reproduces the production failure: the proxy returns outer HTTP 502 wrapping
 * { error: "upstream_api_error", upstreamStatus: 404 } for a stale/invalid tag.
 * The fetch must be classified as the canonical not_found (not server_error),
 * the player marked unreachable, and thus dropped from getUnprofiledPlayerTags
 * so it stops blocking the head of the crawl queue — while both status layers
 * (proxy 502 + upstream 404) are preserved on the fetch run.
 *
 * The player-profile crawl selects work via normalized_players.is_reachable
 * (getUnprofiledPlayerTags), not player_crawl_schedule leasing (that is the
 * battle-log crawl's contract), so "no longer due" == "no longer selectable"
 * and there is no lease to release beyond completing the fetch run.
 *
 * globalThis.fetch is mocked so NO real proxy/network call is made. Requires a
 * migrated DB (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1) — SKIPs otherwise.
 */
import { test, before, after } from "node:test";
import { closeSharedDbPoolAfterTests } from "./helpers/closeDbPool";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool, RowDataPacket } from "mysql2/promise";

const hasDbEnv = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1
);
const skip = !hasDbEnv;
const skipReason = "No DB credentials in this environment (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";

closeSharedDbPoolAfterTests();

const TAG_CHARS = "0289PYLQGRJCUV";
function validTag(): string {
  let t = "#";
  for (let i = 0; i < 9; i += 1) t += TAG_CHARS[Math.floor(Math.random() * TAG_CHARS.length)];
  return t;
}

let realFetch: typeof globalThis.fetch | undefined;
function mockProxy(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
}

async function ensurePrereqs(pool: Pool): Promise<void> {
  const { getDataSourceByName, getSourceEndpoint } = await import("@/lib/catalog/repository");
  const existing = await getDataSourceByName(pool, "official-brawl-stars-api");
  let dsId: string;
  if (existing) {
    dsId = existing.id;
  } else {
    dsId = randomUUID();
    await pool.execute("INSERT INTO data_sources (id, name, source_type, is_enabled) VALUES (?, 'official-brawl-stars-api', 'official_api', 1)", [dsId]);
  }
  if (!(await getSourceEndpoint(pool, dsId, "player_profile"))) {
    await pool.execute(
      "INSERT INTO source_endpoints (id, data_source_id, endpoint_category, path, method, schema_version, is_enabled) VALUES (?, ?, 'player_profile', '/v1/players/{tag}', 'GET', 'v1', 1)",
      [randomUUID(), dsId]
    );
  }
  const [[budget]] = await pool.query<RowDataPacket[]>("SELECT id FROM ingestion_rate_budgets WHERE budget_scope='player_profile'");
  if (!budget) {
    await pool.execute("INSERT INTO ingestion_rate_budgets (id, budget_scope, window_seconds, request_ceiling) VALUES (?, 'player_profile', 86400, 1000000)", [randomUUID()]);
  }
}

async function seedStub(pool: Pool, tag: string): Promise<void> {
  const { getDataSourceByName, getSourceEndpoint, createFetchRun } = await import("@/lib/catalog/repository");
  const { ensurePlayerStub } = await import("@/lib/ingestion/repository");
  const ds = await getDataSourceByName(pool, "official-brawl-stars-api");
  const ep = await getSourceEndpoint(pool, ds!.id, "player_profile");
  const seedRun = await createFetchRun(pool, { dataSourceId: ds!.id, sourceEndpointId: ep!.id, workflowRunId: null, triggerType: "cron" });
  await ensurePlayerStub(pool, tag, "Stub Player", seedRun);
}

async function playerRow(pool: Pool, tag: string): Promise<RowDataPacket> {
  const [[row]] = await pool.query<RowDataPacket[]>(
    "SELECT is_reachable, unreachable_reason, trophies FROM normalized_players WHERE player_tag = ?",
    [tag]
  );
  return row;
}

async function latestFetchRunFor(pool: Pool, tag: string): Promise<RowDataPacket> {
  const [[row]] = await pool.query<RowDataPacket[]>(
    "SELECT http_status, error_code, error_message, status FROM data_fetch_runs WHERE request_context LIKE ? ORDER BY created_at DESC LIMIT 1",
    [`%${tag}%`]
  );
  return row;
}

before(async () => {
  if (!hasDbEnv) return;
  process.env.DIGITALOCEAN_PROXY_URL ??= "http://proxy.local.test";
  process.env.PROXY_SHARED_SECRET ??= "test-only-secret";
  realFetch = globalThis.fetch;
  const { getPool } = await import("@/lib/mysql");
  await ensurePrereqs(getPool());
});

after(() => {
  if (realFetch) globalThis.fetch = realFetch;
});

test("db: proxy 502 wrapping upstream 404 -> not_found; player unreachable, dropped from queue, both statuses preserved", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { syncOnePlayerProfile } = await import("@/lib/ingestion/sync/playerProfileSync");
  const { getUnprofiledPlayerTags } = await import("@/lib/ingestion/repository");
  const pool = getPool();
  const tag = validTag();
  try {
    await seedStub(pool, tag);
    assert.ok((await getUnprofiledPlayerTags(pool, 1000)).includes(tag), "stub is initially selectable");

    mockProxy(502, { ok: false, error: "upstream_api_error", upstreamStatus: 404 });
    const result = await syncOnePlayerProfile(tag, "cron", null);

    assert.equal(result.outcome, "unreachable", "upstream 404 is the canonical not-found outcome");
    assert.equal(result.reason, "not_found");

    const p = await playerRow(pool, tag);
    assert.equal(Number(p.is_reachable), 0, "canonical not-found policy sets is_reachable=0");
    assert.equal(p.unreachable_reason, "not_found");

    assert.ok(!(await getUnprofiledPlayerTags(pool, 1000)).includes(tag), "the 404 tag no longer stays due / blocks the queue head");

    const run = await latestFetchRunFor(pool, tag);
    assert.equal(Number(run.http_status), 502, "proxy outer status preserved in http_status");
    assert.equal(run.error_code, "not_found", "classified not_found, NOT server_error");
    assert.match(String(run.error_message), /upstream_status=404/, "upstream 404 preserved (not lost)");
    assert.equal(run.status, "failed", "fetch run completed (not left running)");
  } finally {
    await pool.execute("DELETE FROM normalized_players WHERE player_tag = ?", [tag]).catch(() => {});
  }
});

test("db: a real proxy 502 WITHOUT an upstream 404 stays server_error and does NOT deactivate the player", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { syncOnePlayerProfile } = await import("@/lib/ingestion/sync/playerProfileSync");
  const { getUnprofiledPlayerTags } = await import("@/lib/ingestion/repository");
  const pool = getPool();
  const tag = validTag();
  try {
    await seedStub(pool, tag);

    mockProxy(502, { ok: false, error: "bad_gateway" });
    const result = await syncOnePlayerProfile(tag, "cron", null);

    assert.equal(result.outcome, "failed");
    assert.equal(result.reason, "server_error", "a genuine proxy 502 (no upstream envelope) stays server_error");

    const p = await playerRow(pool, tag);
    assert.equal(Number(p.is_reachable), 1, "a transient server error must NOT mark the player unreachable");
    assert.ok((await getUnprofiledPlayerTags(pool, 1000)).includes(tag), "the player stays selectable for retry");

    const run = await latestFetchRunFor(pool, tag);
    assert.equal(run.error_code, "server_error");
  } finally {
    await pool.execute("DELETE FROM normalized_players WHERE player_tag = ?", [tag]).catch(() => {});
  }
});

test("db: repeated upstream 404 stays unreachable (idempotent) and never re-blocks the queue", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { syncOnePlayerProfile } = await import("@/lib/ingestion/sync/playerProfileSync");
  const { getUnprofiledPlayerTags } = await import("@/lib/ingestion/repository");
  const pool = getPool();
  const tag = validTag();
  try {
    await seedStub(pool, tag);
    mockProxy(502, { ok: false, error: "upstream_api_error", upstreamStatus: 404 });

    const first = await syncOnePlayerProfile(tag, "cron", null);
    const second = await syncOnePlayerProfile(tag, "cron", null);

    assert.equal(first.outcome, "unreachable");
    assert.equal(second.outcome, "unreachable", "repeated 404 remains not_found (existing terminal policy)");
    assert.equal(second.reason, "not_found");

    assert.equal(Number((await playerRow(pool, tag)).is_reachable), 0);
    assert.ok(!(await getUnprofiledPlayerTags(pool, 1000)).includes(tag), "still excluded after repeated 404");
  } finally {
    await pool.execute("DELETE FROM normalized_players WHERE player_tag = ?", [tag]).catch(() => {});
  }
});

test("db: a valid 200 player payload still normalizes successfully and stays reachable", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { syncOnePlayerProfile } = await import("@/lib/ingestion/sync/playerProfileSync");
  const pool = getPool();
  const tag = validTag();
  try {
    await seedStub(pool, tag);

    mockProxy(200, { ok: true, status: 200, payload: { tag, name: "Real Player", nameColor: "0xffabcdef", trophies: 1234, highestTrophies: 1500, expLevel: 100 } });
    const result = await syncOnePlayerProfile(tag, "cron", null);

    assert.equal(result.outcome, "success");
    const p = await playerRow(pool, tag);
    assert.equal(Number(p.trophies), 1234, "profile normalized (trophies persisted)");
    assert.equal(Number(p.is_reachable), 1, "successful player stays reachable");
  } finally {
    await pool.execute("DELETE FROM normalized_players WHERE player_tag = ?", [tag]).catch(() => {});
  }
});
