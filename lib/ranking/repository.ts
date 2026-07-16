/**
 * Parameterized SQL access for the Phase 5.3 ranking + publication layer.
 *
 * Data-source note (an honest, narrow, documented exception — see the
 * Phase 5.3 report): win_rate/pick_rate/high_rank_win_rate all require
 * Section 7.10's per-player cap and the day-based recency weight, both of
 * which need per-participant granularity that Phase 5.2's collapsed
 * `brawler_overall_aggregates`/`brawler_mode_aggregates` rows do not
 * retain. Those two signals are therefore computed from a bounded,
 * per-Brawler raw query (one query per canonical Brawler, sequential on a
 * single connection — never concurrent, matching lib/dbConcurrency.ts's
 * pool-safety lesson). Matchup classification and the "does a valid
 * aggregation exist" precondition gate genuinely do read only the latest
 * successful aggregation run (`matchup_aggregates`/`aggregation_runs`),
 * exactly as instructed.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

type Queryable = Pool | PoolConnection;

// ---------------------------------------------------------------------------
// Aggregation precondition
// ---------------------------------------------------------------------------

export interface LatestAggregation {
  workflowRunId: string;
  modeAggregationRunId: string;
  overallAggregationRunId: string;
  matchupAggregationRunId: string;
}

/** The precondition gate for item 9's "fail safely if no valid aggregation exists" — the latest statistical-aggregation workflow run that actually succeeded, with all three of its scoped aggregation_runs rows. */
export async function getLatestSuccessfulAggregation(db: Queryable): Promise<LatestAggregation | null> {
  const [workflowRows] = await db.query<RowDataPacket[]>(
    `SELECT wr.id AS workflowRunId
       FROM workflow_runs wr
       JOIN workflow_definitions wd ON wd.id = wr.workflow_definition_id
      WHERE wd.slug = 'statistical-aggregation' AND wr.status IN ('succeeded', 'succeeded_with_warnings')
      ORDER BY wr.started_at DESC
      LIMIT 1`
  );
  if (workflowRows.length === 0) return null;
  const workflowRunId = workflowRows[0].workflowRunId as string;

  const [runRows] = await db.query<RowDataPacket[]>(
    `SELECT id, scope FROM aggregation_runs WHERE workflow_run_id = ? AND status IN ('succeeded', 'succeeded_with_warnings')`,
    [workflowRunId]
  );
  const byScope = new Map<string, string>(runRows.map((r) => [r.scope as string, r.id as string]));
  const modeAggregationRunId = byScope.get("per_mode");
  const overallAggregationRunId = byScope.get("overall");
  const matchupAggregationRunId = byScope.get("matchup");
  if (!modeAggregationRunId || !overallAggregationRunId || !matchupAggregationRunId) return null;

  return { workflowRunId, modeAggregationRunId, overallAggregationRunId, matchupAggregationRunId };
}

// ---------------------------------------------------------------------------
// Active rule set
// ---------------------------------------------------------------------------

export interface RuleWeight {
  weight: number;
  minSampleSize: number;
}

export interface TierThreshold {
  sCutoff: number;
  aCutoff: number;
  bCutoff: number;
  cCutoff: number;
}

export interface ActiveRuleSet {
  id: string;
  weights: Record<string, RuleWeight>;
  overallTierThreshold: TierThreshold | null;
  modeTierThresholds: Map<string, TierThreshold>;
}

