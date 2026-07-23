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
 *
 * DURABLE, RESUMABLE EXECUTION (Phase 10 timeout fix — mirrors the aggregation
 * and ranking cron paths). The previous design ran the WHOLE batch (up to
 * `batchSize` players) synchronously in one HTTP request. Each player is a
 * live proxy round-trip to the official API (~18s observed), so a batch of 25
 * ran ~7m47s — far past Hostinger/nginx's ~55s gateway timeout. The client
 * (systemd curl) got a false 504 while the server-side work kept running to
 * completion, creating false failures and overlap risk.
 *
 * It is replaced by the project's existing resumable-slice mechanism
 * (lib/workflow.ts job-cursor + short per-slice lock + stale-run recovery —
 * the identical primitives aggregation/ranking use):
 *
 *   - `stepBattleLogCrawl` is the per-HTTP-call entry point. The FIRST call
 *     for an idle workflow only CLAIMS the job (creates the workflow_run and
 *     its resume cursor) and returns `started` + workflowRunId within
 *     milliseconds — nothing long-running happens before the response. Each
 *     subsequent scheduled call leases and processes ONE small bounded slice
 *     (`MAX_PLAYERS_PER_SLICE`) of due players, advances the persisted cursor,
 *     and returns `in_progress` / `completed`. Every call returns well under
 *     the gateway limit; the scheduler simply calls the endpoint repeatedly
 *     until `completed` (exactly as it already drives aggregation/ranking).
 *   - `runBattleLogCrawlBatch` is a run-to-completion driver (holds the lock
 *     once and loops every slice) for tests / manual / CLI where no request
 *     limit applies; its return shape is unchanged so existing callers stay
 *     compatible.
 *
 * `batchSize` behavior is preserved: it is the total number of due players one
 * JOB processes before completing — exactly what it meant when the old monolith
 * processed the whole batch in a single call — now drained across many slices.
 * Overlap is prevented two ways: the short per-slice workflow_locks entry
 * serializes concurrent calls (a second trigger while a slice is mid-flight
 * gets `lock_not_acquired`), and between slices a resuming call continues the
 * one existing 'running' run rather than starting a second. Abandoned jobs are
 * reclaimed by reconcileStaleWorkflowRuns. Battle ingestion/dedup/quarantine
 * and DigitalOcean write authority are untouched.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection } from "mysql2/promise";
import { getWritePool } from "@/lib/mysql";
import { stableStringify, sha256Hex } from "@/lib/hash";
import { fetchPlayerBattleLogFromProxy, validateProxyEnvelope } from "@/lib/proxy";
import { validateBattleLogItems, type ValidatedBattleItem } from "@/lib/ingestion/schemas";
import { computeBattleKey } from "@/lib/ingestion/battleId";
import { classifyHttpStatus, decideRetry } from "@/lib/ingestion/retry";
import { computeSuccessDelayMs, computeCrawlFailureBackoffMs } from "@/lib/ingestion/cadence";
import { tryConsumeBudget } from "@/lib/ingestion/rateBudget";
import { encodeTagForPath } from "@/lib/ingestion/tags";
import { computeIncidentSignature } from "@/lib/ingestion/incidents";
import { logSafeInfo } from "@/lib/errors";
import {
  ENDPOINT_CATEGORY,
  DATA_SOURCE_NAME,
  DEFAULT_CRAWL_BATCH_SIZE,
  DEFAULT_LEASE_SECONDS,
  MAX_CONSECUTIVE_CRAWL_FAILURES,
} from "@/lib/ingestion/config";
import * as catalogRepo from "@/lib/catalog/repository";
import * as ingestionRepo from "@/lib/ingestion/repository";
import * as patchesRepo from "@/lib/patches/repository";
import {
  ensureWorkflowDefinition,
  acquireWorkflowLock,
  releaseWorkflowLock,
  startWorkflowRun,
  completeWorkflowRun,
  findLatestRunningRun,
  readJobCursor,
  writeJobCursor,
  reconcileStaleWorkflowRuns,
} from "@/lib/workflow";

const WORKFLOW_SLUG = "battle-log-crawl";

/**
 * Players processed per HTTP slice. Each player is a live proxy round-trip to
 * the official API (~18s observed in production), so this is kept deliberately
 * small so one slice — worst case MAX_PLAYERS_PER_SLICE × ~18s — completes
 * comfortably under the ~55s Hostinger/nginx gateway timeout. The full
 * `batchSize` (job total) is drained across as many slices as needed.
 */
