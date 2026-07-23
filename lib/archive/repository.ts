/**
 * DATASET Phase 4 — raw_snapshot_archives data access.
 *
 * Claim/lease/mark operations for the archive state machine, plus copy-only
 * backfill enqueue and metrics. Every query is bounded. This module NEVER
 * touches raw_api_snapshots.payload except to READ it — no DELETE, no UPDATE to
 * NULL, no retention. The payload always stays present.
 */

import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { buildArchiveKey } from "./keys";
import { ARCHIVE_COMPRESSION } from "./keys";

type Queryable = Pool | PoolConnection;

export interface SnapshotNeedingArchive {
  rawSnapshotId: string;
  dataFetchRunId: string;
  endpointCategory: string;
  checksum: string;
  receivedAt: Date;
  originalSize: number;
}

export interface ClaimedArchive {
  rawSnapshotId: string;
  objectBucket: string;
  objectKey: string;
  originalChecksum: string;
  originalSize: number;
  attemptCount: number;
}

export interface RawSnapshotPayload {
  payload: string;
  checksum: string;
}

export interface ArchiveRow {
  rawSnapshotId: string;
  objectProvider: string;
  objectBucket: string;
  objectKey: string;
  compression: string;
  originalSizeBytes: number;
  objectSizeBytes: number | null;
  originalChecksum: string;
  objectChecksum: string | null;
  archiveStatus: string;
  attemptCount: number;
  payloadRemovedAt: Date | null;
}

/**
 * Copy-only backfill enqueue: creates `pending` archive rows for the oldest
 * raw snapshots that do not yet have one. Oldest-first (created_at ASC). The
 * deterministic object key is computed in one place (keys.ts) from the
 * snapshot's immutable identity. Never removes or nulls a payload.
 *
 * Returns the number of rows enqueued (0 when the backlog is empty).
 */
export async function enqueuePendingArchives(
  db: Queryable,
  opts: { bucket: string; provider: string; limit: number }
): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT s.id AS rawSnapshotId, s.data_fetch_run_id AS dataFetchRunId,
            s.endpoint_category AS endpointCategory, s.checksum AS checksum,
            s.received_at AS receivedAt, LENGTH(s.payload) AS originalSize
       FROM raw_api_snapshots s
       LEFT JOIN raw_snapshot_archives a ON a.raw_snapshot_id = s.id
      WHERE a.raw_snapshot_id IS NULL
      ORDER BY s.created_at ASC
      LIMIT ?`,
    [opts.limit]
  );

  let enqueued = 0;
  for (const row of rows as unknown as SnapshotNeedingArchive[]) {
    const key = buildArchiveKey({
      snapshotId: row.rawSnapshotId,
      dataFetchRunId: row.dataFetchRunId,
      endpointCategory: row.endpointCategory,
      checksum: row.checksum,
      receivedAt: new Date(row.receivedAt),
    });
    // Idempotent: INSERT IGNORE tolerates a concurrent enqueue of the same
    // snapshot (PK) or the same object (unique bucket+key).
    const [res] = await db.query<ResultSetHeader>(
      `INSERT IGNORE INTO raw_snapshot_archives
         (raw_snapshot_id, object_provider, object_bucket, object_key, compression,
          original_size_bytes, original_checksum, archive_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [row.rawSnapshotId, opts.provider, opts.bucket, key, ARCHIVE_COMPRESSION, row.originalSize, row.checksum]
    );
    enqueued += res.affectedRows;
  }
  return enqueued;
}

/**
 * Atomically claims one eligible archive row and leases it to `leaseOwner`.
 * Eligible = pending/failed past next_attempt_at, OR an `uploading` row whose
 * lease expired (abandoned by a dead worker). Uses FOR UPDATE SKIP LOCKED so
 * concurrent workers never claim the same row. Returns null if nothing is due.
 */