export async function getActiveRuleSet(db: Queryable): Promise<ActiveRuleSet | null> {
  const [ruleSetRows] = await db.query<RowDataPacket[]>("SELECT id FROM ranking_rule_sets WHERE is_active = 1 LIMIT 1");
  if (ruleSetRows.length === 0) return null;
  const ruleSetId = ruleSetRows[0].id as string;

  const [weightRows] = await db.query<RowDataPacket[]>(
    "SELECT signal_name, weight, min_sample_size FROM ranking_rule_weights WHERE ranking_rule_set_id = ?",
    [ruleSetId]
  );
  const weights: Record<string, RuleWeight> = {};
  for (const row of weightRows) {
    weights[row.signal_name as string] = { weight: Number(row.weight), minSampleSize: Number(row.min_sample_size) };
  }

  const [thresholdRows] = await db.query<RowDataPacket[]>(
    "SELECT mode_scope, s_cutoff, a_cutoff, b_cutoff, c_cutoff FROM tier_thresholds WHERE ranking_rule_set_id = ?",
    [ruleSetId]
  );
  let overallTierThreshold: TierThreshold | null = null;
  const modeTierThresholds = new Map<string, TierThreshold>();
  for (const row of thresholdRows) {
    const threshold: TierThreshold = {
      sCutoff: Number(row.s_cutoff),
      aCutoff: Number(row.a_cutoff),
      bCutoff: Number(row.b_cutoff),
      cCutoff: Number(row.c_cutoff),
    };
    if (row.mode_scope === null) overallTierThreshold = threshold;
    else modeTierThresholds.set(row.mode_scope as string, threshold);
  }

  return { id: ruleSetId, weights, overallTierThreshold, modeTierThresholds };
}

// ---------------------------------------------------------------------------
// Brawlers
// ---------------------------------------------------------------------------

export async function getActiveBrawlerIds(db: Queryable): Promise<string[]> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT id FROM canonical_brawlers WHERE is_active = 1");
  return rows.map((r) => r.id as string);
}

// ---------------------------------------------------------------------------
// Raw participation (the documented exception — cap/recency need per-row data)
// ---------------------------------------------------------------------------

export interface RawParticipationRow {
  playerId: string;
  gameModeId: string | null;
  patchId: string | null;
  occurredAt: Date;
  result: "victory" | "defeat" | "draw" | "unknown" | null;
  trophyBracket: string | null;
  region: string | null;
}

export async function getRawParticipationRows(db: Queryable, brawlerId: string): Promise<RawParticipationRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT bp.player_id AS playerId, nb.game_mode_id AS gameModeId, nb.patch_id AS patchId,
            nb.occurred_at AS occurredAt, bt.result AS result,
            pcs.trophy_bracket AS trophyBracket, pcs.region AS region
       FROM battle_participants bp
       JOIN normalized_battles nb ON nb.id = bp.battle_id
       LEFT JOIN battle_teams bt ON bt.id = bp.battle_team_id
       LEFT JOIN normalized_players np ON np.id = bp.player_id
       LEFT JOIN player_crawl_schedule pcs ON pcs.player_tag = np.player_tag
      WHERE bp.brawler_id = ?`,
    [brawlerId]
  );
  return rows.map((r) => ({
    playerId: r.playerId,
    gameModeId: r.gameModeId,
    patchId: r.patchId,
    occurredAt: r.occurredAt,
    result: r.result,
    trophyBracket: r.trophyBracket,
    region: r.region,
  }));
}

/** Total capped participant-slot count across every Brawler in one scope — the shared pick-rate denominator. Computed once, from the same per-Brawler capped counts callers already derive, never a second raw scan. */
export async function getTotalParticipantSlotCount(db: Queryable): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT COUNT(*) AS c FROM battle_participants");
  return Number(rows[0]?.c ?? 0);
}

// ---------------------------------------------------------------------------
// Matchup aggregates (read directly from the latest aggregation run)
// ---------------------------------------------------------------------------

export interface PooledMatchupRow {
  brawlerId: string;
  opponentBrawlerId: string;
  matches: number;
  wins: number;
  losses: number;
}

/** Pools matchup_aggregates rows for one aggregation run across every patch_id/game_mode_id group into one figure per ordered pair — decision report item 7 does not mode-scope matchup classification. Sums the real `wins`/`losses` columns (migration 0023), never reconstructs them from the already-lossy stored win_rate ratio. */
export async function getPooledMatchupRows(db: Queryable, matchupAggregationRunId: string): Promise<PooledMatchupRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT brawler_id AS brawlerId, opponent_brawler_id AS opponentBrawlerId,
            SUM(matches) AS matches,
            SUM(COALESCE(wins, 0)) AS wins,
            SUM(COALESCE(losses, 0)) AS losses
       FROM matchup_aggregates
      WHERE aggregation_run_id = ?
      GROUP BY brawler_id, opponent_brawler_id`,
    [matchupAggregationRunId]
  );
  return rows.map((r) => ({
    brawlerId: r.brawlerId,
    opponentBrawlerId: r.opponentBrawlerId,
    matches: Number(r.matches),
    wins: Number(r.wins),
    losses: Number(r.losses),
  }));
}

