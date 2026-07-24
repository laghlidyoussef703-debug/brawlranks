/** Archive-gated, resumable child-only Phase 5 deletion executor. */
import type { Pool, PoolConnection } from "mysql2/promise";
import { computeAggregationEligibility, computeRankingEligibility, type RunKind } from "./eligibility";
import {
  fetchEligibilityInputs, deleteChildRowsBatch, countChildRows, getArchivedRunManifest,
  recordDeletionBatch, lastCompletedDeletionCheckpoint, aggregationScope,
  AGGREGATION_CHILD_TABLE, RANKING_CHILD_TABLES, countPassedVerificationEvidence,
} from "./repository";
import { writeTrendSummaries } from "./trend";

type Queryable = Pool | PoolConnection;
export const DEFAULT_DELETION_BATCH_SIZE = 500;
export const MAX_DELETION_BATCH_SIZE = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDestructiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.RETENTION_DESTRUCTIVE_ENABLED === "true";
}
export function validateExactRunAllowlist(values: string[]): string[] {
  if (!Array.isArray(values) || !values.length) throw new Error("missing_exact_allowlist");
  if (values.some((v) => v === "*" || v.toLowerCase() === "all" || !UUID.test(v))) throw new Error("invalid_exact_allowlist");
  return [...new Set(values)];
}

export type DeletionBlockReason = "destructive_disabled" | "not_in_allowlist" | "invalid_target" |
  "not_eligible" | "archive_not_verified" | "verification_evidence_missing" | "reimport_not_passed" |
  "source_count_mismatch" | "trend_preservation_failed";
export interface DeleteRunOptions {
  runKind: RunKind; runId: string; sourceTable: string; allowlist: string[];
  dryRun?: boolean; batchSize?: number; destructiveEnabled?: boolean;
}
export interface DeleteRunResult {
  runKind: RunKind; runId: string; sourceTable: string; dryRun: boolean; proceeded: boolean;
  blockedReason?: DeletionBlockReason; rowsMatched: number; rowsDeleted: number; batches: number;
  checkpoint: string | null; parentMetadataPreserved: true; trendRowsWritten: number;
}

async function eligibleNow(db: Queryable, kind: RunKind, id: string): Promise<boolean> {
  const inputs = await fetchEligibilityInputs(db);
  const rows = kind === "aggregation_run" ? computeAggregationEligibility(inputs) : computeRankingEligibility(inputs);
  return Boolean(rows.find((r) => r.runId === id)?.eligible);
}
async function targetMatches(db: Queryable, kind: RunKind, id: string, table: string): Promise<boolean> {
  if (kind === "ranking_run") return (RANKING_CHILD_TABLES as readonly string[]).includes(table);
  const scope = await aggregationScope(db, id);
  return scope !== null && AGGREGATION_CHILD_TABLE[scope] === table;
}
async function lockParent(db: PoolConnection, kind: RunKind, id: string): Promise<void> {
  const table = kind === "aggregation_run" ? "aggregation_runs" : "ranking_runs";
  await db.query(`SELECT id FROM ${table} WHERE id = ? FOR UPDATE`, [id]);
}

