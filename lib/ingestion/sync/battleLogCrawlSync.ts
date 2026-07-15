/**
 * Battle-log ingestion pipeline (BRAWLRANKS_WEBSITE_SPEC.md Section 7.4's
 * 14 pipeline steps). Per due player: acquire a crawl lease, fetch via the
 * proxy, store the immutable raw payload, validate, normalize, resolve
 * canonical mode/map/Brawler/player references, deduplicate via the
 * deterministic battle key, merge newly observed participants, update the
 * crawl schedule, and commit atomically per battle.
 *
 * Retry model: this route returns quickly (Section 24.6 — a cron-invoked
 * endpoint must not block on in-process retry loops). "Retry" for a failed
 * per-player fetch means the crawl schedule's backoff_until/next_due_at
 * fields make that player eligible again on a LATER scheduled batch, not
 * an immediate retry within this same request.
 */

import type { PoolConnection } from "mysql2/promise";
import { getPool } from "@/lib/mysql";
import { stableStringify, sha256Hex } from "@/lib/hash";
import { fetchPlayerBattleLogFromProxy, validateProxyEnvelope } from "@/lib/proxy";
import { validateBattleLogItems, type ValidatedBattleItem } from "@/lib/ingestion/schemas";
import { computeBattleKey } from "@/lib/ingestion/battleId";
import { classifyHttpStatus, decideRetry, computeBackoffMs } from "@/lib/ingestion/retry";
import { tryConsumeBudget } from "@/lib/ingestion/rateBudget";
import { encodeTagForPath } from "@/lib/ingestion/tags";
import {
  ENDPOINT_CATEGORY,
  DATA_SOURCE_NAME,
  DEFAULT_CRAWL_BATCH_SIZE,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_RECRAWL_INTERVAL_MS,
  MAX_CONSECUTIVE_CRAWL_FAILURES,
} from "@/lib/ingestion/config";
import * as catalogRepo from "@/lib/catalog/repository";
import * as ingestionRepo from "@/lib/ingestion/repository";
import {
  ensureWorkflowDefinition,
  acquireWorkflowLock,
  releaseWorkflowLock,
  startWorkflowRun,
  completeWorkflowRun,
} from "@/lib/workflow";

const WORKFLOW_SLUG = "battle-log-crawl";

export interface BattleLogCrawlResult {
  outcome: "succeeded" | "succeeded_with_warnings" | "lock_not_acquired" | "prerequisites_missing" | "no_due_players";
  workflowRunId?: string;
  crawlBatchId?: string;
  playersProcessed: number;
  battlesIngested: number;
  battlesDeduplicated: number;
  battlesQuarantined: number;
}

