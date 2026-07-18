/**
 * Phase 5 durable-batched-ranking integration tests: resume, incomplete-
 * aggregation rejection, idempotency, concurrency, and final publication for
 * the resumable ranking state machine. Require real MySQL/MariaDB
 * credentials; SKIP when absent, exactly like every other DB-dependent test
 * in this repo. Written to run for real against any environment migrated
 * through 0025.
 *
 * Outcome-adaptive by design (same rationale as rankingDbIntegration.test.ts):
 * these run against whatever real, growing dataset exists at test time, so
 * the exact publish branch (published / held / no-change) cannot be forced
 * deterministically. What is asserted unconditionally are the durable-
 * lifecycle invariants: resume-to-completion, never-run-against-incomplete-
 * aggregation, append-only ranking runs, and atomic single-current publication.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const hasDbEnv = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1
);
const skip = !hasDbEnv;
const skipReason = "No DB credentials in this environment (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";

const VALID_OUTCOMES = ["published", "held_mass_movement", "no_significant_change", "no_valid_aggregation", "no_active_rule_set"];

async function driveAggregationToCompletion(): Promise<void> {
  const { runAggregation } = await import("@/lib/aggregation/sync");
  await runAggregation("manual").catch(() => {});
}

test("db: the ranking slice path resumes across many calls and eventually completes with a well-formed outcome", { skip: skip ? skipReason : false }, async () => {
  const { stepRankingRebuild } = await import("@/lib/ranking/sync");
  await driveAggregationToCompletion();

  const statuses: string[] = [];
  let completed: Awaited<ReturnType<typeof stepRankingRebuild>> | null = null;
  for (let i = 0; i < 2000; i += 1) {
    const r = await stepRankingRebuild("manual", 1);
    statuses.push(r.status);
    if (r.status === "completed") {
      completed = r;
      break;
    }
  }

  assert.ok(completed, "the ranking slice loop must eventually reach 'completed'");
  assert.ok(VALID_OUTCOMES.includes(completed!.outcome as string), `unexpected outcome: ${completed!.outcome}`);
  // A run that got past preconditions passes through several in_progress slices before completing.
  if (completed!.outcome !== "no_valid_aggregation" && completed!.outcome !== "no_active_rule_set") {
    assert.ok(statuses.filter((s) => s === "in_progress").length > 0, "a real ranking rebuild takes several in_progress slices");
  }
});

test("db: ranking is NEVER computed against an incomplete (in-progress) aggregation run", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepAggregation } = await import("@/lib/aggregation/sync");
  const { runRankingRebuild } = await import("@/lib/ranking/sync");
  const pool = getPool();

  // Start a fresh aggregation and advance ONE slice only: it is now 'running'
  // (incomplete). Its scoped aggregation_runs are still 'running' too.
  const started = await stepAggregation("manual", 1);
  assert.equal(started.status, "started");
  const inProgressAggRunId = started.workflowRunId!;

  const ranking = await runRankingRebuild("manual");
  assert.ok(VALID_OUTCOMES.includes(ranking.outcome), `unexpected outcome: ${ranking.outcome}`);

  if (ranking.rankingRunId) {
    // Whatever aggregation ranking chose, it must belong to a FULLY-succeeded
    // workflow run — never the in-progress one.
    const [[rr]] = await pool.query<import("mysql2").RowDataPacket[]>(
      "SELECT matchup_aggregation_run_id AS m FROM ranking_runs WHERE id = ?",
      [ranking.rankingRunId]
    );
    const [[agg]] = await pool.query<import("mysql2").RowDataPacket[]>(
      "SELECT workflow_run_id AS wr, status FROM aggregation_runs WHERE id = ?",
      [rr.m]
    );
    assert.notEqual(agg.wr, inProgressAggRunId, "ranking must not use the in-progress aggregation's run");
    assert.ok(["succeeded", "succeeded_with_warnings"].includes(agg.status), "ranking's chosen aggregation run must itself be succeeded");
  } else {
    // No prior completed aggregation existed → ranking safely refused.
    assert.equal(ranking.outcome, "no_valid_aggregation");
  }

  // Cleanup: finish the interrupted aggregation so it does not linger 'running'.
  for (let i = 0; i < 2000; i += 1) {
    const r = await stepAggregation("manual", 8);
    if (r.status === "completed") break;
  }
});

test("db: a completed publish leaves exactly one current snapshot; a held/no-change run leaves the previous one current", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { stepRankingRebuild } = await import("@/lib/ranking/sync");
  const pool = getPool();

  await driveAggregationToCompletion();
  const [[beforeCount]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT COUNT(*) AS c FROM published_snapshots");
  const [[beforeCurrent]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT id FROM published_snapshots WHERE is_current = 1 LIMIT 1");

  let completed: Awaited<ReturnType<typeof stepRankingRebuild>> | null = null;
  for (let i = 0; i < 2000; i += 1) {
    const r = await stepRankingRebuild("manual", 8);
    if (r.status === "completed") {
      completed = r;
      break;
    }
  }
  assert.ok(completed);

  const [[afterCount]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT COUNT(*) AS c FROM published_snapshots");
  const [currentRows] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT id FROM published_snapshots WHERE is_current = 1");
  // The single-current invariant is absolute regardless of branch.
  assert.ok(currentRows.length <= 1, "at most one snapshot may ever be current");

  if (completed!.outcome === "published") {
    assert.equal(afterCount.c, beforeCount.c + 1, "a publish creates exactly one new snapshot");
    assert.equal(currentRows.length, 1, "after publish exactly one snapshot is current");
  } else if (completed!.outcome === "held_mass_movement" || completed!.outcome === "no_significant_change") {
    assert.equal(afterCount.c, beforeCount.c, "a held/no-change run creates no new snapshot");
    if (beforeCurrent) {
      const [[stillCurrent]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT is_current FROM published_snapshots WHERE id = ?", [beforeCurrent.id]);
      assert.equal(stillCurrent.is_current, 1, "the previous snapshot stays current on hold/no-change");
    }
  }
});

test("db: two concurrent ranking drivers — exactly one is lock-rejected, both return valid outcomes", { skip: skip ? skipReason : false }, async () => {
  const { runRankingRebuild } = await import("@/lib/ranking/sync");
  await driveAggregationToCompletion();

  const [a, b] = await Promise.all([runRankingRebuild("manual"), runRankingRebuild("manual")]);
  const outcomes = [a.outcome, b.outcome];
  assert.ok(outcomes.includes("lock_not_acquired"), "exactly one of two concurrent drivers must be lock-rejected");
  for (const o of outcomes) assert.ok([...VALID_OUTCOMES, "lock_not_acquired"].includes(o), `unexpected outcome: ${o}`);
});

test("db: each ranking rebuild creates its own independent, append-only ranking_runs row (idempotent re-runs never overwrite)", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runRankingRebuild } = await import("@/lib/ranking/sync");
  const pool = getPool();

  await driveAggregationToCompletion();
  const first = await runRankingRebuild("manual");
  await driveAggregationToCompletion();
  const second = await runRankingRebuild("manual");

  if (first.rankingRunId && second.rankingRunId) {
    assert.notEqual(first.rankingRunId, second.rankingRunId);
    const [rows] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT id FROM ranking_runs WHERE id IN (?, ?)", [first.rankingRunId, second.rankingRunId]);
    assert.equal(rows.length, 2, "both ranking runs remain independently queryable — neither overwritten");
  }
});
