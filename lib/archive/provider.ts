/**
 * DATASET Phase 4 — object storage provider abstraction.
 *
 * The archive state machine talks to storage only through this interface, so
 * the exact same claim/upload/verify/replay logic runs against DigitalOcean
 * Spaces (S3-compatible) in production and against an in-memory or local-
 * filesystem provider in tests. No provider implementation hardcodes a
 * credential, and none logs a secret.
 *
 * `headObject` returns the object size only. It deliberately does NOT surface a
 * multipart ETag as if it were a SHA-256 — integrity is proven by re-hashing
 * the downloaded bytes (`getObject`), never by trusting an ETag.
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

export interface PutObjectInput {
  bucket: string;
  key: string;
  body: Buffer;
  contentType?: string;
  /** Non-secret object metadata (snapshot id, category, checksums, timestamps). */
  metadata?: Record<string, string>;
}

export interface HeadObjectResult {
  size: number;
}

export interface ObjectStorageProvider {
  readonly name: string;
  /** Uploads bytes. Overwrite semantics are provider-defined; the state machine
   *  never relies on overwrite — it uses a deterministic key and a DB unique. */
  putObject(input: PutObjectInput): Promise<void>;
  /** Returns size metadata, or null if the object does not exist. */
  headObject(bucket: string, key: string): Promise<HeadObjectResult | null>;
  /** Downloads the full object bytes. Throws ObjectNotFoundError if absent. */
  getObject(bucket: string, key: string): Promise<Buffer>;
}

export class ObjectNotFoundError extends Error {
  constructor(bucket: string, key: string) {
    super(`object not found: ${bucket}/${key}`);
    this.name = "ObjectNotFoundError";
  }
}

/** In-memory provider — for unit tests. Never persists anything. */
export class InMemoryObjectStorage implements ObjectStorageProvider {
  readonly name = "memory";
  private readonly store = new Map<string, { body: Buffer; metadata?: Record<string, string> }>();

  private id(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }

  async putObject(input: PutObjectInput): Promise<void> {
    // Store a copy so external mutation of the buffer can't change stored bytes.
    this.store.set(this.id(input.bucket, input.key), {
      body: Buffer.from(input.body),
      metadata: input.metadata,
    });
  }

  async headObject(bucket: string, key: string): Promise<HeadObjectResult | null> {
    const entry = this.store.get(this.id(bucket, key));
    return entry ? { size: entry.body.byteLength } : null;
  }

  async getObject(bucket: string, key: string): Promise<Buffer> {
    const entry = this.store.get(this.id(bucket, key));
    if (!entry) throw new ObjectNotFoundError(bucket, key);
    return Buffer.from(entry.body);
  }

  /** Test helper: number of stored objects. */
  size(): number {
    return this.store.size;
  }

  /** Test helper: corrupt a stored object's bytes to exercise verification. */
  corrupt(bucket: string, key: string, bytes: Buffer): void {
    this.store.set(this.id(bucket, key), { body: Buffer.from(bytes) });
  }
}

/**
 * Local-filesystem provider — for the end-to-end local proof and tests that
 * want real bytes on disk. Keys are sanitized to stay under the root; a key
 * containing `..` traversal is rejected.
 */
export class LocalFilesystemObjectStorage implements ObjectStorageProvider {
  readonly name = "local-fs";
  constructor(private readonly root: string) {}

  private resolve(bucket: string, key: string): string {
    const full = path.resolve(this.root, bucket, key);
    const base = path.resolve(this.root, bucket);
    if (full !== base && !full.startsWith(base + path.sep)) {
      throw new Error(`unsafe object key escapes bucket root: ${key}`);
    }
    return full;
  }

  async putObject(input: PutObjectInput): Promise<void> {
    const full = this.resolve(input.bucket, input.key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, input.body);
    if (input.metadata) {
      await writeFile(`${full}.meta.json`, JSON.stringify(input.metadata, null, 2), "utf8");
    }
  }

  async headObject(bucket: string, key: string): Promise<HeadObjectResult | null> {
    // resolve() may throw on an unsafe key — that must propagate, not be masked
    // as "not found", so it is computed before the try.
    const full = this.resolve(bucket, key);
    try {
      const s = await stat(full);
      return { size: s.size };
    } catch {
      return null;
    }
  }

  async getObject(bucket: string, key: string): Promise<Buffer> {
    const full = this.resolve(bucket, key);
    try {
      return await readFile(full);
    } catch {
      throw new ObjectNotFoundError(bucket, key);
    }
  }
}
