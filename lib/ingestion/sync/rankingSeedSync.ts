/**
 * Ranking seed refresh — a discovery/seed source, NOT the final BrawlRanks
 * tier list (BRAWLRANKS_WEBSITE_SPEC.md Section 7.3/7.21). Fetches the
 * player-rankings leaderboard for a small, curated set of regions and
 * upserts seed_players. A failed region never blocks others and never
 * deletes the existing seed pool (Section 7's explicit rule).
 */

import { getPool } from "@/lib/mysql";
import { stableStringify, sha256Hex } from "@/lib/hash";
import { fetchRankingsFromProxy } from "@/lib/proxy";
import { validatePlayerRankingItems } from "@/lib/ingestion/schemas";
import { classifyHttpStatus } from "@/lib/ingestion/retry";
import { tryConsumeBudget } from "@/lib/ingestion/rateBudget";
import { ENDPOINT_CATEGORY, DATA_SOURCE_NAME, INITIAL_RANKING_REGIONS } from "@/lib/ingestion/config";
import * as catalogRepo from "@/lib/catalog/repository";
import * as ingestionRepo from "@/lib/ingestion/repository";
import {
  ensureWorkflowDefinition,
  acquireWorkflowLock,
  releaseWorkflowLock,
  startWorkflowRun,
  completeWorkflowRun,
} from "@/lib/workflow";

const WORKFLOW_SLUG = "ranking-seed-refresh";

export interface RegionResult {
  region: string;
  outcome: "success" | "failed" | "budget_exhausted";
  entriesFetched: number;
  reason?: string;
}

export interface RankingSeedSyncResult {
  outcome: "succeeded" | "succeeded_with_warnings" | "failed" | "lock_not_acquired" | "prerequisites_missing";
  workflowRunId?: string;
  regions: RegionResult[];
}

function trophyBracketFor(trophies: number | null): string | null {
  if (trophies === null) return null;
  if (trophies < 10_000) return "under_10k";
  if (trophies < 30_000) return "10k_30k";
  if (trophies < 50_000) return "30k_50k";
  return "50k_plus";
}

export async function runRankingSeedSync(
  triggeredBy: "manual" | "cron",
  regions: string[] = INITIAL_RANKING_REGIONS,
  triggeredByActor?: string
): Promise<RankingSeedSyncResult> {
  const pool = getPool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");

  const dataSource = await catalogRepo.getDataSourceByName(pool, DATA_SOURCE_NAME);
  if (!dataSource || !dataSource.isEnabled) {
    return { outcome: "prerequisites_missing", regions: [] };
  }
  const endpoint = await catalogRepo.getSourceEndpoint(pool, dataSource.id, ENDPOINT_CATEGORY.PLAYER_RANKINGS);
  if (!endpoint || !endpoint.isEnabled) {
    return { outcome: "prerequisites_missing", regions: [] };
  }

  const workflowRunId = await startWorkflowRun(
    pool,
    workflowDefinitionId,
    triggeredBy === "cron" ? "schedule" : "manual",
    triggeredByActor
  );

  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  if (!lock.acquired) {
    await completeWorkflowRun(pool, workflowRunId, "failed", "lock_not_acquired");
    return { outcome: "lock_not_acquired", workflowRunId, regions: [] };
  }

  const results: RegionResult[] = [];

  try {
    for (const region of regions) {
      const budget = await tryConsumeBudget(pool, "rankings", false);
      if (!budget.allowed) {
        results.push({ region, outcome: "budget_exhausted", entriesFetched: 0, reason: budget.reason });
        continue;
      }

      const fetchRunId = await catalogRepo.createFetchRun(pool, {
        dataSourceId: dataSource.id,
        sourceEndpointId: endpoint.id,
        workflowRunId,
        triggerType: triggeredBy,
      });

      const proxyResult = await fetchRankingsFromProxy("players", region);
      if (!proxyResult.proxyReached || proxyResult.httpStatus !== 200) {
        const code = classifyHttpStatus(proxyResult.httpStatus, proxyResult.transportError);
        await catalogRepo.completeFetchRun(pool, fetchRunId, {
          status: "failed",
          httpStatus: proxyResult.httpStatus,
          errorCode: code,
          changesDetectedCount: 0,
          durationMs: 0,
        });
        results.push({ region, outcome: "failed", entriesFetched: 0, reason: code });
        continue;
      }

      const body = proxyResult.body as { ok?: boolean; items?: unknown[] } | null;
      const items = body && Array.isArray(body.items) ? body.items : [];
      const { valid, rejected } = validatePlayerRankingItems(items);

      const payloadJson = stableStringify(items);
      await catalogRepo.insertRawSnapshot(pool, {
        dataFetchRunId: fetchRunId,
        endpointCategory: ENDPOINT_CATEGORY.PLAYER_RANKINGS,
        payload: payloadJson,
        checksum: sha256Hex(payloadJson),
        httpStatus: proxyResult.httpStatus,
        sourceReportedAt: null,
      });

      for (const entry of valid) {
        const seedSource = region === "global" ? "global_rank" : "country_rank";
        const trophyBracket = trophyBracketFor(entry.trophies);
        await ingestionRepo.upsertSeedPlayer(pool, {
          tag: entry.tag,
          seedSource,
          region,
          trophyBracket,
          rank: entry.rank,
          trophies: entry.trophies,
        });
        // Seed players are the deliberately-chosen set (Section 7.3) — they
        // enter the active crawl schedule directly, unlike organically
        // discovered observed_players, which must pass the promotion-rule
        // gate in playerDiscoverySync.ts first.
        await ingestionRepo.ensureCrawlScheduleEntry(pool, {
          tag: entry.tag,
          region,
          trophyBracket,
          stratumSource: seedSource,
          priorityScore: 10,
        });
      }

      await catalogRepo.completeFetchRun(pool, fetchRunId, {
        status: rejected > 0 ? "partial" : "success",
        httpStatus: proxyResult.httpStatus,
        recordsFetched: valid.length,
        changesDetectedCount: 0,
        durationMs: 0,
      });

      results.push({ region, outcome: "success", entriesFetched: valid.length });
    }

    const anyFailed = results.some((r) => r.outcome !== "success");
    const finalStatus = anyFailed ? "succeeded_with_warnings" : "succeeded";
    await completeWorkflowRun(pool, workflowRunId, finalStatus);
    return { outcome: finalStatus, workflowRunId, regions: results };
  } catch (error) {
    await completeWorkflowRun(pool, workflowRunId, "failed", error instanceof Error ? error.message : "unknown_error");
    throw error;
  } finally {
    await releaseWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  }
}
