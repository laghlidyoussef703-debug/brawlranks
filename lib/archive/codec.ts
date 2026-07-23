/**
 * DATASET Phase 4 — payload compression and integrity hashing.
 *
 * gzip level 6 (Node-native, no external dependency, universally
 * decompressible) plus two independent SHA-256 hashes:
 *   - original checksum : SHA-256 of the raw payload bytes (UTF-8). This is the
 *     same value already stored in raw_api_snapshots.checksum.
 *   - object checksum   : SHA-256 of the COMPRESSED object bytes. This is what
 *     verifies the stored object was not corrupted in transit or at rest. It is
 *     NOT an S3/Spaces multipart ETag.
 */

import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export const GZIP_LEVEL = 6;

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface GzipResult {
  compressed: Buffer;
  originalSize: number;
  objectSize: number;
  originalChecksum: string;
  objectChecksum: string;
}

/**
 * Compresses a payload string (UTF-8) and computes both hashes. The original
 * bytes are hashed as UTF-8 so the result equals the SHA-256 MySQL's
 * SHA2(payload,256) produced over the stored text.
 */
export function gzipPayload(payload: string): GzipResult {
  const originalBytes = Buffer.from(payload, "utf8");
  const compressed = gzipSync(originalBytes, { level: GZIP_LEVEL });
  return {
    compressed,
    originalSize: originalBytes.byteLength,
    objectSize: compressed.byteLength,
    originalChecksum: sha256Hex(originalBytes),
    objectChecksum: sha256Hex(compressed),
  };
}

/** Decompresses gzip object bytes back to the original UTF-8 payload string. */
export function gunzipToString(compressed: Buffer): string {
  return gunzipSync(compressed).toString("utf8");
}

/** Named so callers can reference the compression algorithm identifier. */
export const COMPRESSION_ALGORITHM = "gzip";
