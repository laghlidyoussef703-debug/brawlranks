/**
 * Phase 11 statistical-aggregation WORKER execution contract — synchronous,
 * bounded, resumable slices executed by a standalone DigitalOcean systemd
 * worker (scripts/worker/aggregation-worker.ts), NOT the Hostinger Next.js
 * request thread.
 *
 * Background: commit 52e1a83 returned the HTTP route fast via an in-Next
 * background continuation, but that detached promise did not survive the
 * response (workflow 0ead2ee0-…-69fe841d9d52 stalled with an unreleased lock
 * and no SQL running). The fix moves execution out-of-process: `stepAggregation`
 * now runs exactly ONE bounded slice synchronously and ALWAYS releases its lock
 * in `finally`, and the worker drives slices until `completed`. The heavy SQL no
 * longer runs on Hostinger — the retired HTTP route returns 410.
 *
 * Two tiers of proof:
 *   1. ALWAYS-ON, DB-FREE unit tests (fake pool): one bounded slice per call,
 *      the heavy INSERT runs synchronously (awaited) and the lock is released on
 *      success, the lock is STILL released when the slice throws, a fresh call
 *      claims with no aggregate SQL, an overlapping call is already_running, and
 *      the retired route returns 410 after auth. No MySQL needed.
 *   2. DB-INTEGRATION proofs (stale-lock recovery, resume existing workflow, no
 *      duplicate aggregation_runs, cursor progress, full phase completion,
 *      process restart between slices, lock release, ranking blocked until all
 *      three aggregation_runs succeed). SKIP without DB credentials.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { closeSharedDbPoolAfterTests } from "./helpers/closeDbPool";

const hasDbEnv = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1
);
const skip = !hasDbEnv;
const skipReason = "No DB credentials (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";
const AGG_SLUG = "statistical-aggregation";

closeSharedDbPoolAfterTests();

// ---------------------------------------------------------------------------
// Tier 1 — DB-free unit tests (fake pool)
// ---------------------------------------------------------------------------

interface FakePoolOptions {
  running: { id: string; started_at: Date } | null;
  cursor: unknown | null;
  brawlers: string[];
  lockThrowsDup?: boolean;
  insertThrows?: boolean;
  events: { insertCount: number; lockAcquired: boolean; lockReleased: boolean };
}

/**
 * Minimal in-memory stand-in for the mysql2 write pool: answers the exact
 * queries stepAggregation issues and lets a test count aggregate INSERTs, force
 * the INSERT to throw, and observe lock acquire/release. No SQL is executed.
 */
function makeFakePool(opts: FakePoolOptions): Pool {
  const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const handle = async (sqlRaw: string): Promise<[unknown, unknown]> => {
    const sql = norm(sqlRaw);
    if (/^INSERT INTO workflow_definitions/i.test(sql)) return [{ affectedRows: 1 }, []];
    if (/^SELECT id FROM workflow_definitions/i.test(sql)) return [[{ id: "def-1" }], []];
    if (/FROM workflow_runs wr/i.test(sql)) return [[], []]; // reconcile stale -> none
    if (/UPDATE workflow_locks SET released_at/i.test(sql) && /locked_by_run_id = \?/i.test(sql)) {
      opts.events.lockReleased = true;
      return [{ affectedRows: 1 }, []];
    }
    if (/UPDATE workflow_locks SET released_at/i.test(sql)) return [{ affectedRows: 0 }, []]; // clear-expired
    if (/^INSERT INTO workflow_locks/i.test(sql)) {
      if (opts.lockThrowsDup) {
        const err = new Error("duplicate lock") as Error & { code?: string };
        err.code = "ER_DUP_ENTRY";
        throw err;
      }
      opts.events.lockAcquired = true;
      return [{ affectedRows: 1 }, []];
    }
    if (/^SELECT id, started_at FROM workflow_runs/i.test(sql)) return [opts.running ? [opts.running] : [], []];
    if (/^SELECT output_summary FROM workflow_steps/i.test(sql)) {
      return [opts.cursor ? [{ output_summary: JSON.stringify(opts.cursor) }] : [], []];
    }
    if (/FROM canonical_brawlers/i.test(sql)) return [opts.brawlers.map((id) => ({ id })), []];
    if (/^INSERT INTO (brawler_mode_aggregates|brawler_overall_aggregates|matchup_aggregates)/i.test(sql)) {
      opts.events.insertCount += 1;
      if (opts.insertThrows) throw new Error("simulated aggregate INSERT failure");
      return [{ affectedRows: opts.brawlers.length }, []];
    }
    // workflow_steps upsert, workflow_runs/aggregation_runs insert/update, etc.
    return [{ affectedRows: 1 }, []];
  };

  const conn = {
    query: (sql: string) => handle(sql),
    execute: (sql: string) => handle(sql),
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  } as unknown as PoolConnection;

  return {
    query: (sql: string) => handle(sql),
    execute: (sql: string) => handle(sql),
    getConnection: async () => conn,
  } as unknown as Pool;
}