async function processOneBattle(
  connection: PoolConnection,
  item: ValidatedBattleItem,
  crawledPlayerTag: string,
  fetchRunId: string
): Promise<"inserted" | "deduplicated" | "quarantined"> {
  const battleKey = computeBattleKey({
    battleTimeRaw: item.battleTime,
    mode: item.mode,
    teams: item.teams.map((t) => t.map((p) => p.tag)),
  });

  const existingBattleId = await ingestionRepo.getBattleIdByKey(connection, battleKey);
  if (existingBattleId) {
    await ingestionRepo.insertBattleObservation(connection, existingBattleId, fetchRunId, crawledPlayerTag);
    return "deduplicated";
  }

  const gameModeId = await ingestionRepo.getOrCreateGameMode(connection, item.mode, item.mode);
  const mapId = item.map ? await ingestionRepo.getOrCreateMap(connection, item.map, item.map, gameModeId) : null;

  const resolvedTeams: Array<Array<{ tag: string; name: string; playerId: string; brawlerId: string; power: number | null; trophies: number | null }>> = [];
  let hasUnknownBrawler = false;

  for (const team of item.teams) {
    const resolved: (typeof resolvedTeams)[number] = [];
    for (const participant of team) {
      const brawler = await catalogRepo.getCanonicalBrawlerBySourceId(connection, participant.brawlerSourceId);
      if (!brawler) {
        hasUnknownBrawler = true;
        continue;
      }
      const playerId = await ingestionRepo.ensurePlayerStub(connection, participant.tag, participant.name, fetchRunId);
      resolved.push({
        tag: participant.tag,
        name: participant.name,
        playerId,
        brawlerId: brawler.id,
        power: participant.brawlerPower,
        trophies: participant.brawlerTrophies,
      });
    }
    resolvedTeams.push(resolved);
  }

  if (hasUnknownBrawler) {
    await catalogRepo.createIncident(connection, {
      incidentType: "unknown_entity",
      relatedFetchRunId: fetchRunId,
      relatedEntityType: "brawler",
      detail: { reason: "battle referenced a brawler not in canonical_brawlers", battleTime: item.battleTime, mode: item.mode },
    });
    return "quarantined";
  }

  if (resolvedTeams.every((t) => t.length === 0)) {
    return "quarantined";
  }

  const occurredAt = new Date(item.battleTime.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2}).*$/, "$1-$2-$3T$4:$5:$6Z"));
  const occurredAtSafe = Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;

  const battleId = await ingestionRepo.insertNormalizedBattle(
    connection,
    {
      battleKey,
      gameModeId,
      mapId,
      eventSourceId: item.eventSourceId,
      battleType: item.battleType,
      structure: item.structure,
      occurredAt: occurredAtSafe,
      durationSeconds: item.duration,
      trophyChange: item.trophyChange,
      fetchRunId,
    },
    item.results.map((r, index) => ({ teamIndex: index, result: r.result, rank: r.rank }))
  );

  const teamIds = await ingestionRepo.getBattleTeamIds(connection, battleId);

  let participantIndex = 0;
  for (let teamIndex = 0; teamIndex < resolvedTeams.length; teamIndex += 1) {
    const battleTeamId = teamIds.get(teamIndex) ?? null;
    for (const participant of resolvedTeams[teamIndex]) {
      await ingestionRepo.upsertBattleParticipant(connection, {
        battleId,
        battleTeamId,
        playerId: participant.playerId,
        brawlerId: participant.brawlerId,
        brawlerPower: participant.power,
        brawlerTrophies: participant.trophies,
        participantIndex,
        isStarPlayer: item.starPlayerTag === participant.tag,
      });
      participantIndex += 1;

      if (participant.tag !== crawledPlayerTag) {
        await ingestionRepo.recordObservedPlayer(connection, participant.tag, "battle_participant", {
          battleKey,
        });
      }
    }
  }

  await ingestionRepo.insertBattleObservation(connection, battleId, fetchRunId, crawledPlayerTag);
  return "inserted";
}

