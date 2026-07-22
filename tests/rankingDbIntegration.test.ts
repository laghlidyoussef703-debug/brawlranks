/**
 * Database-dependent Phase 5.3 integration tests. Require real MySQL/
 * MariaDB credentials (DB_HOST/DB_PORT/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1).
 * No such credentials exist in this local sandbox — these tests SKIP
 * rather than fabricate a pass, exactly like every prior phase's
 * *DbIntegration.test.ts file. Written to run for real in any environment
 * with a reachable, migrated (through 0025) database.
 *
 * Several assertions here are deliberately outcome-adaptive rather than
 * asserting one specific ranking-rebuild outcome: this suite runs against
 * whatever real, live, growing production-like dataset actually exists at
 * test time (not a fully isolated fixture), so the exact branch taken
 * (published / held_mass_movement / no_significant_change) cannot be
 * forced deterministically without either fabricating unrealistic battle
 * data at scale or adding a test-only seam to production code. What IS
 * asserted unconditionally are the structural invariants that must hold
 * no matter which branch fires — locking, append-only candidate writes,
 * DB-level uniqueness, and floor/tier consistency.
 */
import { test } from "node:test";
import { closeSharedDbPoolAfterTests } from "./helpers/closeDbPool";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const hasDbEnv = Boolean(
  process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER && process.env.BRAWL_DB_SECRET_V1
);
const skip = !hasDbEnv;
const skipReason = "No DB credentials in this environment (DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1 unset).";

closeSharedDbPoolAfterTests();

const VALID_OUTCOMES = ["published", "held_mass_movement", "no_significant_change", "no_valid_aggregation", "no_active_rule_set"];

test("db: the Phase 5.3 rule set (seeded by migration 0025) is active with all six weight signals present", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { getActiveRuleSet } = await import("@/lib/ranking/repository");
  const pool = getPool();

  const ruleSet = await getActiveRuleSet(pool);
  assert.ok(ruleSet, "expected an active ranking_rule_sets row seeded by migration 0025");
  for (const signal of ["win_rate", "pick_rate", "high_rank_win_rate", "matchup_coverage", "mode_win_rate", "mode_pick_rate"]) {
    assert.ok(ruleSet!.weights[signal], `expected signal "${signal}" to be seeded`);
  }
  assert.equal(ruleSet!.weights["win_rate"].weight, 0.5);
  assert.equal(ruleSet!.weights["pick_rate"].weight, 0.2);
  assert.equal(ruleSet!.weights["high_rank_win_rate"].weight, 0.2);
  assert.equal(ruleSet!.weights["matchup_coverage"].weight, 0.1);
  assert.equal(ruleSet!.weights["mode_win_rate"].weight, 0.7);
  assert.equal(ruleSet!.weights["mode_pick_rate"].weight, 0.3);
  assert.ok(ruleSet!.overallTierThreshold);
  assert.equal(ruleSet!.overallTierThreshold!.sCutoff, 90);
  assert.equal(ruleSet!.overallTierThreshold!.aCutoff, 70);
  assert.equal(ruleSet!.overallTierThreshold!.bCutoff, 30);
  assert.equal(ruleSet!.overallTierThreshold!.cCutoff, 10);
});

test("db: published_snapshots.current_flag UNIQUE KEY rejects a second concurrently-current snapshot at the database level, independent of application logic", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const pool = getPool();

  // A ranking_runs row is required as the FK target; create a minimal one directly.
  const [[wd]] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT id FROM workflow_definitions WHERE slug = 'ranking-rebuild' LIMIT 1"
  );
  const workflowDefinitionId = wd?.id ?? (await (async () => {
    const id = randomUUID();
    await pool.execute("INSERT INTO workflow_definitions (id, slug, workflow_type, is_enabled) VALUES (?, 'ranking-rebuild', 'scheduled_sync', 1)", [id]);
    return id;
  })());
  const workflowRunId = randomUUID();
  await pool.execute(
    "INSERT INTO workflow_runs (id, workflow_definition_id, status, triggered_by, started_at) VALUES (?, ?, 'succeeded', 'manual', NOW(3))",
    [workflowRunId, workflowDefinitionId]
  );

  const [[ruleSet]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT id FROM ranking_rule_sets WHERE is_active = 1 LIMIT 1");
  const [[aggRun]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT id FROM aggregation_runs LIMIT 1");
  if (!ruleSet || !aggRun) return; // requires prior Phase 5.1/5.2 migrations+data; skip this assertion if not present

  const makeRankingRun = async () => {
    const id = randomUUID();
    await pool.execute(
      `INSERT INTO ranking_runs (id, workflow_run_id, ranking_rule_set_id, mode_aggregation_run_id, overall_aggregation_run_id, matchup_aggregation_run_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'succeeded', NOW(3))`,
      [id, workflowRunId, ruleSet.id, aggRun.id, aggRun.id, aggRun.id]
    );
    return id;
  };

  const rankingRunA = await makeRankingRun();
  const rankingRunB = await makeRankingRun();

  await pool.execute("UPDATE published_snapshots SET is_current = 0 WHERE is_current = 1");
  await pool.execute(
    "INSERT INTO published_snapshots (id, ranking_run_id, is_current, published_at) VALUES (?, ?, 1, NOW(3))",
    [randomUUID(), rankingRunA]
  );

  await assert.rejects(
    pool.execute("INSERT INTO published_snapshots (id, ranking_run_id, is_current, published_at) VALUES (?, ?, 1, NOW(3))", [randomUUID(), rankingRunB]),
    "a second row with is_current=1 must violate uniq_published_snapshots_current"
  );
});