export async function deleteRunChildRows(db: Pool, opts: DeleteRunOptions): Promise<DeleteRunResult> {
  const dryRun = opts.dryRun ?? true;
  const base: DeleteRunResult = { runKind: opts.runKind, runId: opts.runId, sourceTable: opts.sourceTable,
    dryRun, proceeded: false, rowsMatched: 0, rowsDeleted: 0, batches: 0, checkpoint: null,
    parentMetadataPreserved: true, trendRowsWritten: 0 };
  let allowlist: string[];
  try { allowlist = validateExactRunAllowlist(opts.allowlist); } catch { return { ...base, blockedReason: "not_in_allowlist" }; }
  if (!allowlist.includes(opts.runId)) return { ...base, blockedReason: "not_in_allowlist" };
  if (!(await targetMatches(db, opts.runKind, opts.runId, opts.sourceTable))) return { ...base, blockedReason: "invalid_target" };
  if (!(await eligibleNow(db, opts.runKind, opts.runId))) return { ...base, blockedReason: "not_eligible" };
  const matched = await countChildRows(db, opts.sourceTable, opts.runId);
  base.rowsMatched = matched;
  const manifest = await getArchivedRunManifest(db, opts.runKind, opts.runId, opts.sourceTable);
  if (!manifest || manifest.verification_status !== "verified" || Number(manifest.verification_count) < 2) {
    return { ...base, blockedReason: "archive_not_verified" };
  }
  if (await countPassedVerificationEvidence(db, manifest.id) < 2) return { ...base, blockedReason: "verification_evidence_missing" };
  if (manifest.staging_reimport_status !== "passed") return { ...base, blockedReason: "reimport_not_passed" };

  const previous = await lastCompletedDeletionCheckpoint(db, opts.runKind, opts.runId, opts.sourceTable);
  const alreadyDeleted = previous?.deletedRows ?? 0;
  if (matched + alreadyDeleted !== Number(manifest.row_count)) return { ...base, blockedReason: "source_count_mismatch" };
  if (dryRun) return { ...base, proceeded: true, checkpoint: previous?.cursor ?? null };
  if (!(opts.destructiveEnabled ?? isDestructiveEnabled())) return { ...base, blockedReason: "destructive_disabled" };

  let trendRowsWritten = 0;
  if (opts.runKind === "aggregation_run" && opts.sourceTable !== "matchup_aggregates") {
    const scope = opts.sourceTable === "brawler_mode_aggregates" ? "per_mode" : "overall";
    trendRowsWritten = await writeTrendSummaries(db, opts.runId, scope);
    if (matched > 0 && trendRowsWritten === 0) return { ...base, blockedReason: "trend_preservation_failed" };
  }

  // Durable deletion intent exists before the first DELETE.
  await recordDeletionBatch(db, { runKind: opts.runKind, runId: opts.runId, sourceTable: opts.sourceTable,
    batchNumber: 0, batchCursor: previous?.cursor ?? null, attemptedRows: matched, rowsDeleted: 0,
    minPk: null, maxPk: null, dryRun: false, archivedRunManifestId: manifest.id, status: "planned" });

  const batchSize = Math.min(Math.max(1, opts.batchSize ?? DEFAULT_DELETION_BATCH_SIZE), MAX_DELETION_BATCH_SIZE);
  let cursor = previous?.cursor ?? null;
  let batchNumber = previous?.batchNumber ?? 0;
  let totalDeleted = 0;
  for (;;) {
    const conn = await db.getConnection();
    let deleted = 0;
    try {
      await conn.beginTransaction();
      await lockParent(conn, opts.runKind, opts.runId);
      if (!(await eligibleNow(conn, opts.runKind, opts.runId))) throw new Error("reference_or_eligibility_changed");
      const before = await countChildRows(conn, opts.sourceTable, opts.runId);
      if (before + alreadyDeleted + totalDeleted !== Number(manifest.row_count)) throw new Error("source_count_changed");
      const batch = await deleteChildRowsBatch(conn, opts.sourceTable, opts.runId, batchSize, cursor);
      deleted = batch.deleted;
      if (deleted) {
        batchNumber += 1;
        cursor = batch.maxPk;
        await recordDeletionBatch(conn, { runKind: opts.runKind, runId: opts.runId, sourceTable: opts.sourceTable,
          batchNumber, batchCursor: cursor, attemptedRows: deleted, rowsDeleted: deleted,
          minPk: batch.minPk, maxPk: batch.maxPk, dryRun: false, archivedRunManifestId: manifest.id, status: "completed" });
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback().catch(() => {});
      await recordDeletionBatch(db, { runKind: opts.runKind, runId: opts.runId, sourceTable: opts.sourceTable,
        batchNumber: batchNumber + 1, batchCursor: cursor, attemptedRows: 0, rowsDeleted: 0,
        minPk: null, maxPk: null, dryRun: false, archivedRunManifestId: manifest.id,
        status: "failed", failureReason: error instanceof Error ? error.message.slice(0, 255) : "unknown_failure" });
      throw error;
    } finally { conn.release(); }
    if (!deleted) break;
    totalDeleted += deleted;
  }
  if (await countChildRows(db, opts.sourceTable, opts.runId) !== 0 || alreadyDeleted + totalDeleted !== Number(manifest.row_count)) {
    throw new Error("post_delete_count_mismatch");
  }
  await recordDeletionBatch(db, { runKind: opts.runKind, runId: opts.runId, sourceTable: opts.sourceTable,
    batchNumber: 0, batchCursor: cursor, attemptedRows: matched, rowsDeleted: 0,
    minPk: null, maxPk: null, dryRun: false, archivedRunManifestId: manifest.id, status: "completed" });
  return { ...base, proceeded: true, rowsDeleted: totalDeleted, batches: batchNumber - (previous?.batchNumber ?? 0),
    checkpoint: cursor, trendRowsWritten };
}