export async function runBattleLogCrawlBatch(
  triggeredBy: "manual" | "cron",
  batchSize: number = DEFAULT_CRAWL_BATCH_SIZE
): Promise<BattleLogCrawlResult> {
  const pool = getPool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");

  const dataSource = await catalogRepo.getDataSourceByName(pool, DATA_SOURCE_NAME);
  const endpoint = dataSource
    ? await catalogRepo.getSourceEndpoint(pool, dataSource.id, ENDPOINT_CATEGORY.BATTLE_LOG)
    : null;
  if (!dataSource || !dataSource.isEnabled || !endpoint || !endpoint.isEnabled) {
    return { outcome: "prerequisites_missing", playersProcessed: 0, battlesIngested: 0, battlesDeduplicated: 0, battlesQuarantined: 0 };
  }

  const workflowRunId = await startWorkflowRun(pool, workflowDefinitionId, triggeredBy === "cron" ? "schedule" : "manual");
  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  if (!lock.acquired) {
    await completeWorkflowRun(pool, workflowRunId, "failed", "lock_not_acquired");
    return { outcome: "lock_not_acquired", playersProcessed: 0, battlesIngested: 0, battlesDeduplicated: 0, battlesQuarantined: 0 };
  }

  let ingested = 0;
  let deduplicated = 0;
  let quarantined = 0;
  let processed = 0;

  try {
    const leaseConnection = await pool.getConnection();
    let dueTags: string[];
    try {
      await leaseConnection.beginTransaction();
      dueTags = await ingestionRepo.selectAndLeaseDuePlayers(leaseConnection, workflowRunId, batchSize, DEFAULT_LEASE_SECONDS);
      await leaseConnection.commit();
    } catch (error) {
      await leaseConnection.rollback();
      throw error;
    } finally {
      leaseConnection.release();
    }

    if (dueTags.length === 0) {
      await completeWorkflowRun(pool, workflowRunId, "succeeded");
      return { outcome: "no_due_players", workflowRunId, playersProcessed: 0, battlesIngested: 0, battlesDeduplicated: 0, battlesQuarantined: 0 };
    }

    for (const tag of dueTags) {
      const budget = await tryConsumeBudget(pool, "battle_log", false);
      if (!budget.allowed) {
        await ingestionRepo.recordCrawlOutcome(pool, tag, "failure_retryable", 0);
        continue;
      }

      const fetchRunId = await catalogRepo.createFetchRun(pool, {
        dataSourceId: dataSource.id,
        sourceEndpointId: endpoint.id,
        workflowRunId,
        triggerType: triggeredBy,
      });

      const proxyResult = await fetchPlayerBattleLogFromProxy(encodeTagForPath(tag));
      processed += 1;

      if (!proxyResult.proxyReached || proxyResult.httpStatus !== 200) {
        const code = classifyHttpStatus(proxyResult.httpStatus, proxyResult.transportError);
        const failureCount = await ingestionRepo.getConsecutiveFailureCount(pool, tag);
        const decision = decideRetry(code, failureCount + 1);
        const isDead = !decision.shouldRetry || failureCount + 1 >= MAX_CONSECUTIVE_CRAWL_FAILURES;

        await catalogRepo.completeFetchRun(pool, fetchRunId, {
          status: "failed",
          httpStatus: proxyResult.httpStatus,
          errorCode: code,
          changesDetectedCount: 0,
          durationMs: 0,
        });

        if (code === "not_found") {
          await ingestionRepo.markPlayerUnreachable(pool, tag, "not_found");
          await ingestionRepo.recordCrawlOutcome(pool, tag, "failure_dead", 0);
        } else {
          await ingestionRepo.recordCrawlOutcome(
            pool,
            tag,
            isDead ? "failure_dead" : "failure_retryable",
            computeBackoffMs(failureCount + 1)
          );
        }
        continue;
      }

      // The DigitalOcean proxy's envelope nests the official API's data
      // under `payload` (matching /v1/brawlers' contract exactly —
      // { ok, status, fetchedAt, payload: { items } }), never at the top
      // level. validateProxyEnvelope is the same helper lib/catalog/sync.ts
      // and lib/ingestion/sync/rankingSeedSync.ts already use — reused here
      // instead of re-deriving parsing logic per call site (the previous
      // `body.items` read was always undefined against the real envelope,
      // so every successful fetch silently became zero battles).
      const validated = validateProxyEnvelope(proxyResult);
      if (!validated) {
        const failureCount = await ingestionRepo.getConsecutiveFailureCount(pool, tag);
        const isDead = failureCount + 1 >= MAX_CONSECUTIVE_CRAWL_FAILURES;

        await catalogRepo.completeFetchRun(pool, fetchRunId, {
          status: "failed",
          httpStatus: proxyResult.httpStatus,
          errorCode: "invalid_proxy_response",
          changesDetectedCount: 0,
          durationMs: 0,
        });

        await ingestionRepo.recordCrawlOutcome(
          pool,
          tag,
          isDead ? "failure_dead" : "failure_retryable",
          computeBackoffMs(failureCount + 1)
        );
        continue;
      }

      const items = validated.payload.items;
      const { valid, rejected } = validateBattleLogItems(items);

      const payloadJson = stableStringify(items);
      await catalogRepo.insertRawSnapshot(pool, {
        dataFetchRunId: fetchRunId,
        endpointCategory: ENDPOINT_CATEGORY.BATTLE_LOG,
        payload: payloadJson,
        checksum: sha256Hex(payloadJson),
        httpStatus: proxyResult.httpStatus,
        sourceReportedAt: null,
      });

      if (rejected > 0) {
        await catalogRepo.createIncident(pool, {
          incidentType: "invalid_value",
          relatedFetchRunId: fetchRunId,
          relatedEntityType: "battle",
          detail: { rejectedCount: rejected, playerTag: tag },
        });
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const item of valid) {
          const outcome = await processOneBattle(connection, item, tag, fetchRunId);
          if (outcome === "inserted") ingested += 1;
          else if (outcome === "deduplicated") deduplicated += 1;
          else quarantined += 1;
        }
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      await catalogRepo.completeFetchRun(pool, fetchRunId, {
        status: rejected > 0 ? "partial" : "success",
        httpStatus: proxyResult.httpStatus,
        recordsFetched: valid.length,
        changesDetectedCount: 0,
        durationMs: 0,
      });

      await ingestionRepo.recordCrawlOutcome(pool, tag, "success", DEFAULT_RECRAWL_INTERVAL_MS);
    }

    const finalStatus = quarantined > 0 ? "succeeded_with_warnings" : "succeeded";
    await completeWorkflowRun(pool, workflowRunId, finalStatus);

    return {
      outcome: finalStatus,
      workflowRunId,
      playersProcessed: processed,
      battlesIngested: ingested,
      battlesDeduplicated: deduplicated,
      battlesQuarantined: quarantined,
    };
  } catch (error) {
    await completeWorkflowRun(pool, workflowRunId, "failed", error instanceof Error ? error.message : "unknown_error");
    throw error;
  } finally {
    await releaseWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  }
}
