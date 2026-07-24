/**
 * DATASET Phase 5 — retention data access (reads + additive writes only).
 *
 * Reads the small metadata/reference inputs for eligibility, counts and pages
 * child rows for archive/deletion, and records holds/manifests. The only rows
 * this module ever DELETEs are child/detail rows, in bounded batches, and only
 * via deleteChildRowsBatch — never run metadata, never via any other path.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import type { EligibilityInputs, RunKind } from "./eligibility";

type Queryable = Pool | PoolConnection;

/** Child detail tables, keyed by the run scope/kind they belong to. */
export const AGGREGATION_CHILD_TABLE: Record<string, string> = {
  per_mode: "brawler_mode_aggregates",
  overall: "brawler_overall_aggregates",
  matchup: "matchup_aggregates",
};
export const RANKING_CHILD_TABLES = ["ranking_results", "matchup_results"] as const;

/** Fixed, code-controlled table/column identifiers allowed in dynamic SQL. */
const ALLOWED_CHILD_TABLES = new Set<string>([
  ...Object.values(AGGREGATION_CHILD_TABLE),
  ...RANKING_CHILD_TABLES,
]);
export function fkColumnFor(table: string): "aggregation_run_id" | "ranking_run_id" {
  if (!ALLOWED_CHILD_TABLES.has(table)) throw new Error(`refusing unknown child table: ${table}`);
  return table.endsWith("_results") ? "ranking_run_id" : "aggregation_run_id";
}

export async function fetchEligibilityInputs(db: Queryable): Promise<EligibilityInputs> {
  const [agg] = await db.query<RowDataPacket[]>(
    "SELECT id, workflow_run_id, scope, status, started_at FROM aggregation_runs ORDER BY id"
  );
  const [rank] = await db.query<RowDataPacket[]>(
    `SELECT id, workflow_run_id, status, mode_aggregation_run_id, overall_aggregation_run_id,
            matchup_aggregation_run_id, started_at FROM ranking_runs ORDER BY id`
  );
  const [wf] = await db.query<RowDataPacket[]>("SELECT id, status FROM workflow_runs ORDER BY id");
  const [snap] = await db.query<RowDataPacket[]>("SELECT ranking_run_id FROM published_snapshots ORDER BY ranking_run_id");
  let holds: RowDataPacket[] = [];
  try {
    [holds] = await db.query<RowDataPacket[]>(
      "SELECT target_kind, target_id FROM retention_holds WHERE released_at IS NULL ORDER BY target_kind, target_id"
    );
  } catch (error) {
    // Read-only planning must work against a pre-0027 restored copy. Missing
    // support schema means no explicit holds could yet exist there; every
    // other SQL error still propagates and fails closed.
    if ((error as { code?: string }).code !== "ER_NO_SUCH_TABLE") throw error;
  }
  return {
    aggregationRuns: agg.map((r) => ({
      id: r.id, workflowRunId: r.workflow_run_id, scope: r.scope, status: r.status, startedAt: new Date(r.started_at),
    })),
    rankingRuns: rank.map((r) => ({
      id: r.id, workflowRunId: r.workflow_run_id, status: r.status,
      modeAggregationRunId: r.mode_aggregation_run_id,
      overallAggregationRunId: r.overall_aggregation_run_id,
      matchupAggregationRunId: r.matchup_aggregation_run_id,
      startedAt: new Date(r.started_at),
    })),
    workflowRuns: wf.map((r) => ({ id: r.id, status: r.status })),
    publishedSnapshots: snap.map((r) => ({ rankingRunId: r.ranking_run_id })),
    openHolds: holds.map((r) => ({ targetKind: r.target_kind, targetId: r.target_id })),
  };
}

/** Scope for an aggregation run id (to pick its child table). */
export async function aggregationScope(db: Queryable, runId: string): Promise<string | null> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT scope FROM aggregation_runs WHERE id = ?", [runId]);
  return rows[0]?.scope ?? null;
}

export async function countChildRows(db: Queryable, table: string, runId: string): Promise<number> {
  const fk = fkColumnFor(table);
  const [rows] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) n FROM ${table} WHERE ${fk} = ?`, [runId]);
  return Number(rows[0].n);
}

export interface ChildRow {
  id: string;
  [key: string]: unknown;
}

export interface ArchiveColumn {
  name: string;
  sqlType: string;
  nullable: boolean;
}

export async function getArchiveColumns(db: Queryable, table: string): Promise<ArchiveColumn[]> {
  fkColumnFor(table);
  const [rows] = await db.query<RowDataPacket[]>(`SHOW COLUMNS FROM \`${table}\``);
  return rows.map((r) => ({
    name: String(r.Field),
    sqlType: String(r.Type).toLowerCase(),
    nullable: String(r.Null).toUpperCase() === "YES",
  }));
}

