/**
 * Statistical aggregation orchestrator (Phase 5.2 — BRAWLRANKS_WEBSITE_SPEC.md
 * Section 7.8, workflow cadence per Section 7.22/15's "Statistical
 * aggregation | Every 6-12 hours"). Computes only the metrics defined with
 * a concrete formula and no outstanding owner decision — see migration
 * 0022's header for the full scope explanation. Reads normalized_battles/
 * battle_participants/battle_teams only — never mutates Phase 3/4
 * collection tables.
 *
 * Idempotency/failure-safety model: this workflow's own workflow_locks
 * entry (same mechanism as every other workflow in this codebase) prevents
 * two runs from ever executing concurrently. Every write is append-only
 * (a fresh aggregation_runs id per invocation, never an update to a prior
 * run's rows — Section 7.20's "Append-only per patch/window" retention
 * rule) and happens inside one transaction, so a mid-run failure leaves
 * zero partial aggregate rows behind, not a half-written run — the
 * previous run's aggregates (if any) remain the last valid computed
 * snapshot regardless of whether this run succeeds.
 */

import type { PoolConnection } from "mysql2/promise";
import { getPool } from "@/lib/mysql";
import * as aggRepo from "@/lib/aggregation/repository";
import { reconcileCounts } from "@/lib/aggregation/formulas";
import {
  ensureWorkflowDefinition,
  acquireWorkflowLock,
  releaseWorkflowLock,
  startWorkflowRun,
  completeWorkflowRun,
} from "@/lib/workflow";

const WORKFLOW_SLUG = "statistical-aggregation";

export interface AggregationResult {
  outcome: "succeeded" | "succeeded_with_warnings" | "lock_not_acquired";
  workflowRunId?: string;
  modeAggregateCount: number;
  overallAggregateCount: number;
  matchupAggregateCount: number;
  reconciliationWarnings: number;
}

async function writeModeAggregates(connection: PoolConnection, aggregationRunId: string): Promise<{ count: number; warnings: number }> {
  const rows = await aggRepo.computeModeAggregates(connection);
  let warnings = 0;
  for (const row of rows) {
    if (!reconcileCounts(row)) warnings += 1;
    await aggRepo.insertModeAggregate(connection, aggregationRunId, row);
  }
  return { count: rows.length, warnings };
}

async function writeOverallAggregates(connection: PoolConnection, aggregationRunId: string): Promise<{ count: number; warnings: number }> {
  const rows = await aggRepo.computeOverallAggregates(connection);
  let warnings = 0;
  for (const row of rows) {
    if (!reconcileCounts({ matches: row.matches, wins: row.wins, losses: row.losses, draws: row.draws })) warnings += 1;
    await aggRepo.insertOverallAggregate(connection, aggregationRunId, row);
  }
  return { count: rows.length, warnings };
}

async function writeMatchupAggregates(connection: PoolConnection, aggregationRunId: string): Promise<{ count: number; warnings: number }> {
  const rows = await aggRepo.computeMatchupAggregates(connection);
  let warnings = 0;
  for (const row of rows) {
    // A matchup pair has no "draws" dimension tracked (Section 7.8's
    // matchup row only names win count / total such battles) — reconcile
    // against wins+losses <= matches instead of the 4-field battle-level check.
    if (row.wins + row.losses > row.matches) warnings += 1;
    await aggRepo.insertMatchupAggregate(connection, aggregationRunId, row);
  }
  return { count: rows.length, warnings };
}

export async function runAggregation(triggeredBy: "manual" | "cron"): Promise<AggregationResult> {
  const pool = getPool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
  const workflowRunId = await startWorkflowRun(pool, workflowDefinitionId, triggeredBy === "cron" ? "schedule" : "manual");

  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  if (!lock.acquired) {
    await completeWorkflowRun(pool, workflowRunId, "failed", "lock_not_acquired");
    return { outcome: "lock_not_acquired", modeAggregateCount: 0, overallAggregateCount: 0, matchupAggregateCount: 0, reconciliationWarnings: 0 };
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const modeRunId = await aggRepo.createAggregationRun(connection, { workflowRunId, scope: "per_mode" });
    const overallRunId = await aggRepo.createAggregationRun(connection, { workflowRunId, scope: "overall" });
    const matchupRunId = await aggRepo.createAggregationRun(connection, { workflowRunId, scope: "matchup" });

    const modeResult = await writeModeAggregates(connection, modeRunId);
    const overallResult = await writeOverallAggregates(connection, overallRunId);
    const matchupResult = await writeMatchupAggregates(connection, matchupRunId);

    const totalWarnings = modeResult.warnings + overallResult.warnings + matchupResult.warnings;
    const runStatus = totalWarnings > 0 ? "succeeded_with_warnings" : "succeeded";

    await aggRepo.completeAggregationRun(connection, modeRunId, runStatus, modeResult.count);
    await aggRepo.completeAggregationRun(connection, overallRunId, runStatus, overallResult.count);
    await aggRepo.completeAggregationRun(connection, matchupRunId, runStatus, matchupResult.count);

    await connection.commit();

    await completeWorkflowRun(pool, workflowRunId, runStatus);

    return {
      outcome: runStatus,
      workflowRunId,
      modeAggregateCount: modeResult.count,
      overallAggregateCount: overallResult.count,
      matchupAggregateCount: matchupResult.count,
      reconciliationWarnings: totalWarnings,
    };
  } catch (error) {
    await connection.rollback();
    await completeWorkflowRun(pool, workflowRunId, "failed", error instanceof Error ? error.message : "unknown_error");
    throw error;
  } finally {
    connection.release();
    await releaseWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  }
}
