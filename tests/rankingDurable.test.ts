/**
 * Phase 11 ranking-rebuild WORKER execution contract — the ranking rebuild is
 * driven to completion by a standalone DigitalOcean systemd worker
 * (scripts/worker/ranking-worker.ts), NOT the Hostinger Next.js request thread.
 *
 * Background: the Hostinger HTTP route only ever advanced ONE bounded slice of
 * the resumable ranking state machine per call. Triggered once it did only the
 * fresh-start CLAIM slice (status=started, phase=brawlers, brawlerCursor=null)
 * and returned — NOTHING drove the remaining slices, so the workflow stalled
 * 'running' with brawlers_evaluated=NULL (workflowRunId=c789b82c-…,
 * rankingRunId=c15fc8bd-…). The fix drives `stepRankingRebuild` slice-by-slice
 * from the worker until `completed`; the retired HTTP route returns 410.
 *
 * Two tiers of proof:
 *   1. ALWAYS-ON, DB-FREE unit tests (fake pool / fake stepper): the worker's
 *      drive loop maps slice statuses to exit codes (completed/lock→0,
 *      throw→nonzero, cap→nonzero); one bounded slice per `stepRankingRebuild`
 *      call runs exactly one candidate write and releases its lock (even on a
 *      thrown slice); a fresh call CLAIMS with no candidate write; an
 *      overlapping call is lock_not_acquired; a stale run is reconciled through
 *      the engine before a fresh claim; and the retired route returns 410. No
 *      MySQL needed.
 *   2. DB-INTEGRATION proofs (full drive to completion, resume across a process
 *      restart between slices with append-only ranking_runs, stale-run
 *      reclamation). SKIP without DB credentials.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { RankingStepResult } from "@/lib/ranking/sync";
import { closeSharedDbPoolAfterTests } from "./helpers/closeDbPool";

const hasDbEnv = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1
);
const skip = !hasDbEnv;
const skipReason = "No DB credentials (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";
const RANKING_SLUG = "ranking-rebuild";

closeSharedDbPoolAfterTests();

// ---------------------------------------------------------------------------
// Tier 1a — worker drive-loop exit-code contract (fake stepper, no DB)
// ---------------------------------------------------------------------------

const okStep = (over: Partial<RankingStepResult>): RankingStepResult => ({
  status: "in_progress",
  phase: "brawlers",
  ...over,
});

test("worker: the drive loop returns exit 0 when the workflow reaches completed", async () => {
  const { driveRankingToCompletion } = await import("@/scripts/worker/ranking-worker");
  const seq: RankingStepResult[] = [
    okStep({ status: "started", phase: "brawlers" }),
    okStep({ status: "in_progress", phase: "matchups" }),
    okStep({ status: "in_progress", phase: "finalize" }),
    okStep({ status: "completed", phase: "done", outcome: "published", brawlersPublished: 42 }),
  ];
  let i = 0;
  const code = await driveRankingToCompletion(async () => seq[i++], { batchSize: 8, maxSlices: 100, pauseMs: 0, log: () => {} });
  assert.equal(code, 0, "completed -> exit 0");
  assert.equal(i, seq.length, "the driver stopped exactly at completed");
});

test("worker: the drive loop returns exit 0 (safe no-op) when another worker holds the lock", async () => {
  const { driveRankingToCompletion } = await import("@/scripts/worker/ranking-worker");
  const code = await driveRankingToCompletion(
    async () => okStep({ status: "lock_not_acquired", phase: "brawlers", activeWorkflowRunId: "run-other" }),
    { batchSize: 8, maxSlices: 100, pauseMs: 0, log: () => {} }
  );
  assert.equal(code, 0, "lock_not_acquired is a safe no-op -> exit 0, never a second run");
});

test("worker: a real (thrown) slice failure propagates so the process exits nonzero", async () => {
  const { driveRankingToCompletion } = await import("@/scripts/worker/ranking-worker");
  await assert.rejects(
    () =>
      driveRankingToCompletion(
        async () => {
          throw new Error("simulated slice failure");
        },
        { batchSize: 8, maxSlices: 100, pauseMs: 0, log: () => {} }
      ),
    /simulated slice failure/,
    "a thrown slice must reject out of the driver (top-level catch exits 1)"
  );
});

test("worker: the drive loop returns nonzero if it never converges within maxSlices", async () => {
  const { driveRankingToCompletion } = await import("@/scripts/worker/ranking-worker");
  const code = await driveRankingToCompletion(async () => okStep({ status: "in_progress", phase: "brawlers" }), {
    batchSize: 8,
    maxSlices: 5,
    pauseMs: 0,
    log: () => {},
  });
  assert.equal(code, 1, "exhausting the driver cap without completing is a real failure -> exit 1");
});

// ---------------------------------------------------------------------------
// Tier 1b — stepRankingRebuild single-slice contract (fake pool, no DB)
// ---------------------------------------------------------------------------

interface FakePoolOptions {
  running: { id: string; started_at: Date } | null;
  cursor: unknown | null;
  brawlers: string[];
  staleRunIds?: string[];
  lockThrowsDup?: boolean;
  insertThrows?: boolean;
  events: {
    candidateInserts: number;
    reconcileUpdates: number;
    lockAcquired: boolean;
    lockReleased: boolean;
  };
}

/**
 * Minimal in-memory stand-in for the mysql2 write pool: answers the exact
 * queries stepRankingRebuild issues and lets a test count candidate INSERTs and
 * stale reconciliations, force the candidate INSERT to throw, and observe lock
 * acquire/release. No SQL is executed.
 */
