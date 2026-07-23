/**
 * Phase 10 battle-log cron execution contract — durable, resumable slices.
 *
 * Proves the fix for the production 504: the battle-log cron route no longer
 * runs the whole batch synchronously (a batch of 25 live proxy round-trips ran
 * ~7m47s, past Hostinger/nginx's ~55s gateway timeout, producing a false 504
 * while the server-side work kept running — false failures + overlap risk).
 * It now advances ONE bounded slice per HTTP call via the project's existing
 * resumable job-runner (lib/workflow.ts cursor + short per-slice lock + stale
 * recovery), the same mechanism aggregation/ranking use.
 *
 * Required proofs (req 12):
 *   1. the trigger responds before the gateway timeout (the claim call returns
 *      `started` immediately, doing NO long per-player work);
 *   2. one workflow starts;
 *   3. a duplicate trigger while a slice is in flight does not overlap;
 *   4. eventual workflow completion is still persisted;
 *   5. a per-player fetch failure is persisted correctly (and never wedges the run);
 *   6. authentication remains enforced.
 *
 * globalThis.fetch is mocked, so NO real proxy/network call is made. The
 * DB-backed cases SKIP without DB credentials; the auth case always runs.
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
const skipReason = "No DB credentials (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";
const WORKFLOW_SLUG = "battle-log-crawl";

closeSharedDbPoolAfterTests();

const TAG_CHARS = "0289PYLQGRJCUV";
function validTag(): string {
  let t = "#";
  for (let i = 0; i < 9; i += 1) t += TAG_CHARS[Math.floor(Math.random() * TAG_CHARS.length)];
  return t;
}

/** Mock the proxy: an empty-but-valid battle-log envelope (success, zero battles) or a failing HTTP status. */
let realFetch: typeof globalThis.fetch | undefined;
function mockBattleLog(status: number, items: unknown[] | null): void {
  const body = items === null ? { ok: false, error: "bad_gateway" } : { ok: true, status, fetchedAt: new Date().toISOString(), payload: { items } };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch;
}

async function ensurePrereqs(pool: Pool): Promise<void> {
  const { getDataSourceByName, getSourceEndpoint } = await import("@/lib/catalog/repository");
  let ds = await getDataSourceByName(pool, "official-brawl-stars-api");
  if (!ds) {
    const id = randomUUID();
    await pool.execute("INSERT INTO data_sources (id, name, source_type, is_enabled) VALUES (?, 'official-brawl-stars-api', 'official_api', 1)", [id]);
    ds = await getDataSourceByName(pool, "official-brawl-stars-api");
  }
  if (!(await getSourceEndpoint(pool, ds!.id, "battle_log"))) {
    await pool.execute(
      "INSERT INTO source_endpoints (id, data_source_id, endpoint_category, path, method, schema_version, is_enabled) VALUES (?, ?, 'battle_log', '/v1/players/{tag}/battlelog', 'GET', 'v1', 1)",
      [randomUUID(), ds!.id]
    );
  }
  const [[budget]] = await pool.query<RowDataPacket[]>("SELECT id FROM ingestion_rate_budgets WHERE budget_scope='battle_log'");
  if (!budget) {
    await pool.execute("INSERT INTO ingestion_rate_budgets (id, budget_scope, window_seconds, request_ceiling) VALUES (?, 'battle_log', 86400, 1000000)", [randomUUID()]);
  }
}

async function seedDuePlayer(pool: Pool, tag: string): Promise<void> {
  const { ensureCrawlScheduleEntry } = await import("@/lib/ingestion/repository");
  await ensureCrawlScheduleEntry(pool, { tag, region: "global", trophyBracket: "high", stratumSource: "seed", priorityScore: 1 });
}

async function runningRuns(pool: Pool, defId: string): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id, status FROM workflow_runs WHERE workflow_definition_id = ? AND status = 'running'",
    [defId]
  );
  return rows;
}

