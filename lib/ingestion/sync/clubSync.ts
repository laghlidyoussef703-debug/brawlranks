/**
 * Club lookup and member discovery (BRAWLRANKS_WEBSITE_SPEC.md Section 7 —
 * club ingestion). Discovered members are recorded as observed_players,
 * never directly promoted to the active crawl set (Section 7.3's
 * promotion-rule requirement — see playerDiscoverySync.ts).
 */

import { getPool } from "@/lib/mysql";
import { stableStringify, sha256Hex } from "@/lib/hash";
import { fetchClubFromProxy } from "@/lib/proxy";
import { validateClubPayload } from "@/lib/ingestion/schemas";
import { classifyHttpStatus } from "@/lib/ingestion/retry";
import { tryConsumeBudget } from "@/lib/ingestion/rateBudget";
import { validateAndNormalizeTag, encodeTagForPath } from "@/lib/ingestion/tags";
import { computeIncidentSignature } from "@/lib/ingestion/incidents";
import { ENDPOINT_CATEGORY, DATA_SOURCE_NAME } from "@/lib/ingestion/config";
import * as catalogRepo from "@/lib/catalog/repository";
import * as ingestionRepo from "@/lib/ingestion/repository";
import {
  ensureWorkflowDefinition,
  acquireWorkflowLock,
  releaseWorkflowLock,
  startWorkflowRun,
  completeWorkflowRun,
} from "@/lib/workflow";

const WORKFLOW_SLUG = "club-expansion";

/** Real in-game clubs cap near 100 members; this is a defensive ceiling in case a payload ever reports more, so member discovery can never be unbounded (Phase 4.6). */
const MAX_CLUB_MEMBERS_TO_DISCOVER = 150;

/** How recently the same club tag must have been fetched to skip a redundant re-fetch (Phase 4.6 — "prevent repeated fetching of the same club"). */
const RECENT_FETCH_GUARD_MS = 6 * 60 * 60_000;

export interface ClubSyncResult {
  outcome:
    | "succeeded"
    | "failed"
    | "invalid_tag"
    | "budget_exhausted"
    | "lock_not_acquired"
    | "prerequisites_missing"
    | "recently_fetched";
  membersDiscovered?: number;
  linkedPendingPlayers?: number;
  reason?: string;
}

