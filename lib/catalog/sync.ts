/**
 * Canonical Brawler catalog sync orchestrator — the full vertical slice
 * from BRAWLRANKS_WEBSITE_SPEC.md Section 7 / 7.6 / 8:
 *
 *   official API -> proxy -> tracked fetch run -> immutable raw snapshot
 *   -> validation -> canonical normalization -> normalized snapshot
 *   -> change detection -> successful completion
 *
 * The whole normalize/detect/upsert phase runs inside one transaction: a
 * failure anywhere in that phase rolls back to zero partial application,
 * so a retried sync is always safe (idempotent) rather than picking up
 * half-applied state.
 *
 * The raw fetch, proxy call, and payload validation happen BEFORE the
 * transaction opens (they involve no writes that need atomicity with the
 * canonical upserts) but the raw snapshot itself, the fetch-run/workflow
 * bookkeeping, and every canonical/normalized/change-detection write all
 * happen inside the single transaction described above.
 */

import { getWritePool } from "@/lib/mysql";
import { sha256Hex, stableStringify } from "@/lib/hash";
import { fetchBrawlersFromProxy, validateProxyEnvelope } from "@/lib/proxy";
import { validateBrawlersPayload } from "@/lib/catalog/schema";
import { normalizeBrawlerItems, type NormalizedBrawler } from "@/lib/catalog/normalize";
import {
  detectPerEntityChanges,
  detectRemoval,
  detectVolumeAnomaly,
  type DetectedChangeRecord,
} from "@/lib/catalog/changeDetection";
import { generateSlug } from "@/lib/catalog/normalize";
import * as repo from "@/lib/catalog/repository";
import * as patchesRepo from "@/lib/patches/repository";
import { logSafeError } from "@/lib/errors";
import {
  ensureWorkflowDefinition,
  acquireWorkflowLock,
  releaseWorkflowLock,
  startWorkflowRun,
  completeWorkflowRun,
  recordWorkflowStep,
} from "@/lib/workflow";

const WORKFLOW_SLUG = "catalog-sync-brawlers";
const DATA_SOURCE_NAME = "official-brawl-stars-api";
const ENDPOINT_CATEGORY = "brawlers_catalog";
const ENTITY_TYPE = "brawler";

export interface CatalogSyncResult {
  outcome:
    | "succeeded"
    | "succeeded_with_warnings"
    | "held"
    | "failed"
    | "lock_not_acquired"
    | "prerequisites_missing";
  workflowRunId?: string;
  fetchRunId?: string;
  message: string;
  recordsFetched?: number;
  changesDetected?: number;
  rejectedCount?: number;
}

