/**
 * Phase 5 durable-batched-aggregation integration tests: interruption,
 * resume, idempotency, concurrency, and stale-run recovery for the resumable
 * aggregation state machine. Require real MySQL/MariaDB credentials
 * (DB_HOST/DB_PORT/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1); SKIP rather than
 * fabricate a pass when absent, exactly like every other *DbIntegration /
 * DB-dependent test in this repo. Written to run for real against any
 * environment migrated through 0025.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const hasDbEnv = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1
);
const skip = !hasDbEnv;
const skipReason = "No DB credentials in this environment (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";

const AGG_SLUG = "statistical-aggregation";

async function getAggDefinitionId(pool: import("mysql2/promise").Pool): Promise<string> {
  const { ensureWorkflowDefinition } = await import("@/lib/workflow");
  return ensureWorkflowDefinition(pool, AGG_SLUG, "scheduled_sync");
}

test("db: the slice path resumes across many calls and eventually completes a valid aggregation (batchSize=1 forces multiple slices)", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const pool = getPool();

  const statuses: string[] = [];
  let completed: Awaited<ReturnType<typeof stepAggregation>> | null = null;
  for (let i = 0; i < 2000; i += 1) {
    const r = await stepAggregation("manual", 1);
    statuses.push(r.status);
    if (r.status === "completed") {
      completed = r;
      break;
    }
    // lock_not_acquired should not happen in a single-caller loop; if it does, retry.
  }

  assert.ok(completed, "the slice loop must eventually reach 'completed'");
  assert.ok(statuses.includes("started"), "the first slice of a fresh job must report 'started'");
  assert.ok(statuses.filter((s) => s === "in_progress").length > 0, "a batchSize=1 run must take several in_progress slices");
  assert.ok(["succeeded", "succeeded_with_warnings"].includes(completed!.outcome as string));
  assert.ok(completed!.workflowRunId);

  // The completed run's workflow_run is fully succeeded with exactly its three scoped aggregation_runs succeeded.
  const [[wr]] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT status FROM workflow_runs WHERE id = ?",
    [completed!.workflowRunId]
  );
  assert.ok(["succeeded", "succeeded_with_warnings"].includes(wr.status));
  const [aggRuns] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT scope, status FROM aggregation_runs WHERE workflow_run_id = ?",
    [completed!.workflowRunId]
  );
  assert.equal(aggRuns.length, 3, "a completed aggregation job has exactly three scoped aggregation_runs");
  for (const row of aggRuns) assert.ok(["succeeded", "succeeded_with_warnings"].includes(row.status));
  assert.deepEqual(aggRuns.map((r) => r.scope).sort(), ["matchup", "overall", "per_mode"]);
});

test("db: an interrupted (still in-progress) aggregation is never visible to the ranking layer as the latest valid aggregation", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const { getLatestSuccessfulAggregation } = await import("@/lib/ranking/repository");
  const pool = getPool();

  // Advance exactly one slice: a fresh job that is now 'running' but far from done.
  const first = await stepAggregation("manual", 1);
  assert.equal(first.status, "started");
  const inProgressRunId = first.workflowRunId!;

  const [[wr]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT status FROM workflow_runs WHERE id = ?", [inProgressRunId]);
  assert.equal(wr.status, "running", "the just-started job must still be running");

  const latest = await getLatestSuccessfulAggregation(pool);
  assert.notEqual(latest?.workflowRunId, inProgressRunId, "ranking's precondition must never select the in-progress run");

  // Clean up: drive the interrupted job to completion so it does not linger 'running' for later tests.
  for (let i = 0; i < 2000; i += 1) {
    const r = await stepAggregation("manual", 8);
    if (r.status === "completed") break;
  }
});

test("db: a completed aggregation run contains no duplicate scope rows (per-batch set-based inserts never double-write within a run)", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runAggregation } = await import("@/lib/aggregation/sync");
  const pool = getPool();

  const result = await runAggregation("manual");
  assert.ok(["succeeded", "succeeded_with_warnings"].includes(result.outcome));
  const runId = result.workflowRunId!;

  const [[modeAgg]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT id FROM aggregation_runs WHERE workflow_run_id = ? AND scope = 'per_mode'", [runId]);
  const [dupMode] = await pool.query<import("mysql2").RowDataPacket[]>(
    `SELECT brawler_id, game_mode_id, patch_id, COUNT(*) AS c
       FROM brawler_mode_aggregates WHERE aggregation_run_id = ?
      GROUP BY brawler_id, game_mode_id, patch_id HAVING c > 1`,
    [modeAgg.id]
  );
  assert.equal(dupMode.length, 0, "no duplicate (brawler,mode,patch) within one aggregation run");
});

test("db: driver mode preserves the classic guarantee — two concurrent run-to-completion drivers, exactly one succeeds, one is lock-rejected", { skip: skip ? skipReason : false }, async () => {
  const { runAggregation } = await import("@/lib/aggregation/sync");
  const [a, b] = await Promise.all([runAggregation("manual"), runAggregation("manual")]);
  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ["lock_not_acquired", "succeeded"].sort());
});

test("db: two concurrent SLICE calls never corrupt state — each returns a valid status and no duplicate rows result", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const pool = getPool();

  const valid = new Set(["started", "in_progress", "completed", "lock_not_acquired"]);
  for (let i = 0; i < 40; i += 1) {
    const [a, b] = await Promise.all([stepAggregation("manual", 4), stepAggregation("manual", 4)]);
    assert.ok(valid.has(a.status) && valid.has(b.status), `unexpected statuses: ${a.status}, ${b.status}`);
    if (a.status === "completed" || b.status === "completed") break;
  }

  // Whatever interleaving occurred, no aggregation run may contain duplicate scope rows.
  const [dups] = await pool.query<import("mysql2").RowDataPacket[]>(
    `SELECT aggregation_run_id, brawler_id, game_mode_id, patch_id, COUNT(*) AS c
       FROM brawler_mode_aggregates
      GROUP BY aggregation_run_id, brawler_id, game_mode_id, patch_id HAVING c > 1 LIMIT 1`
  );
  assert.equal(dups.length, 0, "concurrent slices must never produce duplicate aggregate rows");
});

test("db: a stale (abandoned) in-progress aggregation run is reclaimed as failed so a fresh job can start", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { reconcileStaleWorkflowRuns } = await import("@/lib/workflow");
  const pool = getPool();

  const defId = await getAggDefinitionId(pool);
  // Simulate a process that died mid-run 30 minutes ago: a 'running' row whose
  // heartbeat (started_at, no steps) is well past the stale threshold.
  const staleRunId = randomUUID();
  await pool.execute(
    "INSERT INTO workflow_runs (id, workflow_definition_id, status, triggered_by, started_at) VALUES (?, ?, 'running', 'manual', NOW(3) - INTERVAL 30 MINUTE)",
    [staleRunId, defId]
  );

  const { reclaimedRunIds } = await reconcileStaleWorkflowRuns(pool, defId, 15 * 60);
  assert.ok(reclaimedRunIds.includes(staleRunId), "the stale run must be reclaimed");

  const [[row]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT status, error_summary FROM workflow_runs WHERE id = ?", [staleRunId]);
  assert.equal(row.status, "failed");
  assert.equal(row.error_summary, "stale_reclaimed");
});

test("db: reconcile never reclaims a FRESH in-progress run (a genuinely resuming job keeps a fresh heartbeat)", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { reconcileStaleWorkflowRuns } = await import("@/lib/workflow");
  const pool = getPool();

  const defId = await getAggDefinitionId(pool);
  const freshRunId = randomUUID();
  await pool.execute(
    "INSERT INTO workflow_runs (id, workflow_definition_id, status, triggered_by, started_at) VALUES (?, ?, 'running', 'manual', NOW(3))",
    [freshRunId, defId]
  );

  const { reclaimedRunIds } = await reconcileStaleWorkflowRuns(pool, defId, 15 * 60);
  assert.ok(!reclaimedRunIds.includes(freshRunId), "a fresh running run must not be reclaimed");

  const [[row]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT status FROM workflow_runs WHERE id = ?", [freshRunId]);
  assert.equal(row.status, "running");

  // Cleanup so this synthetic run does not confuse later resume-based tests.
  await pool.execute("UPDATE workflow_runs SET status = 'failed', completed_at = NOW(3), error_summary = 'test_cleanup' WHERE id = ?", [freshRunId]);
});
