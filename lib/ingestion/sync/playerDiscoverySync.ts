/**
 * Player discovery — promotes a bounded batch of observed_players into the
 * active crawl set (BRAWLRANKS_WEBSITE_SPEC.md Section 7.3's promotion
 * rules) plus the always-active seed_players pool.
 *
 * Fairness simplification (documented honestly, not overclaimed): at
 * promotion time, a player's region/trophy-bracket stratum is not yet
 * known (that requires a profile fetch, which hasn't happened for a
 * purely-observed player). Full stratified fairness therefore cannot be
 * applied at THIS step — instead, this function round-robins the
 * promotion budget evenly across `source_type` categories present in the
 * backlog, which directly addresses Section 7.3's named risk ("a large
 * backlog of low-priority ones... prevents the sample from organically
 * drifting toward whatever social cluster the seed players belong to")
 * without a full profile fetch per candidate. Region/bracket-aware
 * rebalancing happens later, at aggregation time (Section 7.10, out of
 * this phase's scope).
 */

import { getPool } from "@/lib/mysql";
import * as ingestionRepo from "@/lib/ingestion/repository";
import { DEFAULT_DISCOVERY_PROMOTION_BATCH_SIZE } from "@/lib/ingestion/config";
import {
  ensureWorkflowDefinition,
  acquireWorkflowLock,
  releaseWorkflowLock,
  startWorkflowRun,
  completeWorkflowRun,
} from "@/lib/workflow";

const WORKFLOW_SLUG = "player-discovery";

export interface PlayerDiscoveryResult {
  outcome: "succeeded" | "lock_not_acquired";
  promotedCount: number;
  workflowRunId?: string;
}

export async function runPlayerDiscovery(
  triggeredBy: "manual" | "cron",
  batchSize: number = DEFAULT_DISCOVERY_PROMOTION_BATCH_SIZE
): Promise<PlayerDiscoveryResult> {
  const pool = getPool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
  const workflowRunId = await startWorkflowRun(pool, workflowDefinitionId, triggeredBy === "cron" ? "schedule" : "manual");

  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  if (!lock.acquired) {
    await completeWorkflowRun(pool, workflowRunId, "failed", "lock_not_acquired");
    return { outcome: "lock_not_acquired", promotedCount: 0 };
  }

  try {
    const candidates = await ingestionRepo.getUnpromotedObservedPlayers(pool, batchSize * 4);

    const bySourceType = new Map<string, Array<{ tag: string; sourceType: string }>>();
    for (const candidate of candidates) {
      const bucket = bySourceType.get(candidate.sourceType) ?? [];
      bucket.push(candidate);
      bySourceType.set(candidate.sourceType, bucket);
    }

    const sourceTypes = [...bySourceType.keys()];
    const toPromote: Array<{ tag: string; sourceType: string }> = [];
    let index = 0;
    while (toPromote.length < batchSize && sourceTypes.length > 0) {
      const type = sourceTypes[index % sourceTypes.length];
      const bucket = bySourceType.get(type)!;
      const next = bucket.shift();
      if (next) toPromote.push(next);
      if (bucket.length === 0) {
        sourceTypes.splice(index % sourceTypes.length, 1);
        continue;
      }
      index += 1;
    }

    for (const candidate of toPromote) {
      await ingestionRepo.ensureCrawlScheduleEntry(pool, {
        tag: candidate.tag,
        region: null,
        trophyBracket: null,
        stratumSource: candidate.sourceType,
        priorityScore: 0,
      });
      await ingestionRepo.markObservedPlayerPromoted(pool, candidate.tag);
    }

    await completeWorkflowRun(pool, workflowRunId, "succeeded");
    return { outcome: "succeeded", promotedCount: toPromote.length, workflowRunId };
  } catch (error) {
    await completeWorkflowRun(pool, workflowRunId, "failed", error instanceof Error ? error.message : "unknown_error");
    throw error;
  } finally {
    await releaseWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  }
}
