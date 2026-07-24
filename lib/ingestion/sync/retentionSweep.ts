/**
 * Retention sweep orchestrator (Phase 4.8), NEUTRALIZED for DATASET Phase 14.
 *
 * This is the pre-Phase-14 destructive sweep. Its deletions are NOT
 * archive-gated, so under Phase 14 ("Deletion always means removal from hot
 * MySQL AFTER archive verification where archive is specified"; DATASET.md line
 * ~623: "The existing 180-day battle and 90-day raw-row deletion must not run
 * unchanged once this policy is adopted") it must not delete by default. Two
 * changes enforce that:
 *
 *   1. The forbidden `raw_api_snapshots` metadata DELETE is removed entirely
 *      (raw metadata is kept forever; only its payload is nulled, by the
 *      archive-gated lib/retention/rawPayload.ts `runRawPayloadSweep`).
 *   2. The FOOT-GUN IS REMOVED: this sweep can no longer delete at all. Every
 *      category is count-only (report-only) unconditionally — there is no
 *      environment flag (the former RETENTION_LEGACY_SWEEP_ENABLED is gone) that
 *      turns it destructive. It is now purely a reporting/monitoring tool.
 *
 * The Phase-14-COMPLIANT destructive paths are elsewhere and independently
 * flag+environment-gated: aggregate/ranking child rows via lib/retention
 * (archive + double-verify + staging re-import), raw payload nulling via
 * lib/retention/rawPayload, and the battle-graph / workflow-audit / fetch-audit
 * families via lib/retention/graph.
 *
 * dryRun is retained only so callers/responses keep their shape; it changes
 * nothing here — deletes never happen either way.
 */

import type { Pool } from "mysql2/promise";
import { getWritePool } from "@/lib/mysql";
import { RETENTION_DAYS, RETENTION_BATCH_SIZE } from "@/lib/ingestion/retention";
import * as rq from "@/lib/ingestion/retentionQueries";
import {
  ensureWorkflowDefinition,
  acquireWorkflowLock,
  releaseWorkflowLock,
  startWorkflowRun,
  completeWorkflowRun,
} from "@/lib/workflow";

const WORKFLOW_SLUG = "retention-sweep";
/** Bounds total work per category per sweep call — e.g. 20 x 500 = at most 10,000 rows per category per run, keeping runtime predictable. */
const MAX_ITERATIONS_PER_CATEGORY = 20;

export interface RetentionCategoryResult {
  category: string;
  cutoff: string;
  deleted: number;
  dryRunCount?: number;
}

export interface RetentionSweepResult {
  outcome: "succeeded" | "lock_not_acquired";
  dryRun: boolean;
  /** Always false: this legacy sweep can no longer delete anything (fail-closed). */
  destructiveExecuted: false;
  /** Always true: every category is count-only. */
  reportOnly: true;
  workflowRunId?: string;
  categories: RetentionCategoryResult[];
}

function cutoffFor(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60_000);
}

type PruneFn = (db: Pool, cutoff: Date, batchSize: number) => Promise<number>;

async function sweepCategory(
  pool: Pool,
  name: string,
  retentionDays: number,
  pruneFn: PruneFn,
  countTable: string,
  countColumn: string,
  isDryRun: boolean
): Promise<RetentionCategoryResult> {
  const cutoff = cutoffFor(retentionDays);

  if (isDryRun) {
    const count = await rq.countOlderThan(pool, countTable, countColumn, cutoff);
    return { category: name, cutoff: cutoff.toISOString(), deleted: 0, dryRunCount: count };
  }

  let totalDeleted = 0;
  for (let i = 0; i < MAX_ITERATIONS_PER_CATEGORY; i += 1) {
    const deleted = await pruneFn(pool, cutoff, RETENTION_BATCH_SIZE);
    totalDeleted += deleted;
    if (deleted < RETENTION_BATCH_SIZE) break;
  }
  return { category: name, cutoff: cutoff.toISOString(), deleted: totalDeleted };
}

export async function runRetentionSweep(
  triggeredBy: "manual" | "cron",
  dryRun: boolean = false
): Promise<RetentionSweepResult> {
  const pool = getWritePool();
  // DATASET Phase 14 FOOT-GUN REMOVED: this legacy, non-archive-gated sweep can
  // NEVER delete. Every category is count-only (report-only), regardless of the
  // `dryRun` argument, so there is no environment flag that turns it destructive.
  // The Phase-14-compliant destructive paths are: aggregate/ranking child rows
  // (lib/retention), raw payload nulling (lib/retention/rawPayload), and the
  // battle-graph / workflow-audit / fetch-audit families (lib/retention/graph),
  // each archive-gated and separately flag+environment-guarded.
  const reportOnly = true as const;

  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
  const workflowRunId = await startWorkflowRun(pool, workflowDefinitionId, triggeredBy === "cron" ? "schedule" : "manual");

  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  if (!lock.acquired) {
    await completeWorkflowRun(pool, workflowRunId, "failed", "lock_not_acquired");
    return { outcome: "lock_not_acquired", dryRun, destructiveExecuted: false, reportOnly, categories: [] };
  }

  try {
    // Order matches the FK dependency chain documented in
    // lib/ingestion/retentionQueries.ts — children before parents. The forbidden
    // raw_api_snapshots metadata DELETE is intentionally absent (Phase 14: raw
    // metadata is kept forever; only its payload is nulled elsewhere). `reportOnly`
    // makes every category count-only, deleting nothing.
    const categories: RetentionCategoryResult[] = [
      await sweepCategory(pool, "battle_children", RETENTION_DAYS.NORMALIZED_BATTLE, rq.pruneBattleChildrenOlderThan, "normalized_battles", "occurred_at", reportOnly),
      await sweepCategory(pool, "normalized_battles", RETENTION_DAYS.NORMALIZED_BATTLE, rq.pruneNormalizedBattlesOlderThan, "normalized_battles", "occurred_at", reportOnly),
      await sweepCategory(pool, "data_fetch_runs", RETENTION_DAYS.FETCH_RUN, rq.pruneFetchRunsOlderThan, "data_fetch_runs", "started_at", reportOnly),
      await sweepCategory(pool, "workflow_steps", RETENTION_DAYS.WORKFLOW_RUN, rq.pruneWorkflowStepsOlderThan, "workflow_runs", "started_at", reportOnly),
      await sweepCategory(pool, "workflow_runs", RETENTION_DAYS.WORKFLOW_RUN, rq.pruneWorkflowRunsOlderThan, "workflow_runs", "started_at", reportOnly),
      await sweepCategory(pool, "resolved_incidents", RETENTION_DAYS.RESOLVED_INCIDENT, rq.pruneResolvedIncidentsOlderThan, "data_incidents", "resolved_at", reportOnly),
      await sweepCategory(pool, "unpromoted_observed_players", RETENTION_DAYS.UNPROMOTED_OBSERVED_PLAYER, rq.pruneUnpromotedObservedPlayersOlderThan, "observed_players", "first_observed_at", reportOnly),
      await sweepCategory(pool, "player_name_history", RETENTION_DAYS.PLAYER_NAME_HISTORY, rq.prunePlayerNameHistoryOlderThan, "player_name_history", "recorded_at", reportOnly),
    ];

    await completeWorkflowRun(pool, workflowRunId, "succeeded");
    return { outcome: "succeeded", dryRun, destructiveExecuted: false, reportOnly, workflowRunId, categories };
  } catch (error) {
    await completeWorkflowRun(pool, workflowRunId, "failed", error instanceof Error ? error.message : "unknown_error");
    throw error;
  } finally {
    await releaseWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  }
}