// ---------------------------------------------------------------------------
// ranking_runs / ranking_results / matchup_results (candidate layer)
// ---------------------------------------------------------------------------

export async function createRankingRun(
  db: Queryable,
  params: {
    workflowRunId: string;
    rankingRuleSetId: string;
    modeAggregationRunId: string;
    overallAggregationRunId: string;
    matchupAggregationRunId: string;
    patchId: string | null;
  }
): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO ranking_runs
       (id, workflow_run_id, ranking_rule_set_id, mode_aggregation_run_id, overall_aggregation_run_id, matchup_aggregation_run_id, patch_id, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NOW(3))`,
    [id, params.workflowRunId, params.rankingRuleSetId, params.modeAggregationRunId, params.overallAggregationRunId, params.matchupAggregationRunId, params.patchId]
  );
  return id;
}

export async function completeRankingRun(
  db: Queryable,
  rankingRunId: string,
  params: { status: "succeeded" | "held" | "failed"; holdReason?: string | null; tierMoveRatio?: number | null; brawlersEvaluated: number; brawlersPublished: number }
): Promise<void> {
  await db.execute(
    `UPDATE ranking_runs
        SET status = ?, hold_reason = ?, tier_move_ratio = ?, brawlers_evaluated = ?, brawlers_published = ?, completed_at = NOW(3)
      WHERE id = ?`,
    [params.status, params.holdReason ?? null, params.tierMoveRatio ?? null, params.brawlersEvaluated, params.brawlersPublished, rankingRunId]
  );
}

export interface RankingResultRow {
  brawlerId: string;
  gameModeId: string | null;
  matches: number;
  winRate: number | null;
  pickRate: number | null;
  highRankWinRate: number | null;
  matchupCoverage: number | null;
  metaScore: number | null;
  tier: "S" | "A" | "B" | "C" | "D" | null;
  confidence: "insufficient" | "low" | "medium" | "high";
  meetsFloor: boolean;
}

export async function insertRankingResult(db: Queryable, rankingRunId: string, row: RankingResultRow): Promise<void> {
  await db.execute<ResultSetHeader>(
    `INSERT INTO ranking_results
       (id, ranking_run_id, brawler_id, game_mode_id, matches, win_rate, pick_rate, high_rank_win_rate, matchup_coverage, meta_score, tier, confidence, meets_floor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      rankingRunId,
      row.brawlerId,
      row.gameModeId,
      row.matches,
      row.winRate,
      row.pickRate,
      row.highRankWinRate,
      row.matchupCoverage,
      row.metaScore,
      row.tier,
      row.confidence,
      row.meetsFloor ? 1 : 0,
    ]
  );
}

export interface MatchupResultRow {
  brawlerId: string;
  opponentBrawlerId: string;
  gameModeId: string | null;
  matches: number;
  winRate: number | null;
  relationship: "hard_counter" | "counter" | "neutral" | "strong" | "hard_advantage" | null;
  confidenceLevel: "insufficient" | "weak_signal" | "probable_counter" | "high_confidence_counter";
  meetsFloor: boolean;
}

