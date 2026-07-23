/**
 * Player profile ingestion by official tag (BRAWLRANKS_WEBSITE_SPEC.md
 * Section 7 — player profile behavior). A single 404, after retry policy
 * allows it, marks the player unreachable; a transient failure never does.
 */

import { getWritePool } from "@/lib/mysql";
import { stableStringify, sha256Hex } from "@/lib/hash";
import { fetchPlayerFromProxy } from "@/lib/proxy";
import { validatePlayerPayload } from "@/lib/ingestion/schemas";
import { classifyHttpStatus, decideRetry } from "@/lib/ingestion/retry";
import { tryConsumeBudget } from "@/lib/ingestion/rateBudget";
import { validateAndNormalizeTag, encodeTagForPath } from "@/lib/ingestion/tags";
import { computeIncidentSignature } from "@/lib/ingestion/incidents";
import { ENDPOINT_CATEGORY, DATA_SOURCE_NAME } from "@/lib/ingestion/config";
import * as catalogRepo from "@/lib/catalog/repository";
import * as ingestionRepo from "@/lib/ingestion/repository";

export interface PlayerProfileSyncResult {
  tag: string;
  outcome: "success" | "unreachable" | "failed" | "invalid_tag" | "budget_exhausted" | "prerequisites_missing";
  reason?: string;
  /**
   * Set when this player references a club tag that isn't normalized yet
   * (Phase 4.6). Always preserved on the player row via pending_club_tag
   * (migration 0017) regardless of what the caller does with this value.
   * Deliberately NOT auto-fetched inline here — a batch of many players
   * could reference many distinct unknown clubs, and triggering a full
   * club fetch per player risks a single Hostinger-invoked request running
   * long (Section 24.6). Callers that want to resolve these (e.g. the
   * player-crawl-batch route) do so afterward, in a small, explicitly
   * bounded pass — see app/api/internal/cron/player-crawl-batch/route.ts.
   */
  pendingClubTag?: string | null;
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
  const pool = getWritePool();

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
    requestContext: { playerTag: tag },
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
      dataCategory: "player",
      relatedFetchRunId: fetchRunId,
      relatedEntityType: "player",
      relatedEntityId: tag,
      signature: computeIncidentSignature({
        incidentType: "schema_mismatch",
        dataCategory: "player",
        relatedEntityType: "player",
        reasonKey: "player_payload_validation_failed",
      }),
    });
    return { tag, outcome: "failed", reason: "schema_mismatch" };
  }

  let clubId: string | null = null;
  let pendingClubTag: string | null = null;
  if (validated.clubTag) {
    const club = await ingestionRepo.getClubByTag(pool, validated.clubTag);
    if (club) {
      clubId = club.id;
    } else {
      pendingClubTag = validated.clubTag;
    }
  }

  await ingestionRepo.upsertNormalizedPlayer(pool, {
    tag: validated.tag,
    displayName: validated.name,
    nameColor: validated.nameColor,
    trophies: validated.trophies,
    highestTrophies: validated.highestTrophies,
    expLevel: validated.expLevel,
    clubId,
    pendingClubTag,
    fetchRunId,
  });

  await catalogRepo.completeFetchRun(pool, fetchRunId, {
    status: "success",
    httpStatus: proxyResult.httpStatus,
    recordsFetched: 1,
    changesDetectedCount: 0,
    durationMs: 0,
  });

  return { tag, outcome: "success", pendingClubTag };
}
