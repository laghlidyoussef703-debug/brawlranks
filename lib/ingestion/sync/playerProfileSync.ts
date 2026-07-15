/**
 * Player profile ingestion by official tag (BRAWLRANKS_WEBSITE_SPEC.md
 * Section 7 — player profile behavior). A single 404, after retry policy
 * allows it, marks the player unreachable; a transient failure never does.
 */

import { getPool } from "@/lib/mysql";
import { stableStringify, sha256Hex } from "@/lib/hash";
import { fetchPlayerFromProxy } from "@/lib/proxy";
import { validatePlayerPayload } from "@/lib/ingestion/schemas";
import { classifyHttpStatus, decideRetry } from "@/lib/ingestion/retry";
import { tryConsumeBudget } from "@/lib/ingestion/rateBudget";
import { validateAndNormalizeTag, encodeTagForPath } from "@/lib/ingestion/tags";
import { ENDPOINT_CATEGORY, DATA_SOURCE_NAME } from "@/lib/ingestion/config";
import * as catalogRepo from "@/lib/catalog/repository";
import * as ingestionRepo from "@/lib/ingestion/repository";

export interface PlayerProfileSyncResult {
  tag: string;
  outcome: "success" | "unreachable" | "failed" | "invalid_tag" | "budget_exhausted" | "prerequisites_missing";
  reason?: string;
}

/**
 * Syncs one player's profile. Does not manage its own workflow_run —
 * intended to be called either standalone (a bounded batch route) or as
 * part of a larger crawl batch that owns the surrounding workflow run.
 */
export async function syncOnePlayerProfile(
  playerTagRaw: string,
  fetchTriggerType: "manual" | "cron" | "api",
  workflowRunId: string | null
): Promise<PlayerProfileSyncResult> {
  const tagResult = validateAndNormalizeTag(playerTagRaw);
  if (!tagResult.valid || !tagResult.normalized) {
    return { tag: playerTagRaw, outcome: "invalid_tag", reason: tagResult.reason };
  }
  const tag = tagResult.normalized;
  const pool = getPool();

  const dataSource = await catalogRepo.getDataSourceByName(pool, DATA_SOURCE_NAME);
  const endpoint = dataSource
    ? await catalogRepo.getSourceEndpoint(pool, dataSource.id, ENDPOINT_CATEGORY.PLAYER_PROFILE)
    : null;
  if (!dataSource || !dataSource.isEnabled || !endpoint || !endpoint.isEnabled) {
    return { tag, outcome: "prerequisites_missing" };
  }

  const budget = await tryConsumeBudget(pool, "player_profile", false);
  if (!budget.allowed) {
    return { tag, outcome: "budget_exhausted" };
  }

  const fetchRunId = await catalogRepo.createFetchRun(pool, {
    dataSourceId: dataSource.id,
    sourceEndpointId: endpoint.id,
    workflowRunId,
    triggerType: fetchTriggerType,
  });

  const proxyResult = await fetchPlayerFromProxy(encodeTagForPath(tag));

  if (!proxyResult.proxyReached || proxyResult.httpStatus !== 200) {
    const code = classifyHttpStatus(proxyResult.httpStatus, proxyResult.transportError);
    const decision = decideRetry(code, 1);

    await catalogRepo.completeFetchRun(pool, fetchRunId, {
      status: decision.terminalStatus === "dead" && !decision.shouldRetry ? "failed" : "failed",
      httpStatus: proxyResult.httpStatus,
      errorCode: code,
      changesDetectedCount: 0,
      durationMs: 0,
    });

    if (code === "not_found") {
      await ingestionRepo.markPlayerUnreachable(pool, tag, "not_found");
      return { tag, outcome: "unreachable", reason: "not_found" };
    }
    return { tag, outcome: "failed", reason: code };
  }

  const body = proxyResult.body as { ok?: boolean; payload?: unknown } | null;
  const validated = validatePlayerPayload(body?.payload ?? body);

  const payloadJson = stableStringify(body);
  await catalogRepo.insertRawSnapshot(pool, {
    dataFetchRunId: fetchRunId,
    endpointCategory: ENDPOINT_CATEGORY.PLAYER_PROFILE,
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
      relatedFetchRunId: fetchRunId,
      relatedEntityType: "player",
      relatedEntityId: tag,
    });
    return { tag, outcome: "failed", reason: "schema_mismatch" };
  }

  let clubId: string | null = null;
  if (validated.clubTag) {
    const club = await ingestionRepo.getClubByTag(pool, validated.clubTag);
    clubId = club?.id ?? null;
  }

  await ingestionRepo.upsertNormalizedPlayer(pool, {
    tag: validated.tag,
    displayName: validated.name,
    nameColor: validated.nameColor,
    trophies: validated.trophies,
    highestTrophies: validated.highestTrophies,
    expLevel: validated.expLevel,
    clubId,
    fetchRunId,
  });

  await catalogRepo.completeFetchRun(pool, fetchRunId, {
    status: "success",
    httpStatus: proxyResult.httpStatus,
    recordsFetched: 1,
    changesDetectedCount: 0,
    durationMs: 0,
  });

  return { tag, outcome: "success" };
}
