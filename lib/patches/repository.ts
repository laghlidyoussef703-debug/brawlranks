/**
 * Parameterized SQL access for the `patches` table (Phase 5.1). Same
 * conventions as lib/catalog/repository.ts / lib/ingestion/repository.ts:
 * every statement uses `?` placeholders, every function takes an explicit
 * connection so callers control transaction boundaries.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { stableStringify } from "@/lib/hash";
import { PATCH_SOURCE_INFERRED, shouldCreatePatch, generateVersionLabel } from "@/lib/patches/patchInference";

type Queryable = Pool | PoolConnection;

export interface ActivePatch {
  id: string;
  versionLabel: string;
  detectedAt: Date;
}

export async function getActivePatch(db: Queryable): Promise<ActivePatch | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, version_label, detected_at FROM patches WHERE status = 'active' LIMIT 1"
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, versionLabel: rows[0].version_label, detectedAt: rows[0].detected_at };
}

/** Convenience for callers that only need the id (e.g. stamping a battle's patch_id) — returns null if no patch has ever been inferred yet. */
export async function getActivePatchId(db: Queryable): Promise<string | null> {
  const active = await getActivePatch(db);
  return active?.id ?? null;
}

async function supersedeActivePatch(db: Queryable): Promise<void> {
  await db.execute("UPDATE patches SET status = 'superseded' WHERE status = 'active'");
}

interface CreatePatchParams {
  versionLabel: string;
  detectedAt: Date;
  triggeringFetchRunId: string | null;
  triggeringChangeSummary: unknown;
}

async function createPatch(db: Queryable, params: CreatePatchParams): Promise<string> {
  const id = randomUUID();
  await db.execute<ResultSetHeader>(
    `INSERT INTO patches
       (id, version_label, source, status, detected_at, effective_at, triggering_fetch_run_id, triggering_change_summary)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
    [
      id,
      params.versionLabel,
      PATCH_SOURCE_INFERRED,
      params.detectedAt,
      // effective_at intentionally equals detected_at (migration 0020's
      // header / PHASE5.1 design): without a real official patch-notes
      // source, "when did this actually go live" and "when did
      // BrawlRanks notice" cannot be honestly distinguished.
      params.detectedAt,
      params.triggeringFetchRunId,
      params.triggeringChangeSummary !== undefined ? stableStringify(params.triggeringChangeSummary) : null,
    ]
  );
  return id;
}

export interface RecordInferredPatchParams {
  changeCount: number;
  fetchRunId: string;
  changeSummary: unknown;
  /** Injectable for deterministic tests; defaults to the real current time. */
  now?: Date;
}

/**
 * The one entry point catalog-sync calls (lib/catalog/sync.ts). Returns the
 * new patch id if a patch was created, or null if this run's change count
 * didn't warrant one (Section 8.2's no-change case) — never throws for the
 * "no meaningful change" path, since that's an expected, common outcome,
 * not an error.
 */
export async function recordInferredPatchIfMeaningful(
  db: Queryable,
  params: RecordInferredPatchParams
): Promise<string | null> {
  if (!shouldCreatePatch(params.changeCount)) return null;

  const now = params.now ?? new Date();
  await supersedeActivePatch(db);
  return createPatch(db, {
    versionLabel: generateVersionLabel(now),
    detectedAt: now,
    triggeringFetchRunId: params.fetchRunId,
    triggeringChangeSummary: params.changeSummary,
  });
}