export async function claimNextArchive(
  db: Pool,
  opts: { leaseOwner: string; leaseSeconds: number; now?: Date }
): Promise<ClaimedArchive | null> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT raw_snapshot_id, object_bucket, object_key, original_checksum,
              original_size_bytes, attempt_count
         FROM raw_snapshot_archives
        WHERE (archive_status IN ('pending','failed')
               AND (next_attempt_at IS NULL OR next_attempt_at <= UTC_TIMESTAMP(3)))
           OR (archive_status = 'uploading'
               AND lease_expires_at IS NOT NULL AND lease_expires_at <= UTC_TIMESTAMP(3))
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`
    );
    if (rows.length === 0) {
      await conn.commit();
      return null;
    }
    const row = rows[0];
    await conn.query(
      `UPDATE raw_snapshot_archives
          SET archive_status = 'uploading',
              lease_owner = ?,
              lease_expires_at = UTC_TIMESTAMP(3) + INTERVAL ? SECOND,
              upload_started_at = UTC_TIMESTAMP(3),
              attempt_count = attempt_count + 1
        WHERE raw_snapshot_id = ?`,
      [opts.leaseOwner, opts.leaseSeconds, row.raw_snapshot_id]
    );
    await conn.commit();
    return {
      rawSnapshotId: row.raw_snapshot_id,
      objectBucket: row.object_bucket,
      objectKey: row.object_key,
      originalChecksum: row.original_checksum,
      originalSize: Number(row.original_size_bytes),
      attemptCount: Number(row.attempt_count) + 1,
    };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

/** Reads the raw payload + its recorded checksum for a snapshot (READ ONLY). */
export async function getRawPayload(db: Queryable, rawSnapshotId: string): Promise<RawSnapshotPayload | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT payload, checksum FROM raw_api_snapshots WHERE id = ?",
    [rawSnapshotId]
  );
  if (rows.length === 0) return null;
  return { payload: rows[0].payload, checksum: rows[0].checksum };
}

/** Marks an archive row verified. Only the archive row is touched. */
export async function markArchiveVerified(
  db: Queryable,
  opts: { rawSnapshotId: string; objectSize: number; objectChecksum: string }
): Promise<void> {
  await db.query(
    `UPDATE raw_snapshot_archives
        SET archive_status = 'verified',
            object_size_bytes = ?,
            object_checksum = ?,
            archived_at = COALESCE(archived_at, UTC_TIMESTAMP(3)),
            verified_at = UTC_TIMESTAMP(3),
            last_error_code = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL
      WHERE raw_snapshot_id = ?`,
    [opts.objectSize, opts.objectChecksum, opts.rawSnapshotId]
  );
}

/** Marks an archive row failed with a safe error code and a backoff time. */
export async function markArchiveFailed(
  db: Queryable,
  opts: { rawSnapshotId: string; errorCode: string; nextAttemptAt: Date }
): Promise<void> {
  await db.query(
    `UPDATE raw_snapshot_archives
        SET archive_status = 'failed',
            last_error_code = ?,
            next_attempt_at = ?,
            lease_owner = NULL,
            lease_expires_at = NULL
      WHERE raw_snapshot_id = ?`,
    [opts.errorCode.slice(0, 80), opts.nextAttemptAt, opts.rawSnapshotId]
  );
}

/** Reads a single archive row (for replay/diagnostics). */
export async function getArchiveRow(db: Queryable, rawSnapshotId: string): Promise<ArchiveRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT raw_snapshot_id, object_provider, object_bucket, object_key, compression,
            original_size_bytes, object_size_bytes, original_checksum, object_checksum,
            archive_status, attempt_count, payload_removed_at
       FROM raw_snapshot_archives WHERE raw_snapshot_id = ?`,
    [rawSnapshotId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    rawSnapshotId: r.raw_snapshot_id,
    objectProvider: r.object_provider,
    objectBucket: r.object_bucket,
    objectKey: r.object_key,
    compression: r.compression,
    originalSizeBytes: Number(r.original_size_bytes),
    objectSizeBytes: r.object_size_bytes === null ? null : Number(r.object_size_bytes),
    originalChecksum: r.original_checksum,
    objectChecksum: r.object_checksum,
    archiveStatus: r.archive_status,
    attemptCount: Number(r.attempt_count),
    payloadRemovedAt: r.payload_removed_at,
  };
}

export interface ArchiveMetrics {
  pending: number;
  uploading: number;
  verified: number;
  failed: number;
  oldestPendingAgeSeconds: number | null;
  maxAttemptCount: number;
  totalOriginalBytes: number;
  totalObjectBytes: number;
  compressionRatio: number | null;
  verificationFailures: number;
}

/** Reporting metrics for monitoring (DATASET Phase 15 metric set). */
export async function getArchiveMetrics(db: Queryable): Promise<ArchiveMetrics> {
  const [statusRows] = await db.query<RowDataPacket[]>(
    "SELECT archive_status, COUNT(*) n FROM raw_snapshot_archives GROUP BY archive_status"
  );
  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.archive_status] = Number(r.n);

  const [[agg]] = await db.query<RowDataPacket[]>(
    `SELECT
        (SELECT TIMESTAMPDIFF(SECOND, MIN(created_at), UTC_TIMESTAMP(3))
           FROM raw_snapshot_archives WHERE archive_status = 'pending') AS oldestPendingAge,
        (SELECT COALESCE(MAX(attempt_count),0) FROM raw_snapshot_archives) AS maxAttempts,
        (SELECT COALESCE(SUM(original_size_bytes),0) FROM raw_snapshot_archives WHERE archive_status='verified') AS origBytes,
        (SELECT COALESCE(SUM(object_size_bytes),0) FROM raw_snapshot_archives WHERE archive_status='verified') AS objBytes,
        (SELECT COUNT(*) FROM raw_snapshot_archives
          WHERE archive_status='failed'
            AND last_error_code IN ('head_size_mismatch','get_checksum_mismatch','decompressed_checksum_mismatch','object_missing')) AS verifyFailures`
  );

  const totalOriginalBytes = Number(agg.origBytes);
  const totalObjectBytes = Number(agg.objBytes);
  return {
    pending: byStatus.pending ?? 0,
    uploading: byStatus.uploading ?? 0,
    verified: byStatus.verified ?? 0,
    failed: byStatus.failed ?? 0,
    oldestPendingAgeSeconds: agg.oldestPendingAge === null ? null : Number(agg.oldestPendingAge),
    maxAttemptCount: Number(agg.maxAttempts),
    totalOriginalBytes,
    totalObjectBytes,
    compressionRatio: totalObjectBytes > 0 ? totalOriginalBytes / totalObjectBytes : null,
    verificationFailures: Number(agg.verifyFailures),
  };
}
