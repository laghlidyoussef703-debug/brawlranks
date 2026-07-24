/**
 * DATASET Phase 14 — raw_api_snapshots payload lifecycle.
 *
 * Preserves raw snapshot METADATA forever and removes only the heavy `payload`
 * (LONGTEXT), and only once the payload has been durably archived, verified, and
 * has passed a grace period — re-verifying the archived object AND the live
 * payload immediately before removal. Nothing here ever deletes a raw_api_snapshots
 * row; the sole mutation is `payload = NULL` on a fully-gated snapshot.
 *
 * Gates (ALL required before a payload is nulled):
 *   1. an archive row exists for the snapshot (raw_snapshot_archives),
 *   2. its archive_status is 'verified' with a stored object + original SHA-256,
 *   3. verified_at is at least RAW_PAYLOAD_GRACE_DAYS (>= 7) in the past,
 *   4. immediately before removal, a fresh re-verification passes: the stored
 *      object re-hashes to object_checksum, its decompressed bytes re-hash to
 *      original_checksum, AND the LIVE payload re-hashes to original_checksum
 *      (so the archived copy provably matches what is still stored).
 *
 * Safety: dry-run is the default; destructive removal requires the explicit
 * RETENTION_DESTRUCTIVE_ENABLED=true flag (shared with the aggregate/ranking
 * deletion path). Work is bounded per sweep, idempotent (an already-removed or
 * re-scanned snapshot is a no-op skip), resumable (each snapshot commits on its
 * own; a failure of one never nulls or aborts another), and serialized by a
 * workflow lock so two sweeps cannot run concurrently. Every sweep writes a
 * manifest row (candidates / removed / skipped-with-reasons / failed / bytes).
 */

import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { gunzipToString, sha256Hex } from "@/lib/archive/codec";
import type { ObjectStorageProvider } from "@/lib/archive/provider";
import { isDestructiveEnabled } from "./deletion";
import {
  ensureWorkflowDefinition,
  acquireWorkflowLock,
  releaseWorkflowLock,
} from "@/lib/workflow";

type Queryable = Pool | PoolConnection;

/** DATASET Phase 14: "verified archive + 7-day grace". 7 days is the FLOOR; a larger grace is allowed, never a smaller one. */
export const RAW_PAYLOAD_GRACE_DAYS = 7;
export const DEFAULT_RAW_PAYLOAD_BATCH_SIZE = 200;
export const MAX_RAW_PAYLOAD_BATCH_SIZE = 1000;
export const DEFAULT_RAW_PAYLOAD_SCAN_LIMIT = 2000;
const LOCK_SLUG = "retention-raw-payload";
const LOCK_TTL_MS = 10 * 60_000;

export type RawPayloadSkipReason =
  | "no_archive"
  | "archive_not_verified"
  | "archive_incomplete" // verified but missing verified_at or object_checksum
  | "within_grace_period"
  | "payload_already_removed"
  | "reverify_object_missing"
  | "reverify_object_checksum_mismatch"
  | "reverify_decompressed_mismatch"
  | "reverify_live_payload_mismatch"
  | "state_changed_under_lock";

export interface RawPayloadCandidate {
  rawSnapshotId: string;
  objectBucket: string;
  objectKey: string;
  objectChecksum: string;
  originalChecksum: string;
  payloadBytes: number;
}
export interface RawPayloadSkip {
  rawSnapshotId: string;
  reason: RawPayloadSkipReason;
}

export interface RawPayloadPlan {
  generatedAt: string;
  graceDays: number;
  scanLimit: number;
  candidates: RawPayloadCandidate[];
  skipped: RawPayloadSkip[];
  skippedByReason: Record<string, number>;
  totals: { scanned: number; eligible: number; skipped: number; eligibleBytes: number };
}