export async function runCatalogSync(
  triggeredBy: "manual" | "cron",
  triggeredByActor?: string
): Promise<CatalogSyncResult> {
  const pool = getWritePool();

  const workflowDefinitionId = await ensureWorkflowDefinition(pool, WORKFLOW_SLUG, "data_sync");

  const dataSource = await repo.getDataSourceByName(pool, DATA_SOURCE_NAME);
  if (!dataSource || !dataSource.isEnabled) {
    return {
      outcome: "prerequisites_missing",
      message:
        `Data source "${DATA_SOURCE_NAME}" is not registered or is disabled — ` +
        "run scripts/seed-catalog-source.mjs first.",
    };
  }

  const endpoint = await repo.getSourceEndpoint(pool, dataSource.id, ENDPOINT_CATEGORY);
  if (!endpoint || !endpoint.isEnabled) {
    return {
      outcome: "prerequisites_missing",
      message:
        `Source endpoint "${ENDPOINT_CATEGORY}" is not registered or is disabled — ` +
        "run scripts/seed-catalog-source.mjs first.",
    };
  }

  // workflow_runs.triggered_by and data_fetch_runs.trigger_type use two
  // different vocabularies (Section 25.2's separate CHECK constraints:
  // 'schedule'/'event'/'manual' vs 'manual'/'cron'/'api') — "cron" maps to
  // workflow_runs' "schedule", but is passed through as-is to the fetch run.
  const workflowTriggeredBy = triggeredBy === "cron" ? "schedule" : "manual";
  const workflowRunId = await startWorkflowRun(pool, workflowDefinitionId, workflowTriggeredBy, triggeredByActor);

  const lock = await acquireWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  if (!lock.acquired) {
    await completeWorkflowRun(pool, workflowRunId, "failed", "lock_not_acquired");
    return {
      outcome: "lock_not_acquired",
      workflowRunId,
      message: "Another catalog sync run is already in progress. Try again shortly.",
    };
  }

  try {
    const proxyResult = await fetchBrawlersFromProxy();
    if (!proxyResult.proxyReached) {
      await completeWorkflowRun(pool, workflowRunId, "failed", "proxy_unreachable");
      await recordWorkflowStep(pool, workflowRunId, "fetch_from_proxy", 1, "failed", undefined, "proxy_unreachable");
      return { outcome: "failed", workflowRunId, message: "Could not reach the DigitalOcean proxy." };
    }

    const validated = validateProxyEnvelope(proxyResult);
    if (!validated) {
      await completeWorkflowRun(pool, workflowRunId, "failed", "invalid_proxy_response");
      await recordWorkflowStep(
        pool,
        workflowRunId,
        "fetch_from_proxy",
        1,
        "failed",
        undefined,
        "invalid_proxy_response"
      );
      return { outcome: "failed", workflowRunId, message: "Proxy response failed envelope validation." };
    }
    await recordWorkflowStep(pool, workflowRunId, "fetch_from_proxy", 1, "succeeded");

    const fetchRunId = await repo.createFetchRun(pool, {
      dataSourceId: dataSource.id,
      sourceEndpointId: endpoint.id,
      workflowRunId,
      triggerType: triggeredBy,
    });

    const payloadJson = stableStringify(validated.payload);
    const payloadChecksum = sha256Hex(payloadJson);
    const items = Array.isArray(validated.payload.items) ? validated.payload.items : [];

    const { valid, rejected } = validateBrawlersPayload(items);
    await recordWorkflowStep(pool, workflowRunId, "validate_payload", 2, "succeeded", {
      validCount: valid.length,
      rejectedCount: rejected.length,
    });

    const connection = await pool.getConnection();
    let changesDetectedCount = 0;

    try {
      await connection.beginTransaction();

      await repo.insertRawSnapshot(connection, {
        dataFetchRunId: fetchRunId,
        endpointCategory: ENDPOINT_CATEGORY,
        payload: payloadJson,
        checksum: payloadChecksum,
        httpStatus: validated.officialApiStatus,
        sourceReportedAt: new Date(validated.fetchedAt),
      });

      const previousAcceptedIds = await repo.getAllAcceptedEntityIds(connection, ENTITY_TYPE);
      const newEntityIds = valid.map((item) => item.id);
      const volumeAnomaly = detectVolumeAnomaly(previousAcceptedIds, newEntityIds);

      if (volumeAnomaly.shouldBlockAcceptance && volumeAnomaly.incident) {
        await repo.createIncident(connection, {
          incidentType: volumeAnomaly.incident.changeType === "missing_source_data"
            ? "partial_payload"
            : "volume_collapse",
          relatedFetchRunId: fetchRunId,
          relatedEntityType: ENTITY_TYPE,
          detail: {
            previousCount: previousAcceptedIds.length,
            newCount: newEntityIds.length,
            reason: volumeAnomaly.incident.changeType,
          },
        });
        await connection.commit();

        await repo.completeFetchRun(pool, fetchRunId, {
          status: "partial",
          httpStatus: validated.officialApiStatus,
          schemaVersion: "v1",
          errorCode: volumeAnomaly.incident.changeType,
          errorMessage: "Run held: volume anomaly exceeded safe-acceptance threshold.",
          recordsFetched: valid.length,
          changesDetectedCount: 0,
          durationMs: 0,
        });
        await completeWorkflowRun(pool, workflowRunId, "held", volumeAnomaly.incident.changeType);
        await recordWorkflowStep(pool, workflowRunId, "apply_canonical_changes", 3, "skipped", undefined, "volume_anomaly");

        return {
          outcome: "held",
          workflowRunId,
          fetchRunId,
          message: "Run held for review: volume anomaly (see data_incidents).",
          recordsFetched: valid.length,
          rejectedCount: rejected.length,
        };
      }

      const normalizedCandidates = normalizeBrawlerItems(valid);
      const allChanges: DetectedChangeRecord[] = [];

      for (const candidate of normalizedCandidates) {
        const previousAccepted = await repo.getLastAccepted(connection, ENTITY_TYPE, candidate.entityId);
        const previousParsed = previousAccepted
          ? (JSON.parse(previousAccepted.normalizedPayloadJson) as NormalizedBrawler)
          : null;

        const changes = detectPerEntityChanges(
          candidate,
          previousAccepted && previousParsed
            ? {
                entityId: candidate.entityId,
                normalized: previousParsed,
                payloadChecksum: previousAccepted.payloadChecksum,
              }
            : null
        );

        await repo.insertNormalizedSnapshot(connection, {
          dataFetchRunId: fetchRunId,
          entityType: ENTITY_TYPE,
          entityId: candidate.entityId,
          normalizedPayloadJson: candidate.normalizedPayloadJson,
          payloadChecksum: candidate.payloadChecksum,
          accept: true,
        });

        const existing = await repo.getCanonicalBrawlerBySourceId(connection, candidate.entityId);
        let brawlerId: string;
        if (!existing) {
          brawlerId = await repo.insertCanonicalBrawler(connection, {
            sourceBrawlerId: candidate.entityId,
            slug: generateSlug(candidate.normalized.name),
            name: candidate.normalized.name,
            fetchRunId,
          });
        } else {
          brawlerId = existing.id;
          await repo.updateCanonicalBrawler(connection, {
            brawlerId: existing.id,
            previousName: existing.name,
            newName: candidate.normalized.name,
            fetchRunId,
          });
        }

        for (const gadget of candidate.normalized.gadgets) {
          await repo.upsertGadget(connection, brawlerId, gadget.sourceId, gadget.name);
        }
        await repo.deactivateMissingGadgets(
          connection,
          brawlerId,
          candidate.normalized.gadgets.map((g) => g.sourceId)
        );

        for (const starPower of candidate.normalized.starPowers) {
          await repo.upsertStarPower(connection, brawlerId, starPower.sourceId, starPower.name);
        }
        await repo.deactivateMissingStarPowers(
          connection,
          brawlerId,
          candidate.normalized.starPowers.map((s) => s.sourceId)
        );

        allChanges.push(...changes);
      }

      const removedIds = previousAcceptedIds.filter((id) => !new Set(newEntityIds).has(id));
      for (const removedId of removedIds) {
        const canonical = await repo.getCanonicalBrawlerBySourceId(connection, removedId);
        allChanges.push(detectRemoval(removedId, canonical?.name ?? removedId));
        await repo.deactivateCanonicalBrawler(connection, removedId);
      }

      for (const change of allChanges) {
        await repo.insertDetectedChange(connection, {
          dataFetchRunId: fetchRunId,
          entityType: change.entityType,
          entityId: change.entityId,
          changeType: change.changeType,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          severity: change.severity,
        });
      }
      changesDetectedCount = allChanges.length;

      // Phase 5.1: infer an internal patch boundary from this run's own
      // change-detection output (Section 7.7, scoped down per migration
      // 0020's header — never a fabricated Supercell version). Deliberately
      // wrapped in its own try/catch, separate from the surrounding
      // transaction's error handling: a bug here must never roll back or
      // fail an otherwise-successful catalog sync. A thrown error from a
      // single INSERT/UPDATE statement leaves no partial row behind, so
      // swallowing it here and continuing is safe — the rest of this
      // transaction still commits normally.
      try {
        await patchesRepo.recordInferredPatchIfMeaningful(connection, {
          changeCount: changesDetectedCount,
          fetchRunId,
          changeSummary: allChanges.map((c) => ({
            entityType: c.entityType,
            entityId: c.entityId,
            changeType: c.changeType,
          })),
        });
      } catch (patchError) {
        logSafeError("catalog-sync", "PATCH_INFERENCE_FAILED", patchError);
      }

      if (rejected.length > 0) {
        await repo.createIncident(connection, {
          incidentType: "invalid_value",
          relatedFetchRunId: fetchRunId,
          relatedEntityType: ENTITY_TYPE,
          detail: { rejectedCount: rejected.length, rejected: rejected.slice(0, 20) },
        });
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    await recordWorkflowStep(pool, workflowRunId, "apply_canonical_changes", 3, "succeeded", {
      changesDetectedCount,
    });

    await repo.completeFetchRun(pool, fetchRunId, {
      status: "success",
      httpStatus: validated.officialApiStatus,
      schemaVersion: "v1",
      recordsFetched: valid.length,
      changesDetectedCount,
      durationMs: 0,
    });

    const finalStatus = rejected.length > 0 ? "succeeded_with_warnings" : "succeeded";
    await completeWorkflowRun(pool, workflowRunId, finalStatus);

    return {
      outcome: finalStatus,
      workflowRunId,
      fetchRunId,
      message:
        changesDetectedCount === 0
          ? "Sync completed. No meaningful changes detected."
          : `Sync completed. ${changesDetectedCount} change(s) detected.`,
      recordsFetched: valid.length,
      changesDetected: changesDetectedCount,
      rejectedCount: rejected.length,
    };
  } catch (error) {
    await completeWorkflowRun(pool, workflowRunId, "failed", error instanceof Error ? error.message : "unknown_error");
    throw error;
  } finally {
    await releaseWorkflowLock(pool, workflowDefinitionId, workflowRunId);
  }
}
