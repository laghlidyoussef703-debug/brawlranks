/**
 * Retention sweep orchestrator (Phase 4.8). Runs each category's bounded
 * deletion repeatedly (up to a per-category iteration cap, so total sweep
 * runtime stays bounded within a single Hostinger-invoked request) until a
 * call returns 0 rows affected. dryRun=true reports counts via
 * countOlderThan instead of deleting anything — the "dry-run/count
 * capability in code, not an admin interface" the task requires.
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
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
  const workflowRunId = await startWorkflowRun(pool, workflowDefinitionId, triggeredBy === "cron" ? "schedule" : "manual");

  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  if (!lock.acquired) {
    await completeWorkflowRun(pool, workflowRunId, "failed", "lock_not_acquired");
    return { outcome: "lock_not_acquired", dryRun, categories: [] };
  }

  try {
    // Order matches the FK dependency chain documented in
    // lib/ingestion/retentionQueries.ts — children before parents.
    const categories: RetentionCategoryResult[] = [
      await sweepCategory(pool, "battle_children", RETENTION_DAYS.NORMALIZED_BATTLE, rq.pruneBattleChildrenOlderThan, "normalized_battles", "occurred_at", dryRun),
      await sweepCategory(pool, "normalized_battles", RETENTION_DAYS.NORMALIZED_BATTLE, rq.pruneNormalizedBattlesOlderThan, "normalized_battles", "occurred_at", dryRun),
      await sweepCategory(pool, "raw_api_snapshots", RETENTION_DAYS.RAW_SNAPSHOT, rq.pruneRawSnapshotsOlderThan, "raw_api_snapshots", "created_at", dryRun),
      await sweepCategory(pool, "data_fetch_runs", RETENTION_DAYS.FETCH_RUN, rq.pruneFetchRunsOlderThan, "data_fetch_runs", "started_at", dryRun),
      await sweepCategory(pool, "workflow_steps", RETENTION_DAYS.WORKFLOW_RUN, rq.pruneWorkflowStepsOlderThan, "workflow_runs", "started_at", dryRun),
      await sweepCategory(pool, "workflow_runs", RETENTION_DAYS.WORKFLOW_RUN, rq.pruneWorkflowRunsOlderThan, "workflow_runs", "started_at", dryRun),
      await sweepCategory(pool, "resolved_incidents", RETENTION_DAYS.RESOLVED_INCIDENT, rq.pruneResolvedIncidentsOlderThan, "data_incidents", "resolved_at", dryRun),
      await sweepCategory(pool, "unpromoted_observed_players", RETENTION_DAYS.UNPROMOTED_OBSERVED_PLAYER, rq.pruneUnpromotedObservedPlayersOlderThan, "observed_players", "first_observed_at", dryRun),
      await sweepCategory(pool, "player_name_history", RETENTION_DAYS.PLAYER_NAME_HISTORY, rq.prunePlayerNameHistoryOlderThan, "player_name_history", "recorded_at", dryRun),
    ];

    await completeWorkflowRun(pool, workflowRunId, "succeeded");
    return { outcome: "succeeded", dryRun, workflowRunId, categories };
  } catch (error) {
    await completeWorkflowRun(pool, workflowRunId, "failed", error instanceof Error ? error.message : "unknown_error");
    throw error;
  } finally {
    await releaseWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  }
}
