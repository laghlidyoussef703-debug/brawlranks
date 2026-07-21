/**
 * Player discovery — promotes a bounded batch of observed_players into the
 * active crawl set (BRAWLRANKS_WEBSITE_SPEC.md Section 7.3's promotion
 * rules) plus the always-active seed_players pool.
 *
 * Phase 4.5 fairness design:
 *  - Fine-grained strata: every non-club source_type is its own stratum;
 *    `club_member` observations are further sub-grouped by the discovering
 *    club's tag, so one very large or "highly connected" club can never
 *    crowd out members discovered via other clubs within the same run —
 *    it only ever gets one promotion slot per round-robin cycle, exactly
 *    like every other stratum, however many members it has waiting.
 *  - Underrepresented-first ordering: strata are visited in ascending order
 *    of their COARSE source_type's current representation in the active
 *    crawl schedule (lib/ingestion/repository.ts#getActiveCrawlCountsByStratumSource)
 *    — a source type with fewer currently-active players is promoted from
 *    first each cycle, directly satisfying "promote players from
 *    underrepresented strata first."
 *  - Full region/trophy-bracket stratification is still not possible at
 *    this step (a purely-observed player's region/bracket isn't known
 *    until their profile is actually fetched) — documented honestly, not
 *    overclaimed. Region/bracket fairness for the resulting active pool is
 *    handled downstream by lib/ingestion/fairness.ts at crawl-selection
 *    time, once profile data exists.
 *  - Malformed/malicious tags can never reach this function in the first
 *    place — lib/ingestion/repository.ts#recordObservedPlayer validates
 *    every tag before it's ever written to observed_players.
 */

import { getWritePool } from "@/lib/mysql";
import * as ingestionRepo from "@/lib/ingestion/repository";
import type { UnpromotedObservedPlayer } from "@/lib/ingestion/repository";
import { DEFAULT_DISCOVERY_PROMOTION_BATCH_SIZE } from "@/lib/ingestion/config";
import {
  ensureWorkflowDefinition,
  acquireWorkflowLock,
  releaseWorkflowLock,
  startWorkflowRun,
  completeWorkflowRun,
} from "@/lib/workflow";

const WORKFLOW_SLUG = "player-discovery";

/** Oversample factor for the candidate fetch relative to the promotion batch size — bounded, avoids scanning the entire backlog every run. */
const CANDIDATE_OVERSAMPLE_FACTOR = 4;

export interface PlayerDiscoveryResult {
  outcome: "succeeded" | "lock_not_acquired";
  promotedCount: number;
  workflowRunId?: string;
}

function fineStratumKey(candidate: UnpromotedObservedPlayer): string {
  return candidate.sourceType === "club_member"
    ? `club_member:${candidate.clubTag ?? "unknown"}`
    : candidate.sourceType;
}

/**
 * Pure, deterministic, unit-testable selection: given the unpromoted
 * candidate pool and the current coarse-source-type representation in the
 * active crawl schedule, returns exactly `batchSize` candidates (or fewer
 * if the pool is smaller), fairly distributed per the rules documented
 * above.
 */
export function selectPromotionBatch(
  candidates: UnpromotedObservedPlayer[],
  currentCoarseCounts: Record<string, number>,
  batchSize: number
): UnpromotedObservedPlayer[] {
  if (batchSize <= 0 || candidates.length === 0) return [];

  const byFineStratum = new Map<string, UnpromotedObservedPlayer[]>();
  for (const candidate of candidates) {
    const key = fineStratumKey(candidate);
    const bucket = byFineStratum.get(key) ?? [];
    bucket.push(candidate);
    byFineStratum.set(key, bucket);
  }

  const strataKeysInOrder = [...byFineStratum.keys()].sort((a, b) => {
    const coarseA = a.startsWith("club_member:") ? "club_member" : a;
    const coarseB = b.startsWith("club_member:") ? "club_member" : b;
    const countDiff = (currentCoarseCounts[coarseA] ?? 0) - (currentCoarseCounts[coarseB] ?? 0);
    if (countDiff !== 0) return countDiff;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const selected: UnpromotedObservedPlayer[] = [];
  let cursor = 0;
  while (selected.length < batchSize && strataKeysInOrder.length > 0) {
    const key = strataKeysInOrder[cursor % strataKeysInOrder.length];
    const bucket = byFineStratum.get(key)!;
    const next = bucket.shift();
    if (next) selected.push(next);

    if (bucket.length === 0) {
      const removeAt = strataKeysInOrder.indexOf(key);
      strataKeysInOrder.splice(removeAt, 1);
      if (strataKeysInOrder.length === 0) break;
      cursor = removeAt % strataKeysInOrder.length;
      continue;
    }
    cursor += 1;
  }

  return selected;
}

export async function runPlayerDiscovery(
  triggeredBy: "manual" | "cron",
  batchSize: number = DEFAULT_DISCOVERY_PROMOTION_BATCH_SIZE
): Promise<PlayerDiscoveryResult> {
  const pool = getWritePool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
  const workflowRunId = await startWorkflowRun(pool, workflowDefinitionId, triggeredBy === "cron" ? "schedule" : "manual");

  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  if (!lock.acquired) {
    await completeWorkflowRun(pool, workflowRunId, "failed", "lock_not_acquired");
    return { outcome: "lock_not_acquired", promotedCount: 0 };
  }

  try {
    const candidates = await ingestionRepo.getUnpromotedObservedPlayers(pool, batchSize * CANDIDATE_OVERSAMPLE_FACTOR);
    const currentCounts = await ingestionRepo.getActiveCrawlCountsByStratumSource(pool);
    const toPromote = selectPromotionBatch(candidates, currentCounts, batchSize);

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
