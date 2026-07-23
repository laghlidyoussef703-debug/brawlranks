/**
 * Phase 11 statistical-aggregation cron execution contract — durable, resumable
 * slices with an INTENTIONAL, OBSERVABLE background continuation.
 *
 * Proves the fix for the production 504 + false systemd failure: the heavy
 * set-based aggregate `INSERT ... SELECT` (over the whole battle history) no
 * longer runs on the HTTP request thread. The route claims a fresh job fast
 * (`started`), hands each heavy mode/overall/matchup slice to a background
 * continuation that owns the workflow lock (`in_progress`), runs the light
 * `finalize` inline (`completed`), and returns `already_running` — HTTP 200,
 * never a second run, never a 409 — while a slice is in flight.
 *
 * Two tiers of proof:
 *   1. ALWAYS-ON, DB-FREE unit tests (fake pool + pure route mapper): the
 *      request returns before the heavy INSERT completes, the lock is held for
 *      the background slice and released after it, a fresh job claims without
 *      any aggregate SQL, an overlapping call is already_running, and the HTTP
 *      contract maps every state correctly. These need no MySQL and run in CI.
 *   2. DB-INTEGRATION proofs (req 16: initial start, resume same workflow,
 *      concurrent invocation, timeout-safe quick response, phase transitions,
 *      final completion, no duplicate aggregation_runs, lock release after
 *      success/failure). SKIP without DB credentials, exactly like every other
 *      *DbIntegration/DB-dependent test in this repo.
 */
import { test, before, after } from "node:test";
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
// Tier 1 — DB-free unit tests
// ---------------------------------------------------------------------------

interface FakePoolOptions {
  running: { id: string; started_at: Date } | null;
  cursor: unknown | null;
  brawlers: string[];
  lockThrowsDup?: boolean;
  insertGate?: Promise<void>;
  events: { insertStarted: boolean; insertCompleted: boolean; lockReleased: boolean };
}