const MAX_PLAYERS_PER_SLICE = 2;
/** Per-HTTP-call lock TTL: longer than one bounded slice, shorter than the scheduled resume interval so an abandoned lock frees itself quickly. */
const SLICE_LOCK_TTL_MS = 2 * 60_000;
/** Driver (run-to-completion) lock TTL: covers a whole in-process loop over all slices; used only where no request limit applies. */
const DRIVER_LOCK_TTL_MS = 15 * 60_000;
/** A 'running' job whose heartbeat is older than this is treated as abandoned and reclaimed so a fresh job can start. */
const STALE_JOB_SECONDS = 15 * 60;
/** Sanity cap on driver loop iterations. */
const MAX_DRIVER_SLICES = 1_000_000;

export interface BattleLogCrawlResult {
  outcome: "succeeded" | "succeeded_with_warnings" | "lock_not_acquired" | "prerequisites_missing" | "no_due_players";
  workflowRunId?: string;
  crawlBatchId?: string;
  playersProcessed: number;
  battlesIngested: number;
  battlesDeduplicated: number;
  battlesQuarantined: number;
}

/** Per-HTTP-call result (mirrors AggregationStepResult / ranking's step result). */
export interface BattleLogStepResult {
  status: "started" | "in_progress" | "completed" | "lock_not_acquired" | "prerequisites_missing";
  workflowRunId?: string;
  /** Present on `lock_not_acquired`: the id of the run already in flight (overlap guard). */
  activeWorkflowRunId?: string;
  outcome?: "succeeded" | "succeeded_with_warnings" | "no_due_players";
  playersProcessed?: number;
  battlesIngested?: number;
  battlesDeduplicated?: number;
  battlesQuarantined?: number;
}

/** Resume cursor persisted as JSON in the job's workflow_steps row. */
interface BattleLogCursor {
  /** Total due players this job will process before completing (== `batchSize`). */
  batchSizeTarget: number;
  processedSoFar: number;
  ingested: number;
  deduplicated: number;
  quarantined: number;
  highRejectionRateObserved: boolean;
  /** Resolved once when the job is claimed — every battle in this job is stamped with it (Phase 5.1). */
  activePatchId: string | null;
}

interface SliceOutcome {
  freshStart: boolean;
  done: boolean;
  prerequisitesMissing: boolean;
  workflowRunId?: string;
  outcome?: "succeeded" | "succeeded_with_warnings" | "no_due_players";
  playersProcessed: number;
  battlesIngested: number;
  battlesDeduplicated: number;
  battlesQuarantined: number;
}

