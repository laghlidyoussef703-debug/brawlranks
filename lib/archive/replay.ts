/**
 * DATASET Phase 4 — archive replay (read-only).
 *
 * Resolves an archived snapshot's metadata, downloads the object, verifies BOTH
 * hashes (compressed object checksum, then decompressed original checksum),
 * parses the JSON, and hands the parsed payload to a caller-supplied validator
 * in dry-run / no-write mode. Replay NEVER writes to the database or to storage,
 * and NEVER re-implements normalization rules — the caller passes the existing
 * validator/normalizer (run in no-write mode) as `validate`.
 *
 * It also re-reads raw_api_snapshots to prove the SOURCE payload is unchanged
 * by the archive (same checksum, still present) — the property the Phase 4
 * local proof must demonstrate.
 */

import type { Pool, PoolConnection } from "mysql2/promise";
import { gunzipToString, sha256Hex } from "./codec";
import { getArchiveRow, getRawPayload } from "./repository";
import type { ObjectStorageProvider } from "./provider";

type Queryable = Pool | PoolConnection;

export type ReplayValidator = (payload: unknown, context: { rawSnapshotId: string }) => void | Promise<void>;

export interface ReplayReport {
  rawSnapshotId: string;
  objectKey: string;
  objectChecksumOk: boolean;
  originalChecksumOk: boolean;
  jsonParsed: boolean;
  sourcePayloadUnchanged: boolean;
  validatorRan: boolean;
  ok: boolean;
}

export class ReplayError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

/**
 * Default validator: proves the decompressed payload is valid JSON. Callers who
 * want a full normalization dry-run pass the real normalizer (no-write) instead.
 */
export const jsonStructuralValidator: ReplayValidator = (payload) => {
  if (payload === null || typeof payload !== "object") {
    throw new ReplayError("invalid_payload_shape", "decompressed payload is not a JSON object/array");
  }
};

export interface ReplayOptions {
  validate?: ReplayValidator;
  /** Re-read the source payload and confirm it is unchanged. Default true. */
  assertSourceUnchanged?: boolean;
}

/**
 * Replays a single archived snapshot. Read-only end to end. Throws ReplayError
 * with a safe code on any integrity failure; returns a report on success.
 */
export async function replayArchive(
  db: Queryable,
  provider: ObjectStorageProvider,
  rawSnapshotId: string,
  opts: ReplayOptions = {}
): Promise<ReplayReport> {
  const validate = opts.validate ?? jsonStructuralValidator;
  const assertSourceUnchanged = opts.assertSourceUnchanged ?? true;

  const archive = await getArchiveRow(db, rawSnapshotId);
  if (!archive) throw new ReplayError("archive_row_missing", "no archive row for snapshot");
  if (!archive.objectChecksum) {
    throw new ReplayError("not_verified", "archive has no object checksum (not verified yet)");
  }

  // 1. Download and verify the compressed object checksum.
  const object = await provider.getObject(archive.objectBucket, archive.objectKey);
  const objectChecksumOk = sha256Hex(object) === archive.objectChecksum;
  if (!objectChecksumOk) {
    throw new ReplayError("object_checksum_mismatch", "downloaded object checksum does not match");
  }

  // 2. Decompress and verify the original payload checksum.
  let decompressed: string;
  try {
    decompressed = gunzipToString(object);
  } catch {
    throw new ReplayError("decompress_failed", "object could not be decompressed");
  }
  const originalChecksumOk = sha256Hex(Buffer.from(decompressed, "utf8")) === archive.originalChecksum;
  if (!originalChecksumOk) {
    throw new ReplayError("original_checksum_mismatch", "decompressed payload checksum does not match");
  }

  // 3. Parse JSON.
  let parsed: unknown;
  try {
    parsed = JSON.parse(decompressed);
  } catch {
    throw new ReplayError("json_parse_failed", "decompressed payload is not valid JSON");
  }

  // 4. Prove the SOURCE payload is unchanged by the archive process.
  let sourcePayloadUnchanged = true;
  if (assertSourceUnchanged) {
    const raw = await getRawPayload(db, rawSnapshotId);
    sourcePayloadUnchanged =
      raw !== null &&
      raw.checksum === archive.originalChecksum &&
      sha256Hex(Buffer.from(raw.payload, "utf8")) === archive.originalChecksum;
    if (!sourcePayloadUnchanged) {
      throw new ReplayError("source_payload_changed", "source raw payload no longer matches the archived checksum");
    }
  }

  // 5. Hand the parsed payload to the no-write validator/normalizer.
  await validate(parsed, { rawSnapshotId });

  return {
    rawSnapshotId,
    objectKey: archive.objectKey,
    objectChecksumOk,
    originalChecksumOk,
    jsonParsed: true,
    sourcePayloadUnchanged,
    validatorRan: true,
    ok: true,
  };
}