function makeFakePool(opts: FakePoolOptions): Pool {
  const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();
  const handle = async (sqlRaw: string): Promise<[unknown, unknown]> => {
    const sql = norm(sqlRaw);

    // --- workflow_definitions -------------------------------------------------
    if (/^INSERT INTO workflow_definitions/i.test(sql)) return [{ affectedRows: 1 }, []];
    if (/^SELECT id FROM workflow_definitions/i.test(sql)) return [[{ id: "def-1" }], []];

    // --- aggregation precondition (getLatestSuccessfulAggregation) ------------
    // Checked before the reconcile `FROM workflow_runs wr` branch below.
    if (/JOIN workflow_definitions wd/i.test(sql) && /statistical-aggregation/i.test(sql)) {
      return [[{ workflowRunId: "agg-wr-1" }], []];
    }
    if (/FROM aggregation_runs WHERE workflow_run_id/i.test(sql)) {
      return [
        [
          { id: "agg-mode", scope: "per_mode" },
          { id: "agg-overall", scope: "overall" },
          { id: "agg-matchup", scope: "matchup" },
        ],
        [],
      ];
    }

    // --- stale reconciliation -------------------------------------------------
    if (/FROM workflow_runs wr/i.test(sql) && /COALESCE/i.test(sql)) {
      return [(opts.staleRunIds ?? []).map((id) => ({ id })), []];
    }
    if (/^UPDATE workflow_runs SET status = 'failed'/i.test(sql) && /stale_reclaimed/i.test(sql)) {
      opts.events.reconcileUpdates += 1;
      return [{ affectedRows: 1 }, []];
    }

    // --- locks ----------------------------------------------------------------
    if (/^UPDATE workflow_locks SET released_at/i.test(sql) && /locked_by_run_id = \?/i.test(sql)) {
      opts.events.lockReleased = true;
      return [{ affectedRows: 1 }, []];
    }
    if (/^UPDATE workflow_locks SET released_at/i.test(sql)) return [{ affectedRows: 0 }, []]; // clear-expired
    if (/^INSERT INTO workflow_locks/i.test(sql)) {
      if (opts.lockThrowsDup) {
        const err = new Error("duplicate lock") as Error & { code?: string };
        err.code = "ER_DUP_ENTRY";
        throw err;
      }
      opts.events.lockAcquired = true;
      return [{ affectedRows: 1 }, []];
    }

    // --- runs / cursor --------------------------------------------------------
    if (/^SELECT id, started_at FROM workflow_runs/i.test(sql)) return [opts.running ? [opts.running] : [], []];
    if (/^SELECT output_summary FROM workflow_steps/i.test(sql)) {
      return [opts.cursor ? [{ output_summary: JSON.stringify(opts.cursor) }] : [], []];
    }

    // --- ranking rule set + active patch --------------------------------------
    if (/FROM ranking_rule_sets/i.test(sql)) return [[{ id: "rs-1" }], []];
    if (/FROM ranking_rule_weights/i.test(sql)) return [[], []];
    if (/FROM tier_thresholds/i.test(sql)) {
      return [[{ mode_scope: null, s_cutoff: 0.9, a_cutoff: 0.7, b_cutoff: 0.5, c_cutoff: 0.3 }], []];
    }
    if (/FROM patches WHERE status = 'active'/i.test(sql)) return [[], []];

    // --- brawlers + raw participation ----------------------------------------
    if (/FROM canonical_brawlers/i.test(sql)) return [opts.brawlers.map((id) => ({ id })), []];
    if (/FROM battle_participants bp/i.test(sql)) return [[], []]; // getRawParticipationRows

    // --- candidate writes -----------------------------------------------------
    if (/^INSERT INTO ranking_results/i.test(sql)) {
      opts.events.candidateInserts += 1;
      if (opts.insertThrows) throw new Error("simulated ranking_results INSERT failure");
      return [{ affectedRows: 1 }, []];
    }

    // workflow_steps upsert, workflow_runs/ranking_runs insert/update, etc.
    if (/^SELECT/i.test(sql)) return [[], []];
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

const brawlersCursor = () => ({
  phase: "brawlers",
  rankingRunId: "rr-1",
  aggIds: { mode: "agg-mode", overall: "agg-overall", matchup: "agg-matchup" },
  ruleSetId: "rs-1",
  patchId: null,
  patchVersionLabel: null,
  nowIso: new Date().toISOString(),
  brawlerCursor: null,
});

test("unit: a fresh trigger CLAIMS the job (started) with no candidate write, and releases its lock", async () => {
  const { stepRankingRebuild } = await import("@/lib/ranking/sync");
  const events = { candidateInserts: 0, reconcileUpdates: 0, lockAcquired: false, lockReleased: false };
  const pool = makeFakePool({ running: null, cursor: null, brawlers: ["b1", "b2"], events });

  const result = await stepRankingRebuild("cron", 8, { pool });

  assert.equal(result.status, "started");
  assert.equal(result.phase, "brawlers");
  assert.ok(result.workflowRunId);
  assert.ok(result.rankingRunId);
  assert.equal(events.candidateInserts, 0, "a claim writes no ranking_results");
  assert.equal(events.lockAcquired, true);
  assert.equal(events.lockReleased, true, "the lock is released in finally");
});

test("unit: a resume runs EXACTLY ONE bounded slice synchronously and releases the lock on success", async () => {
  const { stepRankingRebuild } = await import("@/lib/ranking/sync");
  const events = { candidateInserts: 0, reconcileUpdates: 0, lockAcquired: false, lockReleased: false };
  const pool = makeFakePool({
    running: { id: "run-1", started_at: new Date() },
    cursor: brawlersCursor(),
    brawlers: ["b1"],
    events,
  });

  const result = await stepRankingRebuild("cron", 8, { pool });

  assert.equal(result.status, "in_progress");
  assert.equal(result.phase, "brawlers");
  assert.equal(result.workflowRunId, "run-1", "resume continues the SAME running run");
  assert.equal(events.candidateInserts, 1, "exactly ONE brawler's overall candidate row is written for a one-brawler batch");
  assert.equal(events.lockReleased, true, "the lock is released after a successful slice");
});

test("unit: the lock is STILL released when the slice throws, and the error propagates (worker exits nonzero)", async () => {
  const { stepRankingRebuild } = await import("@/lib/ranking/sync");
  const events = { candidateInserts: 0, reconcileUpdates: 0, lockAcquired: false, lockReleased: false };
  const pool = makeFakePool({
    running: { id: "run-1", started_at: new Date() },
    cursor: brawlersCursor(),
    brawlers: ["b1"],
    insertThrows: true,
    events,
  });

  await assert.rejects(() => stepRankingRebuild("cron", 8, { pool }), /ranking_results INSERT failure/);
  assert.equal(events.candidateInserts, 1, "the slice was attempted once");
  assert.equal(events.lockReleased, true, "the finally releases the lock even on a thrown error");
});

test("unit: a concurrent invocation while a slice holds the lock returns lock_not_acquired — never a second run", async () => {
  const { stepRankingRebuild } = await import("@/lib/ranking/sync");
  const events = { candidateInserts: 0, reconcileUpdates: 0, lockAcquired: false, lockReleased: false };
  const pool = makeFakePool({
    running: { id: "run-inflight", started_at: new Date() },
    cursor: null,
    brawlers: [],
    lockThrowsDup: true,
    events,
  });

  const result = await stepRankingRebuild("cron", 8, { pool });

  assert.equal(result.status, "lock_not_acquired");
  assert.equal(result.activeWorkflowRunId, "run-inflight");
  assert.equal(events.candidateInserts, 0, "no candidate SQL and no second run for an overlapping call");
  assert.equal(events.lockReleased, false, "a lock that was never acquired is not released");
});

test("unit: a stale abandoned run is reconciled THROUGH the engine (never manually deleted) before a fresh claim", async () => {
  const { stepRankingRebuild } = await import("@/lib/ranking/sync");
  const events = { candidateInserts: 0, reconcileUpdates: 0, lockAcquired: false, lockReleased: false };
  // A stale 'running' run exists; after reconciliation marks it failed there is
  // no running run, so the same call proceeds to a fresh claim.
  const pool = makeFakePool({ running: null, cursor: null, brawlers: ["b1"], staleRunIds: ["stale-run-1"], events });

  const result = await stepRankingRebuild("cron", 8, { pool });

  assert.equal(events.reconcileUpdates, 1, "the stale run was reconciled to 'failed' via the engine's UPDATE (no manual delete)");
  assert.equal(result.status, "started", "with the stale run cleared, a fresh job claims cleanly");
  assert.equal(events.lockReleased, true);
});

// --- Retired HTTP route (no DB needed) --------------------------------------
test("security: the retired ranking-rebuild route rejects an unauthenticated request", async () => {
  const { POST } = await import("@/app/api/internal/cron/ranking-rebuild/route");
  const res = await POST(new Request("http://localhost/api/internal/cron/ranking-rebuild", { method: "POST" }));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).ok, false);
});

