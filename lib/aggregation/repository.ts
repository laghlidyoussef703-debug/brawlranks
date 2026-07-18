/**
 * Parameterized SQL access for the Phase 5.2 aggregation layer. Same
 * conventions as every other repository module in this codebase: `?`
 * placeholders, explicit connection parameter, no owned transaction.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

type Queryable = Pool | PoolConnection;

export async function createAggregationRun(
  db: Queryable,
  params: { workflowRunId: string; scope: "overall" | "per_mode" | "matchup" }
): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO aggregation_runs (id, workflow_run_id, scope, status, started_at)
     VALUES (?, ?, ?, 'running', NOW(3))`,
    [id, params.workflowRunId, params.scope]
  );
  return id;
}

export async function completeAggregationRun(
  db: Queryable,
  aggregationRunId: string,
  status: "succeeded" | "succeeded_with_warnings" | "failed",
  brawlersProcessed: number
): Promise<void> {
  await db.execute(
    `UPDATE aggregation_runs SET status = ?, brawlers_processed = ?, completed_at = NOW(3) WHERE id = ?`,
    [status, brawlersProcessed, aggregationRunId]
  );
}

// ---------------------------------------------------------------------------
// Durable batched aggregation (Phase 5 resumable state machine)
// ---------------------------------------------------------------------------
//
// The per-row compute + one-INSERT-per-row loops that made runtime grow with
// the dataset (and eventually blew past the ~60s Hostinger request limit)
// are replaced by set-based `INSERT ... SELECT ... GROUP BY`, partitioned by
// a bounded batch of brawler_ids per HTTP call. Each statement below writes
// every aggregate row for the given brawlers in ONE round trip, and each
// call processes only a small, cursor-advanced slice of brawlers — so a
// single request's work stays bounded no matter how large the dataset grows.
// win_rate is computed in SQL with the exact same "null when no win/loss
// data" semantics as computeWinRate (never a fabricated 0%).

/** Ordered page of active brawler ids after `afterId` (null = from the start) — the resume cursor for every aggregation scope's per-brawler batching. */
export async function getActiveBrawlerIdBatch(db: Queryable, afterId: string | null, limit: number): Promise<string[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id FROM canonical_brawlers
      WHERE is_active = 1 AND (? IS NULL OR id > ?)
      ORDER BY id
      LIMIT ?`,
    [afterId, afterId, limit]
  );
  return rows.map((r) => r.id as string);
}

function inPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export async function insertModeAggregatesForBrawlers(db: Queryable, aggregationRunId: string, brawlerIds: string[]): Promise<void> {
  if (brawlerIds.length === 0) return;
  await db.query(
    `INSERT INTO brawler_mode_aggregates
       (id, aggregation_run_id, brawler_id, game_mode_id, patch_id, matches, wins, losses, draws, win_rate, latest_battle_at)
     SELECT UUID(), ?, bp.brawler_id, nb.game_mode_id, nb.patch_id,
            COUNT(*),
            SUM(CASE WHEN bt.result = 'victory' THEN 1 ELSE 0 END),
            SUM(CASE WHEN bt.result = 'defeat' THEN 1 ELSE 0 END),
            SUM(CASE WHEN bt.result = 'draw' THEN 1 ELSE 0 END),
            CASE WHEN SUM(CASE WHEN bt.result = 'victory' THEN 1 ELSE 0 END) + SUM(CASE WHEN bt.result = 'defeat' THEN 1 ELSE 0 END) > 0
                 THEN SUM(CASE WHEN bt.result = 'victory' THEN 1 ELSE 0 END) /
                      (SUM(CASE WHEN bt.result = 'victory' THEN 1 ELSE 0 END) + SUM(CASE WHEN bt.result = 'defeat' THEN 1 ELSE 0 END))
                 ELSE NULL END,
            MAX(nb.occurred_at)
       FROM battle_participants bp
       JOIN normalized_battles nb ON nb.id = bp.battle_id
       LEFT JOIN battle_teams bt ON bt.id = bp.battle_team_id
      WHERE nb.game_mode_id IS NOT NULL
        AND bp.brawler_id IN (${inPlaceholders(brawlerIds.length)})
      GROUP BY bp.brawler_id, nb.game_mode_id, nb.patch_id`,
    [aggregationRunId, ...brawlerIds]
  );
}

export async function insertOverallAggregatesForBrawlers(db: Queryable, aggregationRunId: string, brawlerIds: string[]): Promise<void> {
  if (brawlerIds.length === 0) return;
  await db.query(
    `INSERT INTO brawler_overall_aggregates
       (id, aggregation_run_id, brawler_id, patch_id, matches, wins, losses, draws, win_rate, mode_coverage_count, latest_battle_at)
     SELECT UUID(), ?, bp.brawler_id, nb.patch_id,
            COUNT(*),
            SUM(CASE WHEN bt.result = 'victory' THEN 1 ELSE 0 END),
            SUM(CASE WHEN bt.result = 'defeat' THEN 1 ELSE 0 END),
            SUM(CASE WHEN bt.result = 'draw' THEN 1 ELSE 0 END),
            CASE WHEN SUM(CASE WHEN bt.result = 'victory' THEN 1 ELSE 0 END) + SUM(CASE WHEN bt.result = 'defeat' THEN 1 ELSE 0 END) > 0
                 THEN SUM(CASE WHEN bt.result = 'victory' THEN 1 ELSE 0 END) /
                      (SUM(CASE WHEN bt.result = 'victory' THEN 1 ELSE 0 END) + SUM(CASE WHEN bt.result = 'defeat' THEN 1 ELSE 0 END))
                 ELSE NULL END,
            COUNT(DISTINCT nb.game_mode_id),
            MAX(nb.occurred_at)
       FROM battle_participants bp
       JOIN normalized_battles nb ON nb.id = bp.battle_id
       LEFT JOIN battle_teams bt ON bt.id = bp.battle_team_id
      WHERE bp.brawler_id IN (${inPlaceholders(brawlerIds.length)})
      GROUP BY bp.brawler_id, nb.patch_id`,
    [aggregationRunId, ...brawlerIds]
  );
}

export async function insertMatchupAggregatesForBrawlers(db: Queryable, aggregationRunId: string, brawlerIds: string[]): Promise<void> {
  if (brawlerIds.length === 0) return;
  // Self-join restricted to this batch's first-side (bp1) brawlers only — the
  // heaviest query in the whole pipeline, now bounded to a handful of
  // brawlers per call. Distinct brawlers per batch means no batch can
  // conflict with another on the unique (brawler, opponent, mode, patch, run)
  // key. Semantics are identical to the pre-batch matchup query.
  await db.query(
    `INSERT INTO matchup_aggregates
       (id, aggregation_run_id, brawler_id, opponent_brawler_id, game_mode_id, patch_id, matches, wins, losses, win_rate, latest_battle_at)
     SELECT UUID(), ?, bp1.brawler_id, bp2.brawler_id, nb.game_mode_id, nb.patch_id,
            COUNT(*),
            SUM(CASE WHEN bt1.result = 'victory' THEN 1 ELSE 0 END),
            SUM(CASE WHEN bt1.result = 'defeat' THEN 1 ELSE 0 END),
            CASE WHEN SUM(CASE WHEN bt1.result = 'victory' THEN 1 ELSE 0 END) + SUM(CASE WHEN bt1.result = 'defeat' THEN 1 ELSE 0 END) > 0
                 THEN SUM(CASE WHEN bt1.result = 'victory' THEN 1 ELSE 0 END) /
                      (SUM(CASE WHEN bt1.result = 'victory' THEN 1 ELSE 0 END) + SUM(CASE WHEN bt1.result = 'defeat' THEN 1 ELSE 0 END))
                 ELSE NULL END,
            MAX(nb.occurred_at)
       FROM battle_participants bp1
       JOIN battle_participants bp2
         ON bp2.battle_id = bp1.battle_id
        AND bp1.battle_team_id IS NOT NULL
        AND bp2.battle_team_id IS NOT NULL
        AND bp2.battle_team_id <> bp1.battle_team_id
       JOIN normalized_battles nb ON nb.id = bp1.battle_id
       LEFT JOIN battle_teams bt1 ON bt1.id = bp1.battle_team_id
      WHERE bp1.brawler_id <> bp2.brawler_id
        AND bp1.brawler_id IN (${inPlaceholders(brawlerIds.length)})
      GROUP BY bp1.brawler_id, bp2.brawler_id, nb.game_mode_id, nb.patch_id`,
    [aggregationRunId, ...brawlerIds]
  );
}

/** Total aggregate rows written for a run (the append-only row count reported as brawlers_processed, preserving the pre-batch semantic of "rows produced"). */
export async function countAggregateRows(db: Queryable, table: "brawler_mode_aggregates" | "brawler_overall_aggregates" | "matchup_aggregates", aggregationRunId: string): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM ${table} WHERE aggregation_run_id = ?`,
    [aggregationRunId]
  );
  return Number(rows[0]?.c ?? 0);
}

/**
 * Set-based reconciliation gate (Section 7.24): counts rows violating the
 * wins+losses(+draws) <= matches invariant for a run — the exact same check
 * reconcileCounts performed per-row, now one query per scope. Battle-level
 * scopes include draws; the matchup scope has no draws dimension.
 */
export async function countReconciliationWarnings(
  db: Queryable,
  scope: "battle" | "matchup",
  table: "brawler_mode_aggregates" | "brawler_overall_aggregates" | "matchup_aggregates",
  aggregationRunId: string
): Promise<number> {
  const predicate =
    scope === "battle"
      ? "wins < 0 OR losses < 0 OR draws < 0 OR matches < 0 OR (wins + losses + draws) > matches"
      : "wins < 0 OR losses < 0 OR matches < 0 OR (wins + losses) > matches";
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM ${table} WHERE aggregation_run_id = ? AND (${predicate})`,
    [aggregationRunId]
  );
  return Number(rows[0]?.c ?? 0);
}