/** Pages child rows by PK ascending for archive export (read-only). */
export async function selectChildRowsAfter(
  db: Queryable, table: string, runId: string, afterId: string | null, limit: number
): Promise<ChildRow[]> {
  const fk = fkColumnFor(table);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT * FROM ${table} WHERE ${fk} = ? AND id > ? ORDER BY id ASC LIMIT ?`,
    [runId, afterId ?? "", limit]
  );
  return rows as ChildRow[];
}

/**
 * Deletes ONE bounded batch of child rows for a run, ordered by PK. Returns the
 * count and PK bounds of what was deleted. Idempotent: a repeat call when
 * nothing remains deletes 0. Deletes child rows only — never run metadata.
 */
export async function deleteChildRowsBatch(
  db: Queryable, table: string, runId: string, batchSize: number, afterId: string | null = null
): Promise<{ deleted: number; minPk: string | null; maxPk: string | null }> {
  const fk = fkColumnFor(table);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id FROM ${table} WHERE ${fk} = ? AND id > ? ORDER BY id ASC LIMIT ?`,
    [runId, afterId ?? "", batchSize]
  );
  if (rows.length === 0) return { deleted: 0, minPk: null, maxPk: null };
  const ids = rows.map((r) => r.id as string);
  const placeholders = ids.map(() => "?").join(",");
  const [res] = await db.execute<ResultSetHeader>(`DELETE FROM ${table} WHERE id IN (${placeholders})`, ids);
  return { deleted: res.affectedRows, minPk: ids[0], maxPk: ids[ids.length - 1] };
}

// --- holds ---------------------------------------------------------------
export async function createHold(
  db: Queryable, h: { holdType: string; targetKind: string; targetId: string; reason: string; createdBy: string }
): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO retention_holds (id, hold_type, target_kind, target_id, reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, h.holdType, h.targetKind, h.targetId, h.reason, h.createdBy]
  );
  return id;
}
export async function releaseHold(db: Queryable, id: string): Promise<void> {
  await db.execute("UPDATE retention_holds SET released_at = UTC_TIMESTAMP(3) WHERE id = ? AND released_at IS NULL", [id]);
}

// --- archived-run manifests ---------------------------------------------
export interface ArchivedRunManifestInput {
  runKind: RunKind; runId: string; sourceTable: string; schemaVersion: string;
  rowCount: number; minId: string | null; maxId: string | null;
  minCreatedAt: Date | null; maxCreatedAt: Date | null;
  uncompressedBytes: number; archiveBytes: number;
  originalSha256: string; archiveSha256: string;
  codeVersion: string | null; ruleSetVersion: string | null; patchContext: string | null;
  objectProvider: string; objectBucket: string; objectKey: string;
}
export async function insertArchivedRunManifest(db: Queryable, m: ArchivedRunManifestInput): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO archived_run_manifests
       (id, run_kind, run_id, source_table, schema_version, row_count, min_id, max_id,
        min_created_at, max_created_at, uncompressed_bytes, archive_bytes,
        original_sha256, archive_sha256, code_version, rule_set_version, patch_context,
        object_provider, object_bucket, object_key, verification_status, verification_count, staging_reimport_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 'pending')`,
    [id, m.runKind, m.runId, m.sourceTable, m.schemaVersion, m.rowCount, m.minId, m.maxId,
     m.minCreatedAt, m.maxCreatedAt, m.uncompressedBytes, m.archiveBytes,
     m.originalSha256, m.archiveSha256, m.codeVersion, m.ruleSetVersion, m.patchContext,
     m.objectProvider, m.objectBucket, m.objectKey]
  );
  return id;
}
export async function getArchivedRunManifest(db: Queryable, runKind: RunKind, runId: string, sourceTable: string) {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT * FROM archived_run_manifests WHERE run_kind = ? AND run_id = ? AND source_table = ?",
    [runKind, runId, sourceTable]
  );
  return rows[0] ?? null;
}
export async function setManifestVerification(
  db: Queryable, id: string, status: string, count: number, results: unknown = null
): Promise<void> {
  await db.execute(
    "UPDATE archived_run_manifests SET verification_status = ?, verification_count = ?, verification_results = ?, verified_at = IF(? = 'verified', UTC_TIMESTAMP(3), verified_at) WHERE id = ?",
    [status, count, results === null ? null : JSON.stringify(results), status, id]
  );
}
export async function setManifestReimport(db: Queryable, id: string, status: string, result: unknown = null): Promise<void> {
  await db.execute(
    "UPDATE archived_run_manifests SET staging_reimport_status = ?, staging_reimport_result = ? WHERE id = ?",
    [status, result === null ? null : JSON.stringify(result), id]
  );
}

export async function recordVerificationEvidence(
  db: Queryable,
  e: { manifestId: string; passNumber: number; objectSize: number | null; archiveSha256: string | null;
       originalSha256: string | null; rowCount: number | null; result: "passed" | "failed"; failureReason: string | null }
): Promise<void> {
  await db.execute(
    `INSERT INTO archived_run_verification_evidence
       (id, archived_run_manifest_id, pass_number, object_size, archive_sha256,
        original_sha256, row_count, result, failure_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), e.manifestId, e.passNumber, e.objectSize, e.archiveSha256,
     e.originalSha256, e.rowCount, e.result, e.failureReason]
  );
}