test("contract: an AUTHENTICATED call to the retired route runs no ranking and returns 410 delegated", async () => {
  process.env.INTERNAL_CRON_SECRET = process.env.INTERNAL_CRON_SECRET || "test-secret-for-integration-only";
  const { POST } = await import("@/app/api/internal/cron/ranking-rebuild/route");
  const res = await POST(
    new Request("http://localhost/api/internal/cron/ranking-rebuild", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.INTERNAL_CRON_SECRET}` },
    })
  );
  assert.equal(res.status, 410, "ranking is delegated to the DO worker, not executed on Hostinger");
  const body = await res.json();
  assert.equal(body.state, "delegated");
  assert.match(body.runner, /ranking-worker/);
});

// ---------------------------------------------------------------------------
// Tier 2 — DB-integration proofs. SKIP without DB credentials.
// ---------------------------------------------------------------------------

const VALID_OUTCOMES = ["published", "held_mass_movement", "no_significant_change", "no_valid_aggregation", "no_active_rule_set"];

async function getDefId(pool: Pool): Promise<string> {
  const { ensureWorkflowDefinition } = await import("@/lib/workflow");
  return ensureWorkflowDefinition(pool, RANKING_SLUG, "scheduled_sync");
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
async function driveAggregationToCompletion(): Promise<void> {
  const { runAggregation } = await import("@/lib/aggregation/sync");
  await runAggregation("manual").catch(() => {});
}

/** Drive the worker's way: repeated single synchronous slices until completed. */
async function drive(): Promise<{ statuses: string[]; phases: string[]; final: RankingStepResult }> {
  const { driveRankingToCompletion } = await import("@/scripts/worker/ranking-worker");
  const { stepRankingRebuild } = await import("@/lib/ranking/sync");
  const statuses: string[] = [];
  const phases: string[] = [];
  let final: RankingStepResult | null = null;
  const code = await driveRankingToCompletion(
    async (t, n) => {
      const r = await stepRankingRebuild(t, n);
      statuses.push(r.status);
      phases.push(r.phase);
      if (r.status === "completed") final = r;
      return r;
    },
    { batchSize: 8, maxSlices: 5000, pauseMs: 0, log: () => {} }
  );
  assert.equal(code, 0, "the worker driver must exit 0 on completion");
  assert.ok(final, "the worker must drive the job to completion");
  return { statuses, phases, final: final! };
}

before(() => {
  process.env.INTERNAL_CRON_SECRET = process.env.INTERNAL_CRON_SECRET || "test-secret-for-integration-only";
});

test("db: the worker drives ranking to completion with a well-formed outcome and exit 0", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();
  const defId = await getDefId(pool);

  await driveAggregationToCompletion();
  const { statuses, final } = await drive();

  assert.ok(VALID_OUTCOMES.includes(final.outcome as string), `unexpected outcome: ${final.outcome}`);
  if (final.outcome !== "no_valid_aggregation" && final.outcome !== "no_active_rule_set") {
    assert.ok(statuses.filter((s) => s === "in_progress").length > 0, "a real ranking rebuild takes several in_progress slices");
  }
  assert.equal(await runningRuns(pool, defId).then((r) => r.length), 0, "no run left dangling");
  assert.equal(await heldLocks(pool, defId), 0, "lock released after completion");
});

test("db: the worker resumes across a process restart between slices, with append-only ranking_runs", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepRankingRebuild } = await import("@/lib/ranking/sync");
  const pool = getPool();
  const defId = await getDefId(pool);

  await driveAggregationToCompletion();

  // One slice, then simulate a restart by driving the rest via fresh calls: a
  // resuming worker must find the running run in the DB (not in-memory) and
  // continue the SAME workflow run to completion.
  const first = await stepRankingRebuild("cron", 1);
  if (first.status === "completed") {
    // A no-op branch (no valid aggregation / no change) can complete on the
    // first slice; nothing to resume, but the invariant still holds.
    assert.ok(VALID_OUTCOMES.includes(first.outcome as string));
    return;
  }
  assert.equal(first.status, "started");
  const runId = first.workflowRunId!;

  const { final } = await drive();
  assert.equal(final.workflowRunId, runId, "the 'restarted' worker resumed the SAME workflow run (no duplicate)");

  if (final.rankingRunId) {
    const [rows] = await pool.query<RowDataPacket[]>("SELECT id FROM ranking_runs WHERE id = ?", [final.rankingRunId]);
    assert.equal(rows.length, 1, "the ranking_runs row is append-only and independently queryable");
  }
  assert.equal(await runningRuns(pool, defId).then((r) => r.length), 0, "no run left dangling");
  assert.equal(await heldLocks(pool, defId), 0, "lock released after completion");
});

test("db: a stale (abandoned) ranking run + its lock are safely recovered so the worker can start a fresh job", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepRankingRebuild } = await import("@/lib/ranking/sync");
  const { acquireWorkflowLock } = await import("@/lib/workflow");
  const pool = getPool();
  const defId = await getDefId(pool);

  await driveAggregationToCompletion();

  // A process that died mid-run 30 minutes ago: a 'running' row with a stale
  // heartbeat, still holding a lock that will not be released — exactly the
  // observed stuck state (workflowRunId=c789b82c-…). The worker reconciles it
  // through the engine; nothing deletes the row or the lock by hand.
  const staleRunId = randomUUID();
  await pool.execute(
    "INSERT INTO workflow_runs (id, workflow_definition_id, status, triggered_by, started_at) VALUES (?, ?, 'running', 'manual', NOW(3) - INTERVAL 30 MINUTE)",
    [staleRunId, defId]
  );
  await acquireWorkflowLock(pool, defId, staleRunId, 60_000);

  try {
    const r = await stepRankingRebuild("cron", 8);
    assert.ok(["started", "in_progress", "completed"].includes(r.status), `expected progress, got ${r.status}`);

    const [[stale]] = await pool.query<RowDataPacket[]>("SELECT status, error_summary FROM workflow_runs WHERE id = ?", [staleRunId]);
    assert.equal(stale.status, "failed", "the stale run was reconciled to failed");
    assert.equal(stale.error_summary, "stale_reclaimed");
    assert.notEqual(r.workflowRunId, staleRunId, "a fresh run was started, not the stale one");
  } finally {
    await drive();
    await pool.execute("UPDATE workflow_runs SET status = 'failed', completed_at = NOW(3) WHERE id = ? AND status = 'running'", [staleRunId]);
  }
});
