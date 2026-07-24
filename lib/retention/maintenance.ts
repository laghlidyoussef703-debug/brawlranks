/**
 * DATASET Phase 14 — non-archive maintenance paths.
 *
 *  - workflow_locks: ephemeral (never archived). A lock is removable ONLY when it
 *    is expired (or released) AND its owner run is terminal or gone (reconciled).
 *    A lock whose owner run is still active/retryable is NEVER touched.
 *
 *  - normalized_players: NO routine retention deletion. A player is preserved
 *    forever while referenced/active. The only theoretical deletion is an
 *    unreferenced merged DUPLICATE under an explicit, approved identity-merge
 *    process — for which there is no automated evidence source in this schema, so
 *    this module deletes nothing and exposes a guard proving a given player is
 *    NOT safe to delete (active or participant-referenced).
 *
 * Both are dry-run by default; the lock cleanup requires the explicit destructive
 * flag + production guard (shared with lib/retention/graph) to actually delete,
 * uses bounded batches, and is idempotent.
 */

import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { assertDestructiveAllowed } from "./graph";

type Queryable = Pool | PoolConnection;

export const DEFAULT_LOCK_CLEANUP_BATCH = 500;
export const MAX_LOCK_CLEANUP_BATCH = 2000;
/** Workflow statuses that mean the owner run is still live — its lock is untouchable. */
const ACTIVE_WORKFLOW = new Set(["running", "held", "queued", "retrying"]);

export interface LockCleanupResult {
  dryRun: boolean;
  candidates: number;
  deleted: number;
  skippedActiveOwner: number;
}

/** Count/collect a bounded page of removable lock ids (expired/released AND owner terminal-or-gone). */
async function selectRemovableLockIds(db: Queryable, limit: number): Promise<string[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT wl.id
       FROM workflow_locks wl
       LEFT JOIN workflow_runs wr ON wr.id = wl.locked_by_run_id
      WHERE (wl.released_at IS NOT NULL OR wl.expires_at < UTC_TIMESTAMP(3))
        AND (wr.id IS NULL OR wr.status NOT IN ('running','held','queued','retrying'))
      ORDER BY wl.id ASC
      LIMIT ?`,
    [limit]
  );
  return rows.map((r) => r.id as string);
}

/** How many currently-locked rows are held by a still-active owner (never removable) — for reporting. */
async function countActiveOwnerLocks(db: Queryable): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) n
       FROM workflow_locks wl
       JOIN workflow_runs wr ON wr.id = wl.locked_by_run_id
      WHERE wl.released_at IS NULL AND wl.expires_at >= UTC_TIMESTAMP(3)
        AND wr.status IN ('running','held','queued','retrying')`
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Removes stale workflow_locks in bounded batches. Dry-run (default) counts only.
 * A real run requires the destructive flag + production guard. Idempotent: a
 * re-run with nothing stale deletes 0. Never removes a lock whose owner run is
 * still active/retryable.
 */
export async function cleanupExpiredWorkflowLocks(
  db: Pool,
  opts: { dryRun?: boolean; batchSize?: number; env?: Record<string, string | undefined> } = {}
): Promise<LockCleanupResult> {
  const dryRun = opts.dryRun ?? true;
  const batchSize = Math.min(Math.max(1, opts.batchSize ?? DEFAULT_LOCK_CLEANUP_BATCH), MAX_LOCK_CLEANUP_BATCH);
  const skippedActiveOwner = await countActiveOwnerLocks(db);

  if (dryRun) {
    const ids = await selectRemovableLockIds(db, batchSize);
    return { dryRun: true, candidates: ids.length, deleted: 0, skippedActiveOwner };
  }
  assertDestructiveAllowed(opts.env ?? process.env);

  let deleted = 0;
  let candidates = 0;
  for (;;) {
    const ids = await selectRemovableLockIds(db, batchSize);
    if (ids.length === 0) break;
    candidates += ids.length;
    const placeholders = ids.map(() => "?").join(",");
    const [res] = await db.execute<ResultSetHeader>(`DELETE FROM workflow_locks WHERE id IN (${placeholders})`, ids);
    deleted += res.affectedRows;
    if (ids.length < batchSize) break;
  }
  return { dryRun: false, candidates, deleted, skippedActiveOwner };
}

export type PlayerDeletionBlock = "active_or_reachable" | "participant_referenced" | "no_approved_merge_evidence";

export interface PlayerSafeguardResult {
  playerId: string;
  deletable: false;
  blockReasons: PlayerDeletionBlock[];
}

/**
 * normalized_players safeguard: proves a player is NOT safe to routinely delete.
 * Always returns deletable=false — routine retention never removes a player.
 * A real identity-merge deletion is an out-of-band, approved process (there is no
 * automated approved-merge-evidence source in this schema), so this guard exists
 * to make that explicit and to surface the concrete reasons a row is retained.
 */
export async function assessNormalizedPlayerDeletion(db: Queryable, playerId: string): Promise<PlayerSafeguardResult> {
  const blockReasons: PlayerDeletionBlock[] = [];
  const [[player]] = await db.query<RowDataPacket[]>("SELECT is_reachable FROM normalized_players WHERE id = ?", [playerId]);
  if (player && Number(player.is_reachable) === 1) blockReasons.push("active_or_reachable");
  const [[ref]] = await db.query<RowDataPacket[]>("SELECT EXISTS(SELECT 1 FROM battle_participants WHERE player_id = ?) AS r", [playerId]);
  if (Number(ref?.r) === 1) blockReasons.push("participant_referenced");
  // No automated approved identity-merge evidence exists — routine deletion is never authorized here.
  blockReasons.push("no_approved_merge_evidence");
  return { playerId, deletable: false, blockReasons };
}