export async function countPassedVerificationEvidence(db: Queryable, manifestId: string): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT COUNT(DISTINCT pass_number) n FROM archived_run_verification_evidence WHERE archived_run_manifest_id = ? AND result = 'passed'",
    [manifestId]
  );
  return Number(rows[0].n);
}

export async function hasIsolatedStagingAttestation(db: Queryable, environmentId: string | undefined): Promise<boolean> {
  if (!environmentId || !/^[0-9a-f-]{36}$/i.test(environmentId)) return false;
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) n FROM retention_environment_attestations
      WHERE environment_id = ? AND purpose = 'isolated_staging' AND expires_at > UTC_TIMESTAMP(3)`,
    [environmentId]
  );
  return Number(rows[0].n) === 1;
}

// --- deletion manifests --------------------------------------------------
export async function recordDeletionBatch(
  db: Queryable,
  b: { runKind: RunKind; runId: string; sourceTable: string; batchNumber: number; batchCursor: string | null;
       attemptedRows: number; rowsDeleted: number; minPk: string | null; maxPk: string | null; dryRun: boolean;
       archivedRunManifestId: string | null; status: "planned" | "completed" | "failed"; failureReason?: string | null }
): Promise<void> {
  await db.execute(
    `INSERT INTO retention_deletion_manifests
       (id, run_kind, run_id, source_table, batch_number, batch_cursor, attempted_rows,
        rows_deleted, min_pk, max_pk, dry_run, archived_run_manifest_id, status, completed_at, failure_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, IF(? = 'completed', UTC_TIMESTAMP(3), NULL), ?)
     ON DUPLICATE KEY UPDATE
       batch_cursor = VALUES(batch_cursor), attempted_rows = VALUES(attempted_rows),
       rows_deleted = VALUES(rows_deleted), min_pk = VALUES(min_pk), max_pk = VALUES(max_pk),
       status = VALUES(status), completed_at = VALUES(completed_at), failure_reason = VALUES(failure_reason)`,
    [randomUUID(), b.runKind, b.runId, b.sourceTable, b.batchNumber, b.batchCursor, b.attemptedRows,
     b.rowsDeleted, b.minPk, b.maxPk, b.dryRun ? 1 : 0, b.archivedRunManifestId,
     b.status, b.status, b.failureReason ?? null]
  );
}

export async function lastCompletedDeletionCheckpoint(
  db: Queryable, runKind: RunKind, runId: string, sourceTable: string
): Promise<{ batchNumber: number; cursor: string | null; deletedRows: number } | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT batch_number, batch_cursor,
            (SELECT COALESCE(SUM(rows_deleted),0) FROM retention_deletion_manifests d2
              WHERE d2.run_kind = ? AND d2.run_id = ? AND d2.source_table = ?
                AND d2.dry_run = 0 AND d2.status = 'completed' AND d2.batch_number > 0) deleted_rows
       FROM retention_deletion_manifests
      WHERE run_kind = ? AND run_id = ? AND source_table = ?
        AND dry_run = 0 AND status = 'completed' AND batch_number > 0
      ORDER BY batch_number DESC LIMIT 1`,
    [runKind, runId, sourceTable, runKind, runId, sourceTable]
  );
  if (!rows[0]) return null;
  return { batchNumber: Number(rows[0].batch_number), cursor: rows[0].batch_cursor, deletedRows: Number(rows[0].deleted_rows) };
}