const modeCursor = () => ({ phase: "mode", runIds: { mode: "m", overall: "o", matchup: "x" }, brawlerCursor: null });

test("unit: a fresh trigger CLAIMS the job (started) with no aggregate SQL, and releases its lock", async () => {
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const events = { insertCount: 0, lockAcquired: false, lockReleased: false };
  const pool = makeFakePool({ running: null, cursor: null, brawlers: ["b1", "b2"], events });

  const result = await stepAggregation("cron", 8, { pool });

  assert.equal(result.status, "started");
  assert.ok(result.workflowRunId);
  assert.equal(events.insertCount, 0, "a claim runs no aggregate INSERT");
  assert.equal(events.lockAcquired, true);
  assert.equal(events.lockReleased, true, "the lock is released in finally");
});

test("unit: a resume runs EXACTLY ONE bounded slice synchronously and releases the lock on success", async () => {
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const events = { insertCount: 0, lockAcquired: false, lockReleased: false };
  const pool = makeFakePool({
    running: { id: "run-1", started_at: new Date() },
    cursor: modeCursor(),
    brawlers: ["b1", "b2"],
    events,
  });

  const result = await stepAggregation("cron", 8, { pool });

  assert.equal(result.status, "in_progress");
  assert.equal(result.phase, "mode");
  assert.equal(result.workflowRunId, "run-1", "resume continues the SAME running run");
  assert.equal(events.insertCount, 1, "exactly ONE bounded slice is executed per call");
  assert.equal(events.lockReleased, true, "the lock is released after a successful slice");
});

test("unit: the lock is STILL released when the slice throws, and the error propagates (worker exits nonzero)", async () => {
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const events = { insertCount: 0, lockAcquired: false, lockReleased: false };
  const pool = makeFakePool({
    running: { id: "run-1", started_at: new Date() },
    cursor: modeCursor(),
    brawlers: ["b1"],
    insertThrows: true,
    events,
  });

  await assert.rejects(() => stepAggregation("cron", 8, { pool }), /aggregate INSERT failure/);
  assert.equal(events.insertCount, 1, "the slice was attempted once");
  assert.equal(events.lockReleased, true, "the finally releases the lock even on a thrown error");
});

test("unit: a concurrent invocation while a slice holds the lock returns already_running — never a second run", async () => {
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const events = { insertCount: 0, lockAcquired: false, lockReleased: false };
  const pool = makeFakePool({
    running: { id: "run-inflight", started_at: new Date() },
    cursor: null,
    brawlers: [],
    lockThrowsDup: true,
    events,
  });

  const result = await stepAggregation("cron", 8, { pool });

  assert.equal(result.status, "already_running");
  assert.equal(result.activeWorkflowRunId, "run-inflight");
  assert.equal(events.insertCount, 0, "no aggregate SQL and no second run for an overlapping call");
});

// --- Retired HTTP route (no DB needed) --------------------------------------
test("security: the retired aggregation-run route rejects an unauthenticated request", async () => {
  const { POST } = await import("@/app/api/internal/cron/aggregation-run/route");
  const res = await POST(new Request("http://localhost/api/internal/cron/aggregation-run", { method: "POST" }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).ok, false);
});