function effectiveGraceDays(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return RAW_PAYLOAD_GRACE_DAYS;
  // Never allow a grace shorter than the 7-day floor.
  return Math.max(RAW_PAYLOAD_GRACE_DAYS, Math.floor(requested));
}
function clampBatch(n?: number): number {
  if (!Number.isInteger(n) || (n as number) <= 0) return DEFAULT_RAW_PAYLOAD_BATCH_SIZE;
  return Math.min(n as number, MAX_RAW_PAYLOAD_BATCH_SIZE);
}
function clampScan(n?: number): number {
  if (!Number.isInteger(n) || (n as number) <= 0) return DEFAULT_RAW_PAYLOAD_SCAN_LIMIT;
  return Math.min(n as number, 50_000);
}

interface ScanRow {
  rawSnapshotId: string;
  archId: string | null;
  archiveStatus: string | null;
  verifiedAt: Date | null;
  objectChecksum: string | null;
  originalChecksum: string | null;
  objectBucket: string | null;
  objectKey: string | null;
  payloadRemovedAt: Date | null;
  payloadBytes: number;
}

/** A bounded page of snapshots that still hold a payload and are not yet marked removed, with their archive state. */
async function scanRawSnapshots(db: Queryable, scanLimit: number): Promise<ScanRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT s.id AS rawSnapshotId,
            a.raw_snapshot_id AS archId,
            a.archive_status AS archiveStatus,
            a.verified_at AS verifiedAt,
            a.object_checksum AS objectChecksum,
            a.original_checksum AS originalChecksum,
            a.object_bucket AS objectBucket,
            a.object_key AS objectKey,
            a.payload_removed_at AS payloadRemovedAt,
            LENGTH(s.payload) AS payloadBytes
       FROM raw_api_snapshots s
       LEFT JOIN raw_snapshot_archives a ON a.raw_snapshot_id = s.id
      WHERE s.payload IS NOT NULL
        AND (a.raw_snapshot_id IS NULL OR a.payload_removed_at IS NULL)
      ORDER BY s.created_at ASC
      LIMIT ?`,
    [scanLimit]
  );
  return rows.map((r) => ({
    rawSnapshotId: r.rawSnapshotId,
    archId: r.archId ?? null,
    archiveStatus: r.archiveStatus ?? null,
    verifiedAt: r.verifiedAt ?? null,
    objectChecksum: r.objectChecksum ?? null,
    originalChecksum: r.originalChecksum ?? null,
    objectBucket: r.objectBucket ?? null,
    objectKey: r.objectKey ?? null,
    payloadRemovedAt: r.payloadRemovedAt ?? null,
    payloadBytes: Number(r.payloadBytes ?? 0),
  }));
}

/** Classifies one scanned row: an eligible candidate, or a skip with a precise reason. Pure. */
function classify(row: ScanRow, graceCutoff: Date): { candidate?: RawPayloadCandidate; skip?: RawPayloadSkip } {
  if (row.payloadRemovedAt) return { skip: { rawSnapshotId: row.rawSnapshotId, reason: "payload_already_removed" } };
  if (!row.archId) return { skip: { rawSnapshotId: row.rawSnapshotId, reason: "no_archive" } };
  if (row.archiveStatus !== "verified") return { skip: { rawSnapshotId: row.rawSnapshotId, reason: "archive_not_verified" } };
  if (!row.verifiedAt || !row.objectChecksum || !row.originalChecksum || !row.objectBucket || !row.objectKey) {
    return { skip: { rawSnapshotId: row.rawSnapshotId, reason: "archive_incomplete" } };
  }
  if (row.verifiedAt.getTime() > graceCutoff.getTime()) {
    return { skip: { rawSnapshotId: row.rawSnapshotId, reason: "within_grace_period" } };
  }
  return {
    candidate: {
      rawSnapshotId: row.rawSnapshotId,
      objectBucket: row.objectBucket,
      objectKey: row.objectKey,
      objectChecksum: row.objectChecksum,
      originalChecksum: row.originalChecksum,
      payloadBytes: row.payloadBytes,
    },
  };
}

/** READ-ONLY plan of what a payload-removal sweep would do. Zero writes. */
export async function planRawPayloadRemoval(
  db: Queryable,
  opts: { graceDays?: number; scanLimit?: number; now?: Date } = {}
): Promise<RawPayloadPlan> {
  const graceDays = effectiveGraceDays(opts.graceDays);
  const scanLimit = clampScan(opts.scanLimit);
  const now = opts.now ?? new Date();
  const graceCutoff = new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000);

  const rows = await scanRawSnapshots(db, scanLimit);
  const candidates: RawPayloadCandidate[] = [];
  const skipped: RawPayloadSkip[] = [];
  const skippedByReason: Record<string, number> = {};
  for (const row of rows) {
    const { candidate, skip } = classify(row, graceCutoff);
    if (candidate) candidates.push(candidate);
    if (skip) {
      skipped.push(skip);
      skippedByReason[skip.reason] = (skippedByReason[skip.reason] ?? 0) + 1;
    }
  }
  return {
    generatedAt: now.toISOString(),
    graceDays,
    scanLimit,
    candidates,
    skipped,
    skippedByReason,
    totals: {
      scanned: rows.length,
      eligible: candidates.length,
      skipped: skipped.length,
      eligibleBytes: candidates.reduce((n, c) => n + c.payloadBytes, 0),
    },
  };
}

/**
 * Re-verify the archived object AND the live payload for a candidate, RIGHT
 * BEFORE removal. Returns null on success, or the precise skip reason on any
 * mismatch/missing object. Never mutates anything.
 */
async function reverify(
  provider: ObjectStorageProvider,
  candidate: RawPayloadCandidate,
  livePayload: string
): Promise<RawPayloadSkipReason | null> {
  let bytes: Buffer;
  try {
    bytes = await provider.getObject(candidate.objectBucket, candidate.objectKey);
  } catch {
    return "reverify_object_missing";
  }
  if (sha256Hex(bytes) !== candidate.objectChecksum) return "reverify_object_checksum_mismatch";
  let decompressed: string;
  try {
    decompressed = gunzipToString(bytes);
  } catch {
    return "reverify_decompressed_mismatch";
  }
  if (sha256Hex(Buffer.from(decompressed, "utf8")) !== candidate.originalChecksum) return "reverify_decompressed_mismatch";
  // The archived copy must provably equal the payload we are about to drop.
  if (sha256Hex(Buffer.from(livePayload, "utf8")) !== candidate.originalChecksum) return "reverify_live_payload_mismatch";
  return null;
}

export interface RawPayloadSweepOptions {
  graceDays?: number;
  batchSize?: number;
  scanLimit?: number;
  destructiveEnabled?: boolean;
  now?: Date;
  triggeredBy?: "manual" | "cron";
  env?: Record<string, string | undefined>;
}

export interface RawPayloadSweepResult {
  outcome: "dry_run" | "completed" | "destructive_disabled" | "lock_not_acquired";
  dryRun: boolean;
  manifestId: string | null;
  graceDays: number;
  batchSize: number;
  candidates: number;
  removed: number;
  skipped: number;
  failed: number;
  reclaimedBytes: number;
  skippedByReason: Record<string, number>;
  failures: { rawSnapshotId: string; reason: string }[];
}

async function insertManifest(
  db: Queryable,
  m: {
    id: string; workflowRunId: string | null; dryRun: boolean; destructiveEnabled: boolean;
    graceDays: number; batchSize: number; scanLimit: number;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO raw_payload_removal_manifests
       (id, workflow_run_id, dry_run, destructive_enabled, grace_days, batch_size, scan_limit)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.workflowRunId, m.dryRun ? 1 : 0, m.destructiveEnabled ? 1 : 0, m.graceDays, m.batchSize, m.scanLimit]
  );
}
async function finalizeManifest(
  db: Queryable,
  id: string,
  totals: { candidates: number; removed: number; skipped: number; failed: number; reclaimedBytes: number; details: unknown }
): Promise<void> {
  await db.query(
    `UPDATE raw_payload_removal_manifests
        SET candidates = ?, removed = ?, skipped = ?, failed = ?, reclaimed_bytes = ?,
            details = ?, completed_at = UTC_TIMESTAMP(3)
      WHERE id = ?`,
    [totals.candidates, totals.removed, totals.skipped, totals.failed, totals.reclaimedBytes, JSON.stringify(totals.details), id]
  );
}

/**
 * Executes (or, by default, dry-runs) one bounded payload-removal sweep. Dry-run
 * writes only a manifest (no payload is touched). A real sweep requires the
 * explicit destructive flag AND a provider (for the pre-removal re-verification),
 * nulls at most `batchSize` fully-gated payloads, and records a manifest. Never
 * deletes a row; never nulls an unverified/within-grace/failing-reverify payload.
 */
export async function runRawPayloadSweep(
  db: Pool,
  provider: ObjectStorageProvider | null,
  opts: RawPayloadSweepOptions = {}
): Promise<RawPayloadSweepResult> {
  const dryRun = !((opts.destructiveEnabled ?? isDestructiveEnabled(opts.env ?? process.env)) === true);
  const graceDays = effectiveGraceDays(opts.graceDays);
  const batchSize = clampBatch(opts.batchSize);
  const scanLimit = clampScan(opts.scanLimit);

  const base: RawPayloadSweepResult = {
    outcome: dryRun ? "dry_run" : "completed",
    dryRun, manifestId: null, graceDays, batchSize,
    candidates: 0, removed: 0, skipped: 0, failed: 0, reclaimedBytes: 0,
    skippedByReason: {}, failures: [],
  };

  // Serialize sweeps with a workflow lock so two never run at once.
  const workflowDefinitionId = await ensureWorkflowDefinition(db, LOCK_SLUG, "scheduled_sync");
  const lockRunId = randomUUID();
  const lock = await acquireWorkflowLock(db, workflowDefinitionId, lockRunId, LOCK_TTL_MS);
  if (!lock.acquired) return { ...base, outcome: "lock_not_acquired" };

  try {
    const plan = await planRawPayloadRemoval(db, { graceDays, scanLimit, now: opts.now });
    const manifestId = randomUUID();
    await insertManifest(db, {
      id: manifestId, workflowRunId: null, dryRun, destructiveEnabled: !dryRun,
      graceDays, batchSize, scanLimit,
    });
    base.manifestId = manifestId;
    base.candidates = plan.candidates.length;
    const skippedByReason: Record<string, number> = { ...plan.skippedByReason };
    let skipped = plan.skipped.length;

    // Dry-run: report the plan, write nothing but the manifest.
    if (dryRun) {
      await finalizeManifest(db, manifestId, {
        candidates: plan.candidates.length, removed: 0, skipped, failed: 0, reclaimedBytes: 0,
        details: { skippedByReason, note: "dry_run" },
      });
      return { ...base, outcome: "dry_run", skipped, skippedByReason };
    }

    if (!provider) {
      // A real sweep needs the provider for the pre-removal re-verification.
      await finalizeManifest(db, manifestId, { candidates: plan.candidates.length, removed: 0, skipped, failed: 0, reclaimedBytes: 0, details: { error: "archive_provider_required" } });
      throw new Error("archive_provider_required");
    }

    let removed = 0;
    let failed = 0;
    let reclaimedBytes = 0;
    const failures: { rawSnapshotId: string; reason: string }[] = [];

    for (const candidate of plan.candidates.slice(0, batchSize)) {
      const outcome = await removeOnePayload(db, provider, candidate, graceDays, opts.now);
      if (outcome.status === "removed") {
        removed += 1;
        reclaimedBytes += outcome.bytes;
      } else if (outcome.status === "skipped") {
        skipped += 1;
        skippedByReason[outcome.reason] = (skippedByReason[outcome.reason] ?? 0) + 1;
      } else {
        failed += 1;
        failures.push({ rawSnapshotId: candidate.rawSnapshotId, reason: outcome.reason });
      }
    }

    await finalizeManifest(db, manifestId, {
      candidates: plan.candidates.length, removed, skipped, failed, reclaimedBytes,
      details: { skippedByReason, failures },
    });
    return { ...base, outcome: "completed", removed, skipped, failed, reclaimedBytes, skippedByReason, failures };
  } finally {
    await releaseWorkflowLock(db, workflowDefinitionId, lockRunId);
  }
}

type RemoveOutcome =
  | { status: "removed"; bytes: number }
  | { status: "skipped"; reason: RawPayloadSkipReason }
  | { status: "failed"; reason: string };

/**
 * Nulls ONE candidate's payload under a row lock, after re-checking every gate
 * and re-verifying the object + live payload. Each candidate commits on its own
 * so a failure of one never aborts or nulls another (resumable), and a re-run is
 * a no-op skip (idempotent).
 */
async function removeOnePayload(
  db: Pool,
  provider: ObjectStorageProvider,
  candidate: RawPayloadCandidate,
  graceDays: number,
  now?: Date
): Promise<RemoveOutcome> {
  const graceCutoff = new Date((now?.getTime() ?? Date.now()) - graceDays * 24 * 60 * 60 * 1000);
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    // Lock the payload row + its archive row together, and re-read state.
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT s.payload AS payload,
              a.archive_status AS archiveStatus, a.verified_at AS verifiedAt,
              a.object_checksum AS objectChecksum, a.original_checksum AS originalChecksum,
              a.object_bucket AS objectBucket, a.object_key AS objectKey,
              a.payload_removed_at AS payloadRemovedAt
         FROM raw_api_snapshots s
         JOIN raw_snapshot_archives a ON a.raw_snapshot_id = s.id
        WHERE s.id = ?
        FOR UPDATE`,
      [candidate.rawSnapshotId]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return { status: "skipped", reason: "no_archive" };
    }
    const r = rows[0];
    // Re-check every static gate under the lock (state may have changed).
    if (r.payload === null || r.payloadRemovedAt) {
      await conn.rollback();
      return { status: "skipped", reason: "payload_already_removed" };
    }
    if (r.archiveStatus !== "verified" || !r.verifiedAt || !r.objectChecksum || !r.originalChecksum) {
      await conn.rollback();
      return { status: "skipped", reason: "state_changed_under_lock" };
    }
    if (new Date(r.verifiedAt).getTime() > graceCutoff.getTime()) {
      await conn.rollback();
      return { status: "skipped", reason: "within_grace_period" };
    }

    // Re-verify the archived object AND the live payload immediately before removal.
    const liveCandidate: RawPayloadCandidate = {
      ...candidate,
      objectBucket: r.objectBucket,
      objectKey: r.objectKey,
      objectChecksum: r.objectChecksum,
      originalChecksum: r.originalChecksum,
    };
    const reverifyReason = await reverify(provider, liveCandidate, r.payload as string);
    if (reverifyReason) {
      await conn.rollback();
      return { status: "skipped", reason: reverifyReason };
    }

    const bytes = Buffer.byteLength(r.payload as string, "utf8");
    // Null ONLY the payload; metadata (every other column, the row) is preserved.
    const [upd] = await conn.query<ResultSetHeader>(
      "UPDATE raw_api_snapshots SET payload = NULL WHERE id = ? AND payload IS NOT NULL",
      [candidate.rawSnapshotId]
    );
    if (upd.affectedRows !== 1) {
      await conn.rollback();
      return { status: "skipped", reason: "payload_already_removed" };
    }
    await conn.query(
      "UPDATE raw_snapshot_archives SET payload_removed_at = UTC_TIMESTAMP(3) WHERE raw_snapshot_id = ? AND payload_removed_at IS NULL",
      [candidate.rawSnapshotId]
    );
    await conn.commit();
    return { status: "removed", bytes };
  } catch (error) {
    await conn.rollback().catch(() => {});
    return { status: "failed", reason: error instanceof Error ? error.message.slice(0, 120) : "unknown_failure" };
  } finally {
    conn.release();
  }
}