async function processOneBattle(
  connection: PoolConnection,
  item: ValidatedBattleItem,
  crawledPlayerTag: string,
  fetchRunId: string,
  /** Phase 5.1 — whichever internal patch was active when this batch run started; null if none has ever been inferred yet. */
  activePatchId: string | null
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
      dataCategory: "battle",
      relatedFetchRunId: fetchRunId,
      relatedEntityType: "brawler",
      detail: { reason: "battle referenced a brawler not in canonical_brawlers", battleTime: item.battleTime, mode: item.mode },
      signature: computeIncidentSignature({
        incidentType: "unknown_entity",
        dataCategory: "battle",
        relatedEntityType: "brawler",
        reasonKey: "battle_unknown_brawler",
      }),
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
      patchId: activePatchId,
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

interface ResolvedPrerequisites {
  dataSourceId: string;
  endpointId: string;
}

async function resolvePrerequisites(pool: Pool): Promise<ResolvedPrerequisites | null> {
  const dataSource = await catalogRepo.getDataSourceByName(pool, DATA_SOURCE_NAME);
  const endpoint = dataSource
    ? await catalogRepo.getSourceEndpoint(pool, dataSource.id, ENDPOINT_CATEGORY.BATTLE_LOG)
    : null;
  if (!dataSource || !dataSource.isEnabled || !endpoint || !endpoint.isEnabled) return null;
  return { dataSourceId: dataSource.id, endpointId: endpoint.id };
}

interface ProcessCounts {
  processed: number;
  ingested: number;
  deduplicated: number;
  quarantined: number;
  highRejectionRateObserved: boolean;
}

/**
 * Runs the 14-step ingestion pipeline for one already-leased set of player
 * tags. Extracted verbatim from the previous monolithic batch loop so the
 * per-slice HTTP path and the run-to-completion driver share identical
 * ingestion / dedup / quarantine / cadence behavior.
 */
async function processLeasedPlayers(
  pool: Pool,
  dueTags: string[],
  prereqs: ResolvedPrerequisites,
  triggeredBy: "manual" | "cron",
  workflowRunId: string,
  activePatchId: string | null
): Promise<ProcessCounts> {
  let ingested = 0;
  let deduplicated = 0;
  let quarantined = 0;
  let processed = 0;
  let highRejectionRateObserved = false;

  for (const tag of dueTags) {
    const budget = await tryConsumeBudget(pool, "battle_log", false);
    if (!budget.allowed) {
      await ingestionRepo.recordCrawlOutcome(pool, tag, "failure_retryable", 0);
      continue;
    }

    const fetchRunId = await catalogRepo.createFetchRun(pool, {
      dataSourceId: prereqs.dataSourceId,
      sourceEndpointId: prereqs.endpointId,
      workflowRunId,
      triggerType: triggeredBy,
      requestContext: { playerTag: tag },
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
          computeCrawlFailureBackoffMs(failureCount + 1)
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
        computeCrawlFailureBackoffMs(failureCount + 1)
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
      const totalItems = rejected + valid.length;
      const rejectionRate = totalItems > 0 ? rejected / totalItems : 0;
      // A high rejection rate (Phase 4.7) is tracked at the batch level
      // and folds into the final workflow status below — distinct from
      // a low, isolated rejection rate, which is recorded but never
      // stops the rest of the crawl.
      if (rejectionRate > 0.5) highRejectionRateObserved = true;

      await catalogRepo.createIncident(pool, {
        incidentType: "invalid_value",
        dataCategory: "battle",
        relatedFetchRunId: fetchRunId,
        relatedEntityType: "battle",
        detail: { rejectedCount: rejected, validCount: valid.length, rejectionRate, playerTag: tag },
        // Deduplicated by root-cause class, not by fetch run — a
        // recurring shape issue increments occurrence_count on one row
        // instead of creating a new incident every crawl cycle.
        signature: computeIncidentSignature({
          incidentType: "invalid_value",
          dataCategory: "battle",
          relatedEntityType: "battle",
          reasonKey: "battle_log_rejected_items",
        }),
      });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const item of valid) {
        const outcome = await processOneBattle(connection, item, tag, fetchRunId, activePatchId);
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

    // Cadence reflects whether this fetch actually produced new battles
    // (Phase 4.4) — an active player is revisited sooner than one whose
    // log came back empty, rather than a flat interval regardless of
    // outcome.
    await ingestionRepo.recordCrawlOutcome(pool, tag, "success", computeSuccessDelayMs(valid.length));
  }

  return { processed, ingested, deduplicated, quarantined, highRejectionRateObserved };
}

function emptySlice(partial: Partial<SliceOutcome>): SliceOutcome {
  return {
    freshStart: false,
    done: false,
    prerequisitesMissing: false,
    playersProcessed: 0,
    battlesIngested: 0,
    battlesDeduplicated: 0,
    battlesQuarantined: 0,
    ...partial,
  };
}

function deriveOutcome(cursor: BattleLogCursor): "succeeded" | "succeeded_with_warnings" | "no_due_players" {
  if (cursor.processedSoFar === 0) return "no_due_players";
  return cursor.quarantined > 0 || cursor.highRejectionRateObserved ? "succeeded_with_warnings" : "succeeded";
}

/** Marks the run complete and returns the terminal slice. A no-due-players job still completes 'succeeded' (its data-side outcome is reported separately). */
async function finalizeBattleLog(pool: Pool, workflowRunId: string, cursor: BattleLogCursor): Promise<SliceOutcome> {
  const outcome = deriveOutcome(cursor);
  const runStatus = outcome === "succeeded_with_warnings" ? "succeeded_with_warnings" : "succeeded";
  await completeWorkflowRun(
    pool,
    workflowRunId,
    runStatus,
    cursor.highRejectionRateObserved ? "high_rejection_rate_observed" : undefined
  );
  logSafeInfo("battle-log-crawl", "job_completed", {
    workflowRunId,
    outcome,
    playersProcessed: cursor.processedSoFar,
    battlesIngested: cursor.ingested,
  });
  return emptySlice({
    done: true,
    workflowRunId,
    outcome,
    playersProcessed: cursor.processedSoFar,
    battlesIngested: cursor.ingested,
    battlesDeduplicated: cursor.deduplicated,
    battlesQuarantined: cursor.quarantined,
  });
}

/**
 * Advances exactly one bounded slice. The caller MUST already hold this
 * workflow's lock (both entry points below do) — this never acquires or
 * releases it, so it is shared by the per-call HTTP path and the driver.
 */
async function executeNextBattleLogSlice(
  pool: Pool,
  workflowDefinitionId: string,
  triggeredBy: "manual" | "cron",
  batchSizeTarget: number
): Promise<SliceOutcome> {
  const running = await findLatestRunningRun(pool, workflowDefinitionId);

  // --- Fresh start: verify prerequisites, then only CLAIM the job (create the
  //     run + cursor) and return immediately. No proxy work happens before the
  //     first response, so the trigger returns within milliseconds. ---
  if (!running) {
    const prereqs = await resolvePrerequisites(pool);
    if (!prereqs) return emptySlice({ prerequisitesMissing: true });

    const activePatchId = await patchesRepo.getActivePatchId(pool);
    const workflowRunId = await startWorkflowRun(pool, workflowDefinitionId, triggeredBy === "cron" ? "schedule" : "manual");
    const cursor: BattleLogCursor = {
      batchSizeTarget,
      processedSoFar: 0,
      ingested: 0,
      deduplicated: 0,
      quarantined: 0,
      highRejectionRateObserved: false,
      activePatchId,
    };
    await writeJobCursor(pool, workflowRunId, cursor);
    logSafeInfo("battle-log-crawl", "job_started", { workflowRunId, batchSize: batchSizeTarget });
    return emptySlice({ freshStart: true, workflowRunId });
  }

  const workflowRunId = running.id;
  const cursor = await readJobCursor<BattleLogCursor>(pool, workflowRunId);
  if (!cursor) {
    // A run that started but never wrote its cursor (crashed in the tiny init
    // window). Fail it so the next call starts a clean job.
    await completeWorkflowRun(pool, workflowRunId, "failed", "missing_cursor");
    return emptySlice({ workflowRunId });
  }

  // Target already met -> finalize.
  if (cursor.processedSoFar >= cursor.batchSizeTarget) {
    return finalizeBattleLog(pool, workflowRunId, cursor);
  }

  const prereqs = await resolvePrerequisites(pool);
  if (!prereqs) {
    // Source/endpoint disabled mid-job: fail the run so it does not wedge.
    await completeWorkflowRun(pool, workflowRunId, "failed", "prerequisites_missing");
    return emptySlice({ workflowRunId, prerequisitesMissing: true });
  }

  const sliceSize = Math.min(MAX_PLAYERS_PER_SLICE, cursor.batchSizeTarget - cursor.processedSoFar);
  const leaseConnection = await pool.getConnection();
  let dueTags: string[];
  try {
    await leaseConnection.beginTransaction();
    dueTags = await ingestionRepo.selectAndLeaseDuePlayers(leaseConnection, workflowRunId, sliceSize, DEFAULT_LEASE_SECONDS);
    await leaseConnection.commit();
  } catch (error) {
    await leaseConnection.rollback();
    throw error;
  } finally {
    leaseConnection.release();
  }

  // No due players -> the queue is drained; the job is done.
  if (dueTags.length === 0) {
    return finalizeBattleLog(pool, workflowRunId, cursor);
  }

  const counts = await processLeasedPlayers(pool, dueTags, prereqs, triggeredBy, workflowRunId, cursor.activePatchId);

  const advanced: BattleLogCursor = {
    ...cursor,
    processedSoFar: cursor.processedSoFar + counts.processed,
    ingested: cursor.ingested + counts.ingested,
    deduplicated: cursor.deduplicated + counts.deduplicated,
    quarantined: cursor.quarantined + counts.quarantined,
    highRejectionRateObserved: cursor.highRejectionRateObserved || counts.highRejectionRateObserved,
  };
  await writeJobCursor(pool, workflowRunId, advanced);
  logSafeInfo("battle-log-crawl", "slice_processed", {
    workflowRunId,
    playersThisSlice: counts.processed,
    processedSoFar: advanced.processedSoFar,
    target: advanced.batchSizeTarget,
  });

  // Reached the target, or the due queue is smaller than the slice (drained) ->
  // finalize now instead of spending an extra call to discover it.
  if (advanced.processedSoFar >= advanced.batchSizeTarget || dueTags.length < sliceSize) {
    return finalizeBattleLog(pool, workflowRunId, advanced);
  }
  return emptySlice({
    workflowRunId,
    playersProcessed: counts.processed,
    battlesIngested: counts.ingested,
    battlesDeduplicated: counts.deduplicated,
    battlesQuarantined: counts.quarantined,
  });
}

function clampBatch(batchSize: number): number {
  if (!Number.isInteger(batchSize) || batchSize <= 0) return DEFAULT_CRAWL_BATCH_SIZE;
  return batchSize;
}

/**
 * Per-HTTP-call entry point (the cron route calls this). Acquires a short
 * slice lock, advances exactly one bounded slice, releases the lock, and
 * reports honest progress. The FIRST call for an idle workflow returns
 * `started` immediately after claiming; a subsequent scheduled call resumes
 * from the persisted cursor; a concurrent call while a slice is mid-flight
 * gets `lock_not_acquired` (the overlap guard — it never starts a second run).
 */
export async function stepBattleLogCrawl(
  triggeredBy: "manual" | "cron",
  batchSize: number = DEFAULT_CRAWL_BATCH_SIZE
): Promise<BattleLogStepResult> {
  const pool = getWritePool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
  await reconcileStaleWorkflowRuns(pool, workflowDefinitionId, STALE_JOB_SECONDS);

  const lockRunId = randomUUID();
  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, lockRunId, SLICE_LOCK_TTL_MS);
  if (!lock.acquired) {
    // A slice is already executing. Surface the in-flight run id (read-only,
    // no lock needed) so the caller can report a safe already_running response.
    const active = await findLatestRunningRun(pool, workflowDefinitionId);
    return { status: "lock_not_acquired", activeWorkflowRunId: active?.id };
  }

  try {
    const r = await executeNextBattleLogSlice(pool, workflowDefinitionId, triggeredBy, clampBatch(batchSize));
    if (r.prerequisitesMissing) return { status: "prerequisites_missing", workflowRunId: r.workflowRunId };
    const status: BattleLogStepResult["status"] = r.freshStart ? "started" : r.done ? "completed" : "in_progress";
    return {
      status,
      workflowRunId: r.workflowRunId,
      outcome: r.outcome,
      playersProcessed: r.playersProcessed,
      battlesIngested: r.battlesIngested,
      battlesDeduplicated: r.battlesDeduplicated,
      battlesQuarantined: r.battlesQuarantined,
    };
  } finally {
    await releaseWorkflowLock(pool, workflowDefinitionId, lockRunId);
  }
}

/**
 * Run-to-completion driver: holds the lock once and loops every slice until
 * the job is done. Intended for tests / manual / CLI — NOT the request-limited
 * HTTP path (use stepBattleLogCrawl there). Return shape is unchanged from the
 * original monolithic implementation, so existing callers stay compatible.
 */
export async function runBattleLogCrawlBatch(
  triggeredBy: "manual" | "cron",
  batchSize: number = DEFAULT_CRAWL_BATCH_SIZE
): Promise<BattleLogCrawlResult> {
  const pool = getWritePool();
  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "scheduled_sync");
  await reconcileStaleWorkflowRuns(pool, workflowDefinitionId, STALE_JOB_SECONDS);

  const lockRunId = randomUUID();
  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, lockRunId, DRIVER_LOCK_TTL_MS);
  if (!lock.acquired) {
    return { outcome: "lock_not_acquired", playersProcessed: 0, battlesIngested: 0, battlesDeduplicated: 0, battlesQuarantined: 0 };
  }

  try {
    let last: SliceOutcome | null = null;
    for (let i = 0; i < MAX_DRIVER_SLICES; i += 1) {
      last = await executeNextBattleLogSlice(pool, workflowDefinitionId, triggeredBy, clampBatch(batchSize));
      if (last.prerequisitesMissing) {
        return { outcome: "prerequisites_missing", workflowRunId: last.workflowRunId, playersProcessed: 0, battlesIngested: 0, battlesDeduplicated: 0, battlesQuarantined: 0 };
      }
      if (last.done) break;
    }
    if (!last || !last.done || !last.outcome) {
      throw new Error("battle-log crawl driver did not converge");
    }
    return {
      outcome: last.outcome,
      workflowRunId: last.workflowRunId,
      playersProcessed: last.playersProcessed,
      battlesIngested: last.battlesIngested,
      battlesDeduplicated: last.battlesDeduplicated,
      battlesQuarantined: last.battlesQuarantined,
    };
  } catch (error) {
    // Fail whichever run is in flight so it does not wedge as 'running'.
    const running = await findLatestRunningRun(pool, workflowDefinitionId);
    if (running) {
      await completeWorkflowRun(pool, running.id, "failed", error instanceof Error ? error.message : "unknown_error");
    }
    throw error;
  } finally {
    await releaseWorkflowLock(pool, workflowDefinitionId, lockRunId);
  }
}