export async function runClubSync(clubTagRaw: string, triggeredBy: "manual" | "cron" | "api"): Promise<ClubSyncResult> {
  const tagResult = validateAndNormalizeTag(clubTagRaw);
  if (!tagResult.valid || !tagResult.normalized) {
    return { outcome: "invalid_tag", reason: tagResult.reason };
  }
  const tag = tagResult.normalized;

  const pool = getPool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");

  const dataSource = await catalogRepo.getDataSourceByName(pool, DATA_SOURCE_NAME);
  const endpoint = dataSource
    ? await catalogRepo.getSourceEndpoint(pool, dataSource.id, ENDPOINT_CATEGORY.CLUB_PROFILE)
    : null;
  if (!dataSource || !dataSource.isEnabled || !endpoint || !endpoint.isEnabled) {
    return { outcome: "prerequisites_missing" };
  }

  const requestContext = { clubTag: tag };
  const recentlyFetched = await catalogRepo.hasRecentFetchRunForContext(
    pool,
    endpoint.id,
    requestContext,
    RECENT_FETCH_GUARD_MS
  );
  if (recentlyFetched) {
    return { outcome: "recently_fetched", reason: "already fetched within the guard window" };
  }

  const workflowRunId = await startWorkflowRun(pool, workflowDefinitionId, triggeredBy === "cron" ? "schedule" : "manual");
  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  if (!lock.acquired) {
    await completeWorkflowRun(pool, workflowRunId, "failed", "lock_not_acquired");
    return { outcome: "lock_not_acquired" };
  }

  try {
    const budget = await tryConsumeBudget(pool, "club", false);
    if (!budget.allowed) {
      await completeWorkflowRun(pool, workflowRunId, "failed", "budget_exhausted");
      return { outcome: "budget_exhausted" };
    }

    const fetchRunId = await catalogRepo.createFetchRun(pool, {
      dataSourceId: dataSource.id,
      sourceEndpointId: endpoint.id,
      workflowRunId,
      triggerType: triggeredBy,
      requestContext,
    });

    const proxyResult = await fetchClubFromProxy(encodeTagForPath(tag));
    if (!proxyResult.proxyReached || proxyResult.httpStatus !== 200) {
      const code = classifyHttpStatus(proxyResult.httpStatus, proxyResult.transportError);
      await catalogRepo.completeFetchRun(pool, fetchRunId, {
        status: "failed",
        httpStatus: proxyResult.httpStatus,
        errorCode: code,
        changesDetectedCount: 0,
        durationMs: 0,
      });
      await completeWorkflowRun(pool, workflowRunId, "failed", code);
      return { outcome: "failed", reason: code };
    }

    const body = proxyResult.body as { ok?: boolean; payload?: unknown } | null;
    const validated = validateClubPayload(body?.payload ?? body);

    const payloadJson = stableStringify(body);
    await catalogRepo.insertRawSnapshot(pool, {
      dataFetchRunId: fetchRunId,
      endpointCategory: ENDPOINT_CATEGORY.CLUB_PROFILE,
      payload: payloadJson,
      checksum: sha256Hex(payloadJson),
      httpStatus: proxyResult.httpStatus,
      sourceReportedAt: null,
    });

    if (!validated) {
      await catalogRepo.completeFetchRun(pool, fetchRunId, {
        status: "failed",
        httpStatus: proxyResult.httpStatus,
        errorCode: "schema_mismatch",
        changesDetectedCount: 0,
        durationMs: 0,
      });
      await catalogRepo.createIncident(pool, {
        incidentType: "schema_mismatch",
        dataCategory: "club",
        relatedFetchRunId: fetchRunId,
        relatedEntityType: "club",
        relatedEntityId: tag,
        detail: { reason: "club payload failed validation" },
        signature: computeIncidentSignature({
          incidentType: "schema_mismatch",
          dataCategory: "club",
          relatedEntityType: "club",
          reasonKey: "club_payload_validation_failed",
        }),
      });
      await completeWorkflowRun(pool, workflowRunId, "failed", "schema_mismatch");
      return { outcome: "failed", reason: "schema_mismatch" };
    }

    const clubId = await ingestionRepo.upsertNormalizedClub(pool, {
      tag: validated.tag,
      name: validated.name,
      description: validated.description,
      clubType: validated.type,
      trophies: validated.trophies,
      requiredTrophies: validated.requiredTrophies,
      memberCount: validated.members.length,
      fetchRunId,
    });

    // Any normalized_players row that referenced this club before it was
    // normalized (Phase 4.6/migration 0017) gets linked now, in one pass —
    // not just the single player whose profile fetch may have triggered
    // this club fetch.
    const linkedPendingPlayers = await ingestionRepo.backfillPendingClubLinks(pool, validated.tag, clubId);

    const membersToDiscover = validated.members.slice(0, MAX_CLUB_MEMBERS_TO_DISCOVER);
    for (const member of membersToDiscover) {
      await ingestionRepo.recordObservedPlayer(pool, member.tag, "club_member", {
        clubTag: validated.tag,
        role: member.role,
      });
    }

    await catalogRepo.completeFetchRun(pool, fetchRunId, {
      status: "success",
      httpStatus: proxyResult.httpStatus,
      recordsFetched: validated.members.length,
      changesDetectedCount: 0,
      durationMs: 0,
    });
    await completeWorkflowRun(pool, workflowRunId, "succeeded");
    return {
      outcome: "succeeded",
      membersDiscovered: membersToDiscover.length,
      linkedPendingPlayers,
    };
  } catch (error) {
    await completeWorkflowRun(pool, workflowRunId, "failed", error instanceof Error ? error.message : "unknown_error");
    throw error;
  } finally {
    await releaseWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  }
}
