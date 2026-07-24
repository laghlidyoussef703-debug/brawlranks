/**
 * Bounded, FK-order-safe retention deletions (Phase 4.8). Every function
 * deletes at most RETENTION_BATCH_SIZE rows per call (a sweep calls each
 * repeatedly until a call returns 0, so a large backlog is worked off over
 * several bounded transactions rather than one long-held lock) and is
 * idempotent (a repeat call with nothing left to delete is a safe no-op).
 *
 * FK dependency order (enforced by the calling order in
 * lib/ingestion/retentionSweep.ts, not just documented here):
 *   1. battle_participants / battle_teams / battle_observations (children of normalized_battles)
 *   2. normalized_battles (now childless for anything past its cutoff)
 *   3. raw_api_snapshots (children of data_fetch_runs)
 *   4. data_fetch_runs (guarded by NOT EXISTS against every table that
 *      stores a "last/first fetch run" pointer — canonical_brawlers,
 *      normalized_players, normalized_clubs, normalized_battles — so a
 *      fetch run still referenced as someone's most-recent fetch is never
 *      deleted even if it's individually old; the FK constraint itself is
 *      the final safety net if this guard ever misses a case)
 *   5. workflow_steps (children of workflow_runs)
 *   6. workflow_runs (guarded the same way against data_fetch_runs.workflow_run_id)
 */

import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

type Queryable = Pool | PoolConnection;

type SqlParam = string | number | Date | null;

async function deleteBatch(
  db: Queryable,
  sql: string,
  params: SqlParam[]
): Promise<number> {
  const [result] = await db.execute<ResultSetHeader>(sql, params);
  return result.affectedRows;
}

export async function countOlderThan(db: Queryable, table: string, dateColumn: string, cutoff: Date): Promise<number> {
  // table/dateColumn are always fixed, code-controlled string literals from
  // the call sites below — never user input — so this is not a SQL
  // injection surface; the cutoff value itself is still a bound parameter.
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${dateColumn} < ?`,
    [cutoff]
  );
  return rows[0]?.count ?? 0;
}

export async function pruneBattleChildrenOlderThan(db: Queryable, cutoff: Date, batchSize: number): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id FROM normalized_battles WHERE occurred_at < ? LIMIT ?",
    [cutoff, batchSize]
  );
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id as string);
  const placeholders = ids.map(() => "?").join(", ");
  await db.execute(`DELETE FROM battle_participants WHERE battle_id IN (${placeholders})`, ids);
  await db.execute(`DELETE FROM battle_teams WHERE battle_id IN (${placeholders})`, ids);
  await db.execute(`DELETE FROM battle_observations WHERE battle_id IN (${placeholders})`, ids);
  return ids.length;
}

export async function pruneNormalizedBattlesOlderThan(db: Queryable, cutoff: Date, batchSize: number): Promise<number> {
  return deleteBatch(db, "DELETE FROM normalized_battles WHERE occurred_at < ? LIMIT ?", [cutoff, batchSize]);
}

/**
 * DATASET Phase 14 CONFLICT NEUTRALIZED — raw_api_snapshots metadata is kept
 * FOREVER; only the payload may ever be removed (set to NULL), and only after a
 * verified external archive + 7-day grace + immediate re-verification. This
 * former "DELETE FROM raw_api_snapshots" is therefore a forbidden operation and
 * is now a hard no-op (returns 0, deletes nothing). The Phase-14-compliant
 * lifecycle lives in lib/retention/rawPayload.ts (`runRawPayloadSweep`), which
 * nulls the payload while preserving the row.
 *
 * `_cutoff`/`_batchSize` are accepted only to preserve the call signature; they
 * are intentionally unused because nothing is deleted here.
 */
export async function pruneRawSnapshotsOlderThan(_db: Queryable, _cutoff: Date, _batchSize: number): Promise<number> {
  return 0;
}

/** NOT EXISTS-guarded: never deletes a fetch run still referenced as an entity's last/first fetch. */
export async function pruneFetchRunsOlderThan(db: Queryable, cutoff: Date, batchSize: number): Promise<number> {
  return deleteBatch(
    db,
    `DELETE FROM data_fetch_runs
      WHERE started_at < ?
        AND NOT EXISTS (SELECT 1 FROM canonical_brawlers cb WHERE cb.last_fetch_run_id = data_fetch_runs.id)
        AND NOT EXISTS (SELECT 1 FROM normalized_players np WHERE np.last_fetch_run_id = data_fetch_runs.id)
        AND NOT EXISTS (SELECT 1 FROM normalized_clubs nc WHERE nc.last_fetch_run_id = data_fetch_runs.id)
        AND NOT EXISTS (SELECT 1 FROM normalized_battles nb WHERE nb.first_observed_fetch_run_id = data_fetch_runs.id)
        AND NOT EXISTS (SELECT 1 FROM raw_api_snapshots ras WHERE ras.data_fetch_run_id = data_fetch_runs.id)
        AND NOT EXISTS (SELECT 1 FROM battle_observations bo WHERE bo.data_fetch_run_id = data_fetch_runs.id)
      LIMIT ?`,
    [cutoff, batchSize]
  );
}

export async function pruneWorkflowStepsOlderThan(db: Queryable, cutoff: Date, batchSize: number): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id FROM workflow_runs WHERE started_at < ? LIMIT ?",
    [cutoff, batchSize]
  );
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id as string);
  const placeholders = ids.map(() => "?").join(", ");
  const [result] = await db.execute<ResultSetHeader>(
    `DELETE FROM workflow_steps WHERE workflow_run_id IN (${placeholders})`,
    ids
  );
  return result.affectedRows;
}

/** NOT EXISTS-guarded against data_fetch_runs.workflow_run_id. */
export async function pruneWorkflowRunsOlderThan(db: Queryable, cutoff: Date, batchSize: number): Promise<number> {
  return deleteBatch(
    db,
    `DELETE FROM workflow_runs
      WHERE started_at < ?
        AND NOT EXISTS (SELECT 1 FROM data_fetch_runs dfr WHERE dfr.workflow_run_id = workflow_runs.id)
        AND NOT EXISTS (SELECT 1 FROM workflow_steps ws WHERE ws.workflow_run_id = workflow_runs.id)
      LIMIT ?`,
    [cutoff, batchSize]
  );
}

export async function pruneResolvedIncidentsOlderThan(db: Queryable, cutoff: Date, batchSize: number): Promise<number> {
  return deleteBatch(
    db,
    "DELETE FROM data_incidents WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < ? LIMIT ?",
    [cutoff, batchSize]
  );
}

export async function pruneUnpromotedObservedPlayersOlderThan(db: Queryable, cutoff: Date, batchSize: number): Promise<number> {
  return deleteBatch(
    db,
    "DELETE FROM observed_players WHERE promoted_to_active = 0 AND first_observed_at < ? LIMIT ?",
    [cutoff, batchSize]
  );
}

export async function prunePlayerNameHistoryOlderThan(db: Queryable, cutoff: Date, batchSize: number): Promise<number> {
  return deleteBatch(db, "DELETE FROM player_name_history WHERE recorded_at < ? LIMIT ?", [cutoff, batchSize]);
}