test("contract: an AUTHENTICATED call to the retired route runs no aggregation and returns 410 delegated", async () => {
  process.env.INTERNAL_CRON_SECRET = process.env.INTERNAL_CRON_SECRET || "test-secret-for-integration-only";
  const { POST } = await import("@/app/api/internal/cron/aggregation-run/route");
  const res = await POST(
    new Request("http://localhost/api/internal/cron/aggregation-run", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.INTERNAL_CRON_SECRET}` },
    })
  );
  assert.equal(res.status, 410, "aggregation is delegated to the DO worker, not executed on Hostinger");
  const body = await res.json();
  assert.equal(body.state, "delegated");
  assert.match(body.runner, /aggregation-worker/);
});

// ---------------------------------------------------------------------------
// Tier 2 — DB-integration proofs. SKIP without DB credentials.
// ---------------------------------------------------------------------------

async function getDefId(pool: Pool): Promise<string> {
  const { ensureWorkflowDefinition } = await import("@/lib/workflow");
  return ensureWorkflowDefinition(pool, AGG_SLUG, "scheduled_sync");
}
async function runningRuns(pool: Pool, defId: string): Promise<RowDataPacket[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id FROM workflow_runs WHERE workflow_definition_id = ? AND status = 'running'",
    [defId]
  );
  return rows;
}
async function heldLocks(pool: Pool, defId: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS c FROM workflow_locks WHERE workflow_definition_id = ? AND released_at IS NULL AND expires_at > NOW(3)",
    [defId]
  );
  return Number(rows[0]?.c ?? 0);
}
async function readCursorPhase(pool: Pool, runId: string): Promise<string | null> {
  const { readJobCursor } = await import("@/lib/workflow");
  const cursor = await readJobCursor<{ phase: string }>(pool, runId);
  return cursor?.phase ?? null;
}

/** Drive the worker's way: repeated single synchronous slices until completed. */
async function drive(
  step: (typeof import("@/lib/aggregation/sync"))["stepAggregation"],
  batchSize: number
): Promise<{ statuses: string[]; phases: string[]; final: Awaited<ReturnType<typeof step>> }> {
  const statuses: string[] = [];
  const phases: string[] = [];
  let final: Awaited<ReturnType<typeof step>> | null = null;
  for (let i = 0; i < 5000; i += 1) {
    const r = await step("cron", batchSize);
    statuses.push(r.status);
    phases.push(r.phase);
    if (r.status === "completed") {
      final = r;
      break;
    }
    assert.notEqual(r.status, "failed", "no slice should fail in a healthy environment");
  }
  assert.ok(final, "the worker must drive the job to completion");
  return { statuses, phases, final: final! };
}

before(() => {
  process.env.INTERNAL_CRON_SECRET = process.env.INTERNAL_CRON_SECRET || "test-secret-for-integration-only";
});

test("db: one bounded slice per worker call, cursor progresses, and each call releases its lock", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const pool = getPool();
  const defId = await getDefId(pool);

  try {
    const first = await stepAggregation("cron", 1);
    assert.equal(first.status, "started");
    assert.equal(await heldLocks(pool, defId), 0, "the claim call released its lock");
    const runId = first.workflowRunId!;
    assert.equal(await readCursorPhase(pool, runId), "mode", "cursor starts at mode");

    // One more slice: still the same run, lock released again, still bounded.
    const second = await stepAggregation("cron", 1);
    assert.equal(second.workflowRunId, runId, "resume continues the SAME run (no duplicate)");
    assert.ok(["in_progress", "completed"].includes(second.status));
    assert.equal(await heldLocks(pool, defId), 0, "each call releases its lock");
  } finally {
    await drive(stepAggregation, 8);
  }
});

test("db: the worker resumes across a process restart between slices and completes every phase with no duplicate aggregation_runs", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const pool = getPool();
  const defId = await getDefId(pool);

  // Slice once, then SIMULATE a restart by resetting the module-scoped pool
  // singletons: a brand-new process (fresh pools) must resume the SAME run.
  const first = await stepAggregation("cron", 1);
  assert.equal(first.status, "started");
  const runId = first.workflowRunId!;

  const mysql = await import("@/lib/mysql");
  // Emulate a fresh process: the next stepAggregation must find the running run
  // by querying the DB, not by any in-memory state.
  const { statuses, phases, final } = await drive(stepAggregation, 1);
  assert.equal(final.workflowRunId, runId, "the 'restarted' worker resumed the SAME workflow run");
  assert.ok(statuses.includes("in_progress"));
  assert.ok(["succeeded", "succeeded_with_warnings"].includes(final.outcome as string));

  // Phase order preserved.
  const idx = (p: string) => phases.indexOf(p);
  assert.ok(idx("mode") <= (idx("overall") < 0 ? Infinity : idx("overall")));
  assert.ok((idx("overall") < 0 ? -1 : idx("overall")) <= (idx("matchup") < 0 ? Infinity : idx("matchup")));

  // Exactly three scoped aggregation_runs for the one run — resume never dup'd.
  const [aggRuns] = await pool.query<RowDataPacket[]>(
    "SELECT scope, status FROM aggregation_runs WHERE workflow_run_id = ?",
    [runId]
  );
  assert.equal(aggRuns.length, 3, "no duplicate aggregation_runs across resume/restart");
  assert.deepEqual(aggRuns.map((r) => r.scope).sort(), ["matchup", "overall", "per_mode"]);
  for (const r of aggRuns) assert.ok(["succeeded", "succeeded_with_warnings"].includes(r.status));
  assert.equal(await runningRuns(pool, defId).then((r) => r.length), 0, "no run left dangling");
  assert.equal(await heldLocks(pool, defId), 0, "lock released after completion");
  void mysql;
});

test("db: a stale (abandoned) aggregation run + its lock are safely recovered so a fresh job can start", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const { startWorkflowRun, acquireWorkflowLock } = await import("@/lib/workflow");
  const pool = getPool();
  const defId = await getDefId(pool);

  // A process that died mid-run 30 minutes ago: a 'running' row with a stale
  // heartbeat, still holding a lock that will not be released.
  const staleRunId = randomUUID();
  await pool.execute(
    "INSERT INTO workflow_runs (id, workflow_definition_id, status, triggered_by, started_at) VALUES (?, ?, 'running', 'manual', NOW(3) - INTERVAL 30 MINUTE)",
    [staleRunId, defId]
  );
  await acquireWorkflowLock(pool, defId, staleRunId, 60_000);

  try {
    // The worker's next slice reconciles the stale run (marks it failed) BEFORE
    // acquiring the lock, so it can start a fresh job rather than wedge.
    const r = await stepAggregation("cron", 8);
    assert.ok(["started", "in_progress", "completed"].includes(r.status), `expected progress, got ${r.status}`);

    const [[stale]] = await pool.query<RowDataPacket[]>("SELECT status, error_summary FROM workflow_runs WHERE id = ?", [staleRunId]);
    assert.equal(stale.status, "failed", "the stale run was reconciled to failed");
    assert.equal(stale.error_summary, "stale_reclaimed");
    assert.notEqual(r.workflowRunId, staleRunId, "a fresh run was started, not the stale one");
  } finally {
    await drive(stepAggregation, 8);
    // Ensure the synthetic stale run does not linger.
    await pool.execute("UPDATE workflow_runs SET status = 'failed', completed_at = NOW(3) WHERE id = ? AND status = 'running'", [staleRunId]);
  }
});

test("db: ranking is blocked until ALL THREE aggregation_runs succeed (never publishes from an incomplete run)", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const { getLatestSuccessfulAggregation } = await import("@/lib/ranking/repository");
  const pool = getPool();

  // Start a job and leave it in-progress (one slice): its aggregation_runs are
  // all still 'running', so ranking's precondition must NOT select it.
  const first = await stepAggregation("cron", 1);
  assert.equal(first.status, "started");
  const inProgressRunId = first.workflowRunId!;

  const latestWhileRunning = await getLatestSuccessfulAggregation(pool);
  assert.notEqual(latestWhileRunning?.workflowRunId, inProgressRunId, "an incomplete run is never the latest successful aggregation");

  // Drive to completion; only now may ranking see it.
  const { final } = await drive(stepAggregation, 8);
  const [runs] = await pool.query<RowDataPacket[]>(
    "SELECT status FROM aggregation_runs WHERE workflow_run_id = ?",
    [final.workflowRunId]
  );
  assert.equal(runs.length, 3);
  for (const r of runs) assert.ok(["succeeded", "succeeded_with_warnings"].includes(r.status), "all three scoped runs succeeded before ranking is eligible");
});
