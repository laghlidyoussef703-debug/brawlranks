/**
 * DATASET Phase 5 — compact trend preservation.
 *
 * Before an aggregation run's per-brawler/per-mode detail is archived and
 * deleted, roll it up into aggregate_trend_summaries so the single-entity time
 * series survives in MySQL forever. Idempotent (INSERT ... ON DUPLICATE KEY
 * UPDATE keyed by the summary's natural scope). matchup PAIR detail is NOT
 * summarized here (too large; archive only) — see migration 0028's header.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

type Queryable = Pool | PoolConnection;

async function runStartedDate(db: Queryable, aggregationRunId: string): Promise<string | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT DATE(started_at) d, scope FROM aggregation_runs WHERE id = ?",
    [aggregationRunId]
  );
  return rows[0] ? rows[0].d : null;
}

/**
 * Writes trend rows for an aggregation run. `scope` selects the source table:
 * 'per_mode' -> brawler_mode_aggregates, 'overall' -> brawler_overall_aggregates.
 * Returns the number of trend rows written/updated.
 */
export async function writeTrendSummaries(db: Queryable, aggregationRunId: string, scope: "per_mode" | "overall"): Promise<number> {
  const summaryDate = await runStartedDate(db, aggregationRunId);
  if (!summaryDate) return 0;

  const source = scope === "per_mode" ? "brawler_mode_aggregates" : "brawler_overall_aggregates";
  const modeExpr = scope === "per_mode" ? "game_mode_id" : "NULL";
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT brawler_id, ${modeExpr} AS game_mode_id, patch_id, matches, wins, losses, draws, win_rate
       FROM ${source} WHERE aggregation_run_id = ?`,
    [aggregationRunId]
  );

  let written = 0;
  for (const r of rows) {
    await db.query(
      `INSERT INTO aggregate_trend_summaries
         (id, summary_date, patch_id, patch_key, brawler_id, game_mode_id, game_mode_key,
          scope, matches, wins, losses, draws, win_rate, source_aggregation_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         matches = VALUES(matches), wins = VALUES(wins), losses = VALUES(losses),
         draws = VALUES(draws), win_rate = VALUES(win_rate),
         source_aggregation_run_id = VALUES(source_aggregation_run_id)`,
      [randomUUID(), summaryDate, r.patch_id, r.patch_id ?? "00000000-0000-0000-0000-000000000000",
       r.brawler_id, r.game_mode_id, r.game_mode_id ?? "00000000-0000-0000-0000-000000000000", scope,
       r.matches, r.wins, r.losses, r.draws, r.win_rate, aggregationRunId]
    );
    written += 1;
  }
  return written;
}