export async function insertMatchupResult(db: Queryable, rankingRunId: string, row: MatchupResultRow): Promise<void> {
  await db.execute<ResultSetHeader>(
    `INSERT INTO matchup_results
       (id, ranking_run_id, brawler_id, opponent_brawler_id, game_mode_id, matches, win_rate, relationship, confidence_level, meets_floor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      rankingRunId,
      row.brawlerId,
      row.opponentBrawlerId,
      row.gameModeId,
      row.matches,
      row.winRate,
      row.relationship,
      row.confidenceLevel,
      row.meetsFloor ? 1 : 0,
    ]
  );
}

// ---------------------------------------------------------------------------
// Publication (layer D)
// ---------------------------------------------------------------------------

export interface CurrentSnapshotTierInfo {
  brawlerId: string;
  tier: "S" | "A" | "B" | "C" | "D";
  score: number;
}

/** Reads the CURRENT published snapshot's tier/score per Brawler — used only for the mass-movement/no-change comparison, never for anything public-facing beyond that. */
export async function getCurrentSnapshotTierInfo(db: Queryable): Promise<CurrentSnapshotTierInfo[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT psi.brawler_id AS brawlerId, psi.overall_tier AS tier, psi.overall_score AS score
       FROM published_snapshot_items psi
       JOIN published_snapshots ps ON ps.id = psi.published_snapshot_id
      WHERE ps.is_current = 1`
  );
  return rows.map((r) => ({ brawlerId: r.brawlerId, tier: r.tier, score: Number(r.score) }));
}

export async function hasAnyPublishedSnapshot(db: Queryable): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT id FROM published_snapshots LIMIT 1");
  return rows.length > 0;
}

export async function supersedeCurrentSnapshot(db: Queryable): Promise<void> {
  await db.execute("UPDATE published_snapshots SET is_current = 0, superseded_at = NOW(3) WHERE is_current = 1");
}

export async function createPublishedSnapshot(
  db: Queryable,
  params: { rankingRunId: string; patchId: string | null }
): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO published_snapshots (id, ranking_run_id, patch_id, is_current, published_at)
     VALUES (?, ?, ?, 1, NOW(3))`,
    [id, params.rankingRunId, params.patchId]
  );
  return id;
}

export interface PublishedSnapshotItemRow {
  brawlerId: string;
  overallTier: "S" | "A" | "B" | "C" | "D";
  overallScore: number;
  overallConfidence: "low" | "medium" | "high";
  modeTiersJson: string;
  patchVersionLabel: string | null;
  calculatedAt: Date;
  dataLimitationsJson: string;
}

export async function insertPublishedSnapshotItem(db: Queryable, snapshotId: string, row: PublishedSnapshotItemRow): Promise<void> {
  await db.execute(
    `INSERT INTO published_snapshot_items
       (id, published_snapshot_id, brawler_id, overall_tier, overall_score, overall_confidence, mode_tiers, patch_version_label, calculated_at, published_at, data_limitations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), ?)`,
    [
      randomUUID(),
      snapshotId,
      row.brawlerId,
      row.overallTier,
      row.overallScore,
      row.overallConfidence,
      row.modeTiersJson,
      row.patchVersionLabel,
      row.calculatedAt,
      row.dataLimitationsJson,
    ]
  );
}

export interface PublishedMatchupItemRow {
  brawlerId: string;
  opponentBrawlerId: string;
  relationship: "hard_counter" | "counter" | "neutral" | "strong" | "hard_advantage";
  confidenceLevel: "probable_counter" | "high_confidence_counter";
  winRate: number;
  sampleSize: number;
  gameModeId: string | null;
  patchVersionLabel: string | null;
}

export async function insertPublishedMatchupItem(db: Queryable, snapshotId: string, row: PublishedMatchupItemRow): Promise<void> {
  await db.execute(
    `INSERT INTO published_matchup_items
       (id, published_snapshot_id, brawler_id, opponent_brawler_id, relationship, confidence_level, win_rate, sample_size, game_mode_id, patch_version_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUUID(),
      snapshotId,
      row.brawlerId,
      row.opponentBrawlerId,
      row.relationship,
      row.confidenceLevel,
      row.winRate,
      row.sampleSize,
      row.gameModeId,
      row.patchVersionLabel,
    ]
  );
}
