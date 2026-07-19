/**
 * DATASET Phase 4 — archive copy/verify state machine.
 *
 * Per snapshot: claim+lease -> read payload -> re-verify the existing original
 * checksum -> gzip -> upload -> HEAD (size) -> GET (re-hash compressed AND
 * re-hash decompressed) -> mark verified. Any failure marks the row failed with
 * a safe error code and a capped exponential backoff; an abandoned `uploading`
 * lease is reclaimable by claimNextArchive.
 *
 * HARD INVARIANT: this never removes or nulls a payload. It only reads
 * raw_api_snapshots.payload and writes raw_snapshot_archives metadata. Payload
 * nulling and retention are a separate, later, separately-approved work package.
 */

import type { Pool } from "mysql2/promise";
import { gzipPayload, gunzipToString, sha256Hex, COMPRESSION_ALGORITHM } from "./codec";
import {
  claimNextArchive,
  getRawPayload,
  markArchiveFailed,
  markArchiveVerified,
} from "./repository";
import type { ObjectStorageProvider } from "./provider";
import { ObjectNotFoundError } from "./provider";

export const BASE_BACKOFF_SECONDS = 60;
export const MAX_BACKOFF_SECONDS = 3600;
export const DEFAULT_LEASE_SECONDS = 300;
export const DEFAULT_ARCHIVE_BATCH_SIZE = 25;
export const MAX_ARCHIVE_BATCH_SIZE = 200;

/** Safe, enumerated failure codes — never a raw error message (may hold detail). */
export type ArchiveErrorCode =
  | "snapshot_missing"
  | "original_checksum_mismatch"
  | "upload_failed"
  | "object_missing"
  | "head_size_mismatch"
  | "get_checksum_mismatch"
  | "decompressed_checksum_mismatch"
  | "unexpected_error";

export type ArchiveOutcome =
  | { status: "idle" }
  | { status: "verified"; rawSnapshotId: string; objectSize: number; objectChecksum: string }
  | { status: "failed"; rawSnapshotId: string; errorCode: ArchiveErrorCode; attempt: number };

export function backoffSeconds(attempt: number): number {
  const exp = BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempt - 1);
  return Math.min(MAX_BACKOFF_SECONDS, exp);
}

function nextAttemptAt(attempt: number, now: Date): Date {
  return new Date(now.getTime() + backoffSeconds(attempt) * 1000);
}

export interface ArchiveOneOptions {
  bucket: string;
  leaseOwner: string;
  leaseSeconds?: number;
  /** Verify by downloading and re-hashing the object (GET). Default true. */
  verifyByDownload?: boolean;
  now?: () => Date;
}

/**
 * Advances a single archive row through the state machine. Returns {idle} when
 * nothing is due. Copy-only: the payload is never modified.
 */
export async function archiveOne(
  db: Pool,
  provider: ObjectStorageProvider,
  opts: ArchiveOneOptions
): Promise<ArchiveOutcome> {
  const now = opts.now ?? (() => new Date());
  const leaseSeconds = opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const verifyByDownload = opts.verifyByDownload ?? true;

  const claimed = await claimNextArchive(db, { leaseOwner: opts.leaseOwner, leaseSeconds });
  if (!claimed) return { status: "idle" };

  const fail = async (errorCode: ArchiveErrorCode): Promise<ArchiveOutcome> => {
    await markArchiveFailed(db, {
      rawSnapshotId: claimed.rawSnapshotId,
      errorCode,
      nextAttemptAt: nextAttemptAt(claimed.attemptCount, now()),
    });
    return { status: "failed", rawSnapshotId: claimed.rawSnapshotId, errorCode, attempt: claimed.attemptCount };
  };

  try {
    // 1. Read the payload (never mutate it).
    const raw = await getRawPayload(db, claimed.rawSnapshotId);
    if (!raw) return fail("snapshot_missing");

    // 2. Re-verify the recorded original checksum against the live payload.
    const liveChecksum = sha256Hex(Buffer.from(raw.payload, "utf8"));
    if (liveChecksum !== claimed.originalChecksum || liveChecksum !== raw.checksum) {
      return fail("original_checksum_mismatch");
    }

    // 3. gzip + object checksum.
    const gz = gzipPayload(raw.payload);

    // 4. Upload.
    try {
      await provider.putObject({
        bucket: claimed.objectBucket,
        key: claimed.objectKey,
        body: gz.compressed,
        contentType: "application/gzip",
        metadata: {
          "snapshot-id": claimed.rawSnapshotId,
          "original-sha256": gz.originalChecksum,
          "object-sha256": gz.objectChecksum,
          compression: COMPRESSION_ALGORITHM,
        },
      });
    } catch {
      return fail("upload_failed");
    }

    // 5. HEAD verify (size present + matches).
    const head = await provider.headObject(claimed.objectBucket, claimed.objectKey);
    if (!head) return fail("object_missing");
    if (head.size !== gz.objectSize) return fail("head_size_mismatch");

    // 6. GET verify: re-hash compressed bytes, then decompress and re-hash.
    if (verifyByDownload) {
      let downloaded: Buffer;
      try {
        downloaded = await provider.getObject(claimed.objectBucket, claimed.objectKey);
      } catch (error) {
        return fail(error instanceof ObjectNotFoundError ? "object_missing" : "get_checksum_mismatch");
      }
      if (sha256Hex(downloaded) !== gz.objectChecksum) return fail("get_checksum_mismatch");
      let roundTrip: string;
      try {
        roundTrip = gunzipToString(downloaded);
      } catch {
        return fail("decompressed_checksum_mismatch");
      }
      if (sha256Hex(Buffer.from(roundTrip, "utf8")) !== gz.originalChecksum) {
        return fail("decompressed_checksum_mismatch");
      }
    }

    // 7. Atomically mark verified. Payload remains present.
    await markArchiveVerified(db, {
      rawSnapshotId: claimed.rawSnapshotId,
      objectSize: gz.objectSize,
      objectChecksum: gz.objectChecksum,
    });
    return {
      status: "verified",
      rawSnapshotId: claimed.rawSnapshotId,
      objectSize: gz.objectSize,
      objectChecksum: gz.objectChecksum,
    };
  } catch {
    return fail("unexpected_error");
  }
}

export interface BatchSummary {
  verified: number;
  failed: number;
  processed: number;
}

/**
 * Processes up to `batchSize` archive rows. Stops early when the queue is idle.
 * Bounded and connection-safe (one row at a time).
 */
export async function runArchiveBatch(
  db: Pool,
  provider: ObjectStorageProvider,
  opts: ArchiveOneOptions & { batchSize: number }
): Promise<BatchSummary> {
  const limit = Math.min(Math.max(1, opts.batchSize), MAX_ARCHIVE_BATCH_SIZE);
  const summary: BatchSummary = { verified: 0, failed: 0, processed: 0 };
  for (let i = 0; i < limit; i++) {
    const outcome = await archiveOne(db, provider, opts);
    if (outcome.status === "idle") break;
    summary.processed++;
    if (outcome.status === "verified") summary.verified++;
    else if (outcome.status === "failed") summary.failed++;
  }
  return summary;
}