async function getDefId(pool: Pool): Promise<string> {
  const { ensureWorkflowDefinition } = await import("@/lib/workflow");
  return ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
}

/**
 * FK-safe teardown so no run/lease leaks across tests (a leaked 'running' run
 * would be resumed by findLatestRunningRun and pollute the next test). Runs on
 * ONE connection with FK checks off — this is a disposable test DB.
 */
async function cleanup(pool: Pool, defId: string): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    await conn.query("DELETE ws FROM workflow_steps ws JOIN workflow_runs r ON ws.workflow_run_id = r.id WHERE r.workflow_definition_id = ?", [defId]);
    await conn.query("DELETE f FROM data_fetch_runs f JOIN workflow_runs r ON f.workflow_run_id = r.id WHERE r.workflow_definition_id = ?", [defId]);
    await conn.query("DELETE FROM workflow_locks WHERE workflow_definition_id = ?", [defId]);
    await conn.query("DELETE FROM workflow_runs WHERE workflow_definition_id = ?", [defId]);
    await conn.query("DELETE FROM player_crawl_schedule");
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  } finally {
    conn.release();
  }
}

before(async () => {
  process.env.INTERNAL_CRON_SECRET = process.env.INTERNAL_CRON_SECRET || "test-secret-for-integration-only";
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

// --- Proof 6: authentication is enforced (no DB needed) ---------------------
test("security: battle-log-crawl-batch rejects an unauthenticated request", async () => {
  const { POST } = await import("@/app/api/internal/cron/battle-log-crawl-batch/route");
  const res = await POST(new Request("http://localhost/api/internal/cron/battle-log-crawl-batch", { method: "POST" }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).ok, false);
});

// --- Proofs 1 & 2: the trigger returns `started` immediately; one run starts -
test("db: first trigger claims the job and returns `started` fast, starting exactly one workflow", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { POST } = await import("@/app/api/internal/cron/battle-log-crawl-batch/route");
  const pool = getPool();
  const defId = await getDefId(pool);
  try {
    await seedDuePlayer(pool, validTag());
    mockBattleLog(200, []);

    const startedAt = Date.now();
    const res = await POST(
      new Request("http://localhost/api/internal/cron/battle-log-crawl-batch", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.INTERNAL_CRON_SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({ batchSize: 25 }),
      })
    );
    const elapsedMs = Date.now() - startedAt;
    const body = await res.json();

    assert.equal(res.status, 202, "claim returns 202 Accepted, not a slow 200");
    assert.equal(body.state, "started");
    assert.equal(body.accepted, true);
    assert.ok(body.workflowRunId, "returns the workflowRunId");
    // The claim call must NOT do the long per-player crawl — it returns well
    // under the ~55s gateway timeout no matter how large batchSize is.
    assert.ok(elapsedMs < 10_000, `claim returned quickly (${elapsedMs}ms), before any gateway timeout`);
    assert.ok(!body.playersProcessed, "no players are crawled on the claim call");

    const running = await runningRuns(pool, defId);
    assert.equal(running.length, 1, "exactly one workflow run is now in flight");
    assert.equal(running[0].id, body.workflowRunId);
  } finally {
    await cleanup(pool, defId);
  }
});