/**
 * A minimal in-memory stand-in for the mysql2 write pool: it answers the exact
 * queries stepAggregation issues (workflow definition/lock/run/cursor lookups,
 * the active-brawler batch, and the aggregate INSERTs), and lets the test GATE
 * the heavy mode INSERT so we can observe the request returning before it
 * finishes. No SQL is actually executed.
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
      return [{ affectedRows: 1 }, []];
    }
    if (/^SELECT id, started_at FROM workflow_runs/i.test(sql)) return [opts.running ? [opts.running] : [], []];
    if (/^SELECT output_summary FROM workflow_steps/i.test(sql)) {
      return [opts.cursor ? [{ output_summary: JSON.stringify(opts.cursor) }] : [], []];
    }
    if (/FROM canonical_brawlers/i.test(sql)) return [opts.brawlers.map((id) => ({ id })), []];
    if (/^INSERT INTO brawler_mode_aggregates/i.test(sql)) {
      opts.events.insertStarted = true;
      if (opts.insertGate) await opts.insertGate;
      opts.events.insertCompleted = true;
      return [{ affectedRows: opts.brawlers.length }, []];
    }
    if (/^INSERT INTO (brawler_overall_aggregates|matchup_aggregates)/i.test(sql)) {
      if (opts.insertGate) await opts.insertGate;
      return [{ affectedRows: opts.brawlers.length }, []];
    }
    // Everything else (workflow_steps upsert, workflow_runs/aggregation_runs
    // insert/update) is an immediate no-op success.
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

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("unit: a fresh trigger CLAIMS the job and returns `started` without running any aggregate SQL", async () => {
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const events = { insertStarted: false, insertCompleted: false, lockReleased: false };
  const pool = makeFakePool({ running: null, cursor: null, brawlers: ["b1", "b2"], events });

  const started = Date.now();
  const result = await stepAggregation("cron", 8, { pool });
  const elapsed = Date.now() - started;

  assert.equal(result.status, "started");
  assert.ok(result.workflowRunId, "the claim returns the new workflowRunId");
  assert.equal(result.backgroundSlice, undefined, "a fresh claim dispatches no background slice");
  assert.equal(events.insertStarted, false, "NO aggregate INSERT runs on the claim call");
  assert.ok(elapsed < 2000, `claim returns fast (${elapsed}ms)`);
  assert.equal(events.lockReleased, true, "the claim releases the lock it briefly held");
});

test("unit: a resume of a heavy phase returns `in_progress` BEFORE the aggregate INSERT completes, then the background slice finishes and releases the lock", async () => {
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const events = { insertStarted: false, insertCompleted: false, lockReleased: false };
  let releaseGate: () => void = () => {};
  const insertGate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const cursor = { phase: "mode", runIds: { mode: "m", overall: "o", matchup: "x" }, brawlerCursor: null };
  const pool = makeFakePool({
    running: { id: "run-1", started_at: new Date() },
    cursor,
    brawlers: ["b1", "b2"],
    insertGate,
    events,
  });

  const started = Date.now();
  const result = await stepAggregation("cron", 8, { pool });
  const elapsed = Date.now() - started;

  // The request came back WITHOUT waiting for the heavy INSERT (the whole fix).
  assert.equal(result.status, "in_progress");
  assert.equal(result.phase, "mode");
  assert.equal(result.workflowRunId, "run-1", "resume continues the SAME running run");
  assert.ok(result.backgroundSlice, "a heavy slice was dispatched to the background");
  assert.equal(events.insertCompleted, false, "the response returned before the aggregate INSERT completed");
  assert.equal(events.lockReleased, false, "the lock is HELD by the background continuation, not released by the request");
  assert.ok(elapsed < 2000, `resume returns fast (${elapsed}ms), well under the ~55s gateway timeout`);

  // The background slice genuinely runs the heavy INSERT off the request thread.
  for (let i = 0; i < 10 && !events.insertStarted; i += 1) await tick();
  assert.equal(events.insertStarted, true, "the background continuation started the heavy INSERT");
  assert.equal(events.insertCompleted, false, "and it is still blocked on the gated INSERT (running in the background)");

  releaseGate();
  await result.backgroundSlice;

  assert.equal(events.insertCompleted, true, "once unblocked the background INSERT completes");
  assert.equal(events.lockReleased, true, "the background continuation ALWAYS releases the lock when done");
});

test("unit: a concurrent invocation while a slice holds the lock returns `already_running` — never a second run", async () => {
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const events = { insertStarted: false, insertCompleted: false, lockReleased: false };
  const pool = makeFakePool({
    running: { id: "run-inflight", started_at: new Date() },
    cursor: null,
    brawlers: [],
    lockThrowsDup: true, // the lock is already held -> acquire fails
    events,
  });

  const result = await stepAggregation("cron", 8, { pool });

  assert.equal(result.status, "already_running");
  assert.equal(result.activeWorkflowRunId, "run-inflight", "surfaces the in-flight run id");
  assert.equal(result.backgroundSlice, undefined, "no work is dispatched for an overlapping call");
  assert.equal(events.insertStarted, false, "an overlapping call runs no aggregate SQL and starts no second run");
});

test("unit: the HTTP contract maps every state to a fast, structured, systemd-friendly response", async () => {
  const { toAggregationHttpResponse } = await import("@/app/api/internal/cron/aggregation-run/route");

  const started = toAggregationHttpResponse({ status: "started", phase: "mode", workflowRunId: "r1" });
  assert.equal(started.httpStatus, 202);
  assert.deepEqual(started.body, { ok: true, accepted: true, state: "started", workflowRunId: "r1", phase: "mode" });

  const inProgress = toAggregationHttpResponse({ status: "in_progress", phase: "matchup", workflowRunId: "r1" });
  assert.equal(inProgress.httpStatus, 202);
  assert.equal(inProgress.body.state, "in_progress");

  // The crux of the systemd fix: an active invocation is HTTP 200, NOT 409.
  const overlap = toAggregationHttpResponse({ status: "already_running", phase: "mode", activeWorkflowRunId: "r9" });
  assert.equal(overlap.httpStatus, 200, "already_running must not be a 4xx/5xx that trips systemd --fail");
  assert.equal(overlap.body.ok, true);
  assert.equal(overlap.body.accepted, false);
  assert.equal(overlap.body.state, "already_running");
  assert.equal(overlap.body.workflowRunId, "r9");

  const completed = toAggregationHttpResponse({
    status: "completed",
    phase: "done",
    workflowRunId: "r1",
    outcome: "succeeded",
    modeAggregateCount: 3,
    overallAggregateCount: 2,
    matchupAggregateCount: 5,
    reconciliationWarnings: 0,
  });
  assert.equal(completed.httpStatus, 200);
  assert.equal(completed.body.state, "completed");
  assert.equal(completed.body.outcome, "succeeded");

  const failed = toAggregationHttpResponse({ status: "failed", phase: "mode", workflowRunId: "r1" });
  assert.equal(failed.httpStatus, 200);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.state, "failed");
});

// --- Auth (no DB needed) -----------------------------------------------------
test("security: aggregation-run rejects an unauthenticated request before touching the DB", async () => {
  const { POST } = await import("@/app/api/internal/cron/aggregation-run/route");
  const res = await POST(new Request("http://localhost/api/internal/cron/aggregation-run", { method: "POST" }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).ok, false);
});

// ---------------------------------------------------------------------------
// Tier 2 — DB-integration proofs (req 16). SKIP without DB credentials.
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

/** Drive the state machine the way the scheduler would, awaiting each background slice so a single caller makes deterministic progress. */
async function driveToCompletion(
  step: (typeof import("@/lib/aggregation/sync"))["stepAggregation"],
  batchSize: number
): Promise<{ statuses: string[]; phases: string[]; final: Awaited<ReturnType<typeof step>> }> {
  const statuses: string[] = [];
  const phases: string[] = [];
  let final: Awaited<ReturnType<typeof step>> | null = null;
  for (let i = 0; i < 5000; i += 1) {
    const r = await step("manual", batchSize);
    statuses.push(r.status);
    phases.push(r.phase);
    if (r.backgroundSlice) await r.backgroundSlice;
    if (r.status === "completed") {
      final = r;
      break;
    }
  }
  assert.ok(final, "the job must reach completion");
  return { statuses, phases, final: final! };
}

