/**
 * Parameterized SQL access for the Phase 5.2 aggregation layer. Same
 * conventions as every other repository module in this codebase: `?`
 * placeholders, explicit connection parameter, no owned transaction.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { computeWinRate } from "@/lib/aggregation/formulas";

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

export interface ModeAggregateRow {
  brawlerId: string;
  gameModeId: string;
  patchId: string | null;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
}

/**
 * Per (brawler, game_mode, patch) — one row per tuple actually present in
 * the data. `battle_teams.result` is LEFT JOINed (a participant whose team
 * result was never resolved contributes to `matches` but to none of
 * wins/losses/draws — Section 7.4's "unknown" result handling).
 */
export async function computeModeAggregates(db: Queryable): Promise<ModeAggregateRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT bp.brawler_id AS brawlerId, nb.game_mode_id AS gameModeId, nb.patch_id AS patchId,
            COUNT(*) AS matches,
            SUM(CASE WHEN bt.result = 'victory' THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN bt.result = 'defeat' THEN 1 ELSE 0 END) AS losses,
            SUM(CASE WHEN bt.result = 'draw' THEN 1 ELSE 0 END) AS draws
       FROM battle_participants bp
       JOIN normalized_battles nb ON nb.id = bp.battle_id
       LEFT JOIN battle_teams bt ON bt.id = bp.battle_team_id
      WHERE nb.game_mode_id IS NOT NULL
      GROUP BY bp.brawler_id, nb.game_mode_id, nb.patch_id`
  );
  return rows.map((r) => ({
    brawlerId: r.brawlerId,
    gameModeId: r.gameModeId,
    patchId: r.patchId,
    matches: Number(r.matches),
    wins: Number(r.wins),
    losses: Number(r.losses),
    draws: Number(r.draws),
  }));
}

export interface OverallAggregateRow {
  brawlerId: string;
  patchId: string | null;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  modeCoverageCount: number;
}

/** Per (brawler, patch) across every mode combined — Section 7.8/7.12's "overall" scope. */
export async function computeOverallAggregates(db: Queryable): Promise<OverallAggregateRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT bp.brawler_id AS brawlerId, nb.patch_id AS patchId,
            COUNT(*) AS matches,
            SUM(CASE WHEN bt.result = 'victory' THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN bt.result = 'defeat' THEN 1 ELSE 0 END) AS losses,
            SUM(CASE WHEN bt.result = 'draw' THEN 1 ELSE 0 END) AS draws,
            COUNT(DISTINCT nb.game_mode_id) AS modeCoverageCount
       FROM battle_participants bp
       JOIN normalized_battles nb ON nb.id = bp.battle_id
       LEFT JOIN battle_teams bt ON bt.id = bp.battle_team_id
      GROUP BY bp.brawler_id, nb.patch_id`
  );
  return rows.map((r) => ({
    brawlerId: r.brawlerId,
    patchId: r.patchId,
    matches: Number(r.matches),
    wins: Number(r.wins),
    losses: Number(r.losses),
    draws: Number(r.draws),
    modeCoverageCount: Number(r.modeCoverageCount),
  }));
}

export interface MatchupAggregateRow {
  brawlerId: string;
  opponentBrawlerId: string;
  gameModeId: string | null;
  patchId: string | null;
  matches: number;
  wins: number;
  losses: number;
}

/**
 * Per ordered (brawler, opponent, mode, patch) pair — "opponent" is a
 * co-participant on a DIFFERENT, non-null battle_team_id within the same
 * battle (migration 0022's header explains why this is the direct,
 * schema-derived meaning of "opponent," not an invented rule). Mirror
 * matches (same Brawler both sides) are excluded per Section 7.10.
 * Win/loss is read from the FIRST Brawler's own team result, so the
 * inverse pair's row (opponent, brawler) is naturally the mathematically
 * consistent inverse (Section 11.3) without extra logic.
 */
export async function computeMatchupAggregates(db: Queryable): Promise<MatchupAggregateRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT bp1.brawler_id AS brawlerId, bp2.brawler_id AS opponentBrawlerId,
            nb.game_mode_id AS gameModeId, nb.patch_id AS patchId,
            COUNT(*) AS matches,
            SUM(CASE WHEN bt1.result = 'victory' THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN bt1.result = 'defeat' THEN 1 ELSE 0 END) AS losses
       FROM battle_participants bp1
       JOIN battle_participants bp2
         ON bp2.battle_id = bp1.battle_id
        AND bp1.battle_team_id IS NOT NULL
        AND bp2.battle_team_id IS NOT NULL
        AND bp2.battle_team_id <> bp1.battle_team_id
       JOIN normalized_battles nb ON nb.id = bp1.battle_id
       LEFT JOIN battle_teams bt1 ON bt1.id = bp1.battle_team_id
      WHERE bp1.brawler_id <> bp2.brawler_id
      GROUP BY bp1.brawler_id, bp2.brawler_id, nb.game_mode_id, nb.patch_id`
  );
  return rows.map((r) => ({
    brawlerId: r.brawlerId,
    opponentBrawlerId: r.opponentBrawlerId,
    gameModeId: r.gameModeId,
    patchId: r.patchId,
    matches: Number(r.matches),
    wins: Number(r.wins),
    losses: Number(r.losses),
  }));
}

export async function insertModeAggregate(db: Queryable, aggregationRunId: string, row: ModeAggregateRow): Promise<void> {
  await db.execute<ResultSetHeader>(
    `INSERT INTO brawler_mode_aggregates
       (id, aggregation_run_id, brawler_id, game_mode_id, patch_id, matches, wins, losses, draws, win_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      aggregationRunId,
      row.brawlerId,
      row.gameModeId,
      row.patchId,
      row.matches,
      row.wins,
      row.losses,
      row.draws,
      computeWinRate(row.wins, row.losses),
    ]
  );
}

export async function insertOverallAggregate(db: Queryable, aggregationRunId: string, row: OverallAggregateRow): Promise<void> {
  await db.execute<ResultSetHeader>(
    `INSERT INTO brawler_overall_aggregates
       (id, aggregation_run_id, brawler_id, patch_id, matches, wins, losses, draws, win_rate, mode_coverage_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      aggregationRunId,
      row.brawlerId,
      row.patchId,
      row.matches,
      row.wins,
      row.losses,
      row.draws,
      computeWinRate(row.wins, row.losses),
      row.modeCoverageCount,
    ]
  );
}

export async function insertMatchupAggregate(db: Queryable, aggregationRunId: string, row: MatchupAggregateRow): Promise<void> {
  await db.execute<ResultSetHeader>(
    `INSERT INTO matchup_aggregates
       (id, aggregation_run_id, brawler_id, opponent_brawler_id, game_mode_id, patch_id, matches, win_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      aggregationRunId,
      row.brawlerId,
      row.opponentBrawlerId,
      row.gameModeId,
      row.patchId,
      row.matches,
      computeWinRate(row.wins, row.losses),
    ]
  );
}