// --- Proof 3: a duplicate trigger while a slice holds the lock does not overlap
test("db: a duplicate trigger while a slice is in flight returns already_running, never a second run", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { acquireWorkflowLock, startWorkflowRun } = await import("@/lib/workflow");
  const { POST } = await import("@/app/api/internal/cron/battle-log-crawl-batch/route");
  const pool = getPool();
  const defId = await getDefId(pool);
  try {
    // Simulate an in-flight slice: an active run holding the per-slice lock.
    const inFlightRunId = await startWorkflowRun(pool, defId, "schedule");
    const lock = await acquireWorkflowLock(pool, defId, inFlightRunId, 60_000);
    assert.equal(lock.acquired, true);

    const res = await POST(
      new Request("http://localhost/api/internal/cron/battle-log-crawl-batch", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.INTERNAL_CRON_SECRET}` },
      })
    );
    const body = await res.json();

    assert.equal(res.status, 200, "overlap is a safe non-error, not a 5xx/504");
    assert.equal(body.state, "already_running");
    assert.equal(body.accepted, false);

    const running = await runningRuns(pool, defId);
    assert.equal(running.length, 1, "the overlapping trigger did NOT start a second run");
    assert.equal(running[0].id, inFlightRunId);
  } finally {
    await cleanup(pool, defId);
  }
});

// --- Proof 4: eventual completion is persisted -------------------------------
test("db: stepping repeatedly drains the queue and persists a completed workflow run", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepBattleLogCrawl } = await import("@/lib/ingestion/sync/battleLogCrawlSync");
  const pool = getPool();
  const defId = await getDefId(pool);
  try {
    await seedDuePlayer(pool, validTag());
    await seedDuePlayer(pool, validTag());
    await seedDuePlayer(pool, validTag());
    mockBattleLog(200, []); // valid empty battle logs -> per-player success

    // Drive the state machine the way the scheduler would: repeated short calls.
    let last;
    let workflowRunId: string | undefined;
    for (let i = 0; i < 50; i += 1) {
      last = await stepBattleLogCrawl("cron", 3);
      workflowRunId ??= last.workflowRunId;
      if (last.status === "completed") break;
      assert.notEqual(last.status, "lock_not_acquired", "sequential slices never collide on the lock");
    }
    assert.equal(last!.status, "completed", "the job reaches completion across slices");

    const [[run]] = await pool.query<RowDataPacket[]>(
      "SELECT status, completed_at, error_summary FROM workflow_runs WHERE id = ?",
      [workflowRunId]
    );
    assert.equal(run.status, "succeeded", "completion is persisted as succeeded");
    assert.ok(run.completed_at, "completed_at is stamped");
    assert.equal(run.error_summary, null);
    assert.equal((await runningRuns(pool, defId)).length, 0, "no run is left dangling in 'running'");
  } finally {
    await cleanup(pool, defId);
  }
});

// --- Proof 5: a per-player fetch failure is persisted, run still completes ---
test("db: a per-player proxy failure is persisted (failed fetch run + backoff) and the workflow still completes", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runBattleLogCrawlBatch } = await import("@/lib/ingestion/sync/battleLogCrawlSync");
  const pool = getPool();
  const defId = await getDefId(pool);
  const tag = validTag();
  try {
    await seedDuePlayer(pool, tag);
    mockBattleLog(500, null); // bare proxy 500 -> server_error, retryable

    const result = await runBattleLogCrawlBatch("cron", 3);
    assert.ok(result.outcome === "succeeded" || result.outcome === "succeeded_with_warnings", "a per-player failure does not fail the whole run");

    // The failure is durably recorded on the fetch run...
    const [[fr]] = await pool.query<RowDataPacket[]>(
      "SELECT status, http_status, error_code FROM data_fetch_runs WHERE request_context LIKE ? ORDER BY created_at DESC LIMIT 1",
      [`%${tag}%`]
    );
    assert.equal(fr.status, "failed");
    assert.equal(Number(fr.http_status), 500);
    assert.equal(fr.error_code, "server_error");

    // ...and the schedule row is backed off (retryable failure), not lost.
    const [[sched]] = await pool.query<RowDataPacket[]>(
      "SELECT consecutive_failure_count, backoff_until FROM player_crawl_schedule WHERE player_tag = ?",
      [tag]
    );
    assert.equal(Number(sched.consecutive_failure_count), 1, "the failure is counted");
    assert.ok(sched.backoff_until, "a retryable failure sets a backoff so the tag is retried later, not immediately");

    // The workflow run is completed, never left 'running'.
    assert.equal((await runningRuns(pool, defId)).length, 0);
  } finally {
    await cleanup(pool, defId);
  }
});