before(() => {
  process.env.INTERNAL_CRON_SECRET = process.env.INTERNAL_CRON_SECRET || "test-secret-for-integration-only";
});
after(() => {});

test("db: initial start returns `started` fast and creates exactly one workflow run", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const pool = getPool();
  const defId = await getDefId(pool);

  const startedAt = Date.now();
  const first = await stepAggregation("manual", 4);
  const elapsed = Date.now() - startedAt;
  try {
    assert.equal(first.status, "started");
    assert.ok(first.workflowRunId);
    assert.ok(elapsed < 10_000, `claim returned quickly (${elapsed}ms)`);
    assert.equal((await runningRuns(pool, defId)).length, 1, "exactly one run in flight");
  } finally {
    await driveToCompletion(stepAggregation, 8); // don't leave a 'running' run for later tests
  }
});

test("db: resume continues the SAME workflow to completion with no duplicate aggregation_runs, observing every phase transition", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const pool = getPool();

  // batchSize=1 forces many resume slices across all phases.
  const { statuses, phases, final } = await driveToCompletion(stepAggregation, 1);

  assert.equal(statuses[0], "started");
  assert.ok(statuses.includes("in_progress"), "a batchSize=1 job takes several in_progress resume slices");
  assert.equal(final.status, "completed");
  assert.ok(["succeeded", "succeeded_with_warnings"].includes(final.outcome as string));

  // Phase order is preserved: mode -> overall -> matchup -> finalize/done.
  const order = ["mode", "overall", "matchup"];
  const firstIndex = (p: string) => phases.indexOf(p);
  assert.ok(firstIndex("mode") >= 0, "mode phase observed");
  if (firstIndex("overall") >= 0) assert.ok(firstIndex("mode") <= firstIndex("overall"), "mode precedes overall");
  if (firstIndex("matchup") >= 0) assert.ok(firstIndex("overall") <= firstIndex("matchup"), "overall precedes matchup");
  void order;

  // Exactly three scoped aggregation_runs for the one run — resume never
  // created a duplicate set.
  const [aggRuns] = await pool.query<RowDataPacket[]>(
    "SELECT scope, status FROM aggregation_runs WHERE workflow_run_id = ?",
    [final.workflowRunId]
  );
  assert.equal(aggRuns.length, 3, "no duplicate aggregation_runs across resume");
  assert.deepEqual(aggRuns.map((r) => r.scope).sort(), ["matchup", "overall", "per_mode"]);
  for (const r of aggRuns) assert.ok(["succeeded", "succeeded_with_warnings"].includes(r.status));
});