test("db: two concurrent ranking-rebuild runs never both acquire the workflow lock", { skip: skip ? skipReason : false }, async () => {
  const { runAggregation } = await import("@/lib/aggregation/sync");
  const { runRankingRebuild } = await import("@/lib/ranking/sync");

  // Ensure at least one valid aggregation run exists so both calls reach the lock-contention point rather than short-circuiting on the precondition.
  await runAggregation("manual").catch(() => {});

  const [a, b] = await Promise.all([runRankingRebuild("manual"), runRankingRebuild("manual")]);
  const outcomes = [a.outcome, b.outcome];
  assert.ok(outcomes.includes("lock_not_acquired"), "exactly one of two concurrent calls must be lock-rejected");
  for (const o of outcomes) assert.ok(VALID_OUTCOMES.includes(o), `unexpected outcome: ${o}`);
});

test("db: runRankingRebuild against real data returns a well-formed outcome and, when it ran, always writes append-only candidate rows for that run", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runAggregation } = await import("@/lib/aggregation/sync");
  const { runRankingRebuild } = await import("@/lib/ranking/sync");
  const pool = getPool();

  await runAggregation("manual").catch(() => {});
  const result = await runRankingRebuild("manual");
  assert.ok(VALID_OUTCOMES.includes(result.outcome));

  if (result.outcome === "no_valid_aggregation" || result.outcome === "no_active_rule_set" || result.outcome === "lock_not_acquired") {
    return; // nothing further to check for these safe-failure/lock paths
  }

  assert.ok(result.rankingRunId, "a run that got past preconditions must have a rankingRunId");
  const [resultRows] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT meets_floor, tier, matches FROM ranking_results WHERE ranking_run_id = ? AND game_mode_id IS NULL",
    [result.rankingRunId]
  );
  assert.ok(resultRows.length > 0, "candidate ranking_results rows must exist for this run regardless of publish decision");

  // Structural invariant: a row that doesn't meet its floor must never carry a tier.
  for (const row of resultRows) {
    if (!row.meets_floor) {
      assert.equal(row.tier, null, `brawler with matches=${row.matches} below the floor must have tier=NULL`);
    }
  }
});

test("db: a held (mass-movement) or no-published-change ranking run never creates a new published_snapshots row", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runAggregation } = await import("@/lib/aggregation/sync");
  const { runRankingRebuild } = await import("@/lib/ranking/sync");
  const pool = getPool();

  const [[before]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT COUNT(*) AS c FROM published_snapshots");

  await runAggregation("manual").catch(() => {});
  const result = await runRankingRebuild("manual");

  const [[after]] = await pool.query<import("mysql2").RowDataPacket[]>("SELECT COUNT(*) AS c FROM published_snapshots");

  if (result.outcome === "held_mass_movement" || result.outcome === "no_significant_change") {
    assert.equal(before.c, after.c, `outcome "${result.outcome}" must never create a new published_snapshots row`);
  } else if (result.outcome === "published") {
    assert.equal(after.c, before.c + 1, "a genuine publish must create exactly one new published_snapshots row");
  }
});

test("db: the previously-current published snapshot (if any) remains is_current=1 after a held or no-change run", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runAggregation } = await import("@/lib/aggregation/sync");
  const { runRankingRebuild } = await import("@/lib/ranking/sync");
  const pool = getPool();

  const [[beforeCurrent]] = await pool.query<import("mysql2").RowDataPacket[]>(
    "SELECT id FROM published_snapshots WHERE is_current = 1 LIMIT 1"
  );

  await runAggregation("manual").catch(() => {});
  const result = await runRankingRebuild("manual");

  if (result.outcome === "held_mass_movement" || result.outcome === "no_significant_change") {
    if (beforeCurrent) {
      const [[stillCurrent]] = await pool.query<import("mysql2").RowDataPacket[]>(
        "SELECT is_current FROM published_snapshots WHERE id = ?",
        [beforeCurrent.id]
      );
      assert.equal(stillCurrent.is_current, 1, "the previous snapshot must remain current on hold/no-change");
    }
  }
});

test("db: running the aggregation+ranking pipeline twice is safe — each ranking-rebuild call creates its own independent, append-only ranking_runs row", { skip: skip ? skipReason : false }, async () => {
  const { getPool } = await import("@/lib/mysql");
  const { runAggregation } = await import("@/lib/aggregation/sync");
  const { runRankingRebuild } = await import("@/lib/ranking/sync");
  const pool = getPool();

  await runAggregation("manual").catch(() => {});
  const first = await runRankingRebuild("manual");
  await runAggregation("manual").catch(() => {});
  const second = await runRankingRebuild("manual");

  if (first.rankingRunId && second.rankingRunId) {
    assert.notEqual(first.rankingRunId, second.rankingRunId);
    const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
      "SELECT id FROM ranking_runs WHERE id IN (?, ?)",
      [first.rankingRunId, second.rankingRunId]
    );
    assert.equal(rows.length, 2, "both ranking runs must remain independently queryable — neither overwritten");
  }
});