test("db: final completion persists a succeeded workflow run and releases the lock", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const pool = getPool();
  const defId = await getDefId(pool);

  const { final } = await driveToCompletion(stepAggregation, 8);

  const [[wr]] = await pool.query<RowDataPacket[]>("SELECT status, completed_at FROM workflow_runs WHERE id = ?", [final.workflowRunId]);
  assert.ok(["succeeded", "succeeded_with_warnings"].includes(wr.status), "completion persisted as succeeded");
  assert.ok(wr.completed_at, "completed_at stamped");
  assert.equal((await runningRuns(pool, defId)).length, 0, "no run left dangling in 'running'");
  assert.equal(await heldLocks(pool, defId), 0, "the lock is released after success");
});

test("db: a concurrent invocation while a slice holds the lock returns already_running and never starts a second run", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const { acquireWorkflowLock, startWorkflowRun, releaseWorkflowLock } = await import("@/lib/workflow");
  const pool = getPool();
  const defId = await getDefId(pool);

  // Simulate an in-flight slice: an active run holding the per-slice lock.
  const inFlightRunId = await startWorkflowRun(pool, defId, "schedule");
  const lockRunId = randomUUID();
  const lock = await acquireWorkflowLock(pool, defId, lockRunId, 60_000);
  assert.equal(lock.acquired, true);
  try {
    const res = await stepAggregation("cron", 8);
    assert.equal(res.status, "already_running", "overlap is a safe non-error");
    assert.equal((await runningRuns(pool, defId)).length, 1, "the overlapping trigger did NOT start a second run");
  } finally {
    await releaseWorkflowLock(pool, defId, lockRunId);
    await pool.execute("UPDATE workflow_runs SET status = 'failed', completed_at = NOW(3), error_summary = 'test_cleanup' WHERE id = ?", [inFlightRunId]);
  }
});

test("db: the lock is released after a background slice FAILS (a run left in a failed state never wedges the workflow)", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const {
    ensureWorkflowDefinition,
    startWorkflowRun,
    writeJobCursor,
    completeWorkflowRun,
  } = await import("@/lib/workflow");
  const pool = getPool();
  const defId = await ensureWorkflowDefinition(pool, AGG_SLUG, "scheduled_sync");

  // Craft a 'running' run whose cursor points at non-existent aggregation_run
  // ids so the background INSERT ... SELECT fails the slice.
  const runId = await startWorkflowRun(pool, defId, "manual");
  await writeJobCursor(pool, runId, {
    phase: "mode",
    runIds: { mode: randomUUID(), overall: randomUUID(), matchup: randomUUID() },
    brawlerCursor: null,
  });
  try {
    const res = await stepAggregation("manual", 4);
    // Either the heavy slice was dispatched (in_progress) and fails in the
    // background, or (if there are no active brawlers) it advances a phase.
    if (res.backgroundSlice) await res.backgroundSlice;

    assert.equal(await heldLocks(pool, defId), 0, "the lock is released even when the background slice fails");

    const [[wr]] = await pool.query<RowDataPacket[]>("SELECT status, error_summary FROM workflow_runs WHERE id = ?", [runId]);
    // A failed slice marks the run failed (observable), so the next call starts clean.
    if (wr.status === "running") {
      // No active brawlers in this environment: the slice merely advanced a
      // phase. Drive to completion so nothing lingers.
      await driveToCompletion(stepAggregation, 8);
    } else {
      assert.equal(wr.status, "failed");
      assert.ok(wr.error_summary, "the failure is recorded in error_summary (observable)");
    }
  } finally {
    await pool.execute("UPDATE workflow_runs SET status = 'failed', completed_at = NOW(3), error_summary = COALESCE(error_summary,'test_cleanup') WHERE id = ? AND status = 'running'", [runId]);
  }
});
