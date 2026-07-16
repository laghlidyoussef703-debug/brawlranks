/**
 * The ONLY data-access module any public-facing code path may use (Section
 * 7.25's hard rule: "no Next.js page/component is permitted to query
 * normalized_battles, battle_participants, raw_api_snapshots, or any other
 * collection-layer table — only published_snapshot_items"). Every function
 * here reads exclusively from published_snapshots/published_snapshot_items/
 * published_matchup_items filtered to `is_current = 1` — never
 * ranking_results/matchup_results (the candidate/working layer), and never
 * a held or superseded snapshot.
 */

import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

type Queryable = Pool | PoolConnection;

export interface CurrentSnapshotMeta {
  snapshotId: string;
  publishedAt: string;
  patchVersionLabel: string | null;
}

/** Indexed lookup via published_snapshots' own unique(current_flag) constraint — never ORDER BY created_at DESC LIMIT 1, which could surface a non-current row. */
export async function getCurrentSnapshotMeta(db: Queryable): Promise<CurrentSnapshotMeta | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, published_at, patch_id FROM published_snapshots WHERE is_current = 1 LIMIT 1"
  );
  if (rows.length === 0) return null;

  const [patchRows] = rows[0].patch_id
    ? await db.query<RowDataPacket[]>("SELECT version_label FROM patches WHERE id = ?", [rows[0].patch_id])
    : [[]];

  return {
    snapshotId: rows[0].id,
    publishedAt: rows[0].published_at.toISOString(),
    patchVersionLabel: patchRows[0]?.version_label ?? null,
  };
}

export interface PublicMatchupEntry {
  opponentSlug: string;
  opponentName: string;
  relationship: string;
  confidence: string;
  winRate: number;
  sampleSize: number;
  gameModeId: string | null;
  patchVersionLabel: string | null;
}

export interface PublicBrawlerRecord {
  brawlerSlug: string;
  brawlerName: string;
  overallTier: string;
  overallScore: number;
  overallConfidence: string;
  modeTiers: unknown;
  patchVersionLabel: string | null;
  calculatedAt: string;
  publishedAt: string;
  dataLimitations: unknown;
  counters: PublicMatchupEntry[];
  strongAgainst: PublicMatchupEntry[];
}

const STRONG_RELATIONSHIPS = new Set(["strong", "hard_advantage"]);
const COUNTER_RELATIONSHIPS = new Set(["hard_counter", "counter"]);

/** Every published Brawler record for the current snapshot — Section 7.25's exact per-Brawler contract, build/AI fields omitted entirely (never present, never faked empty). */
export async function getCurrentPublishedBrawlers(db: Queryable, snapshotId: string): Promise<PublicBrawlerRecord[]> {
  const [itemRows] = await db.query<RowDataPacket[]>(
    `SELECT psi.brawler_id AS brawlerId, cb.slug AS brawlerSlug, cb.name AS brawlerName,
            psi.overall_tier AS overallTier, psi.overall_score AS overallScore, psi.overall_confidence AS overallConfidence,
            psi.mode_tiers AS modeTiers, psi.patch_version_label AS patchVersionLabel,
            psi.calculated_at AS calculatedAt, psi.published_at AS publishedAt, psi.data_limitations AS dataLimitations
       FROM published_snapshot_items psi
       JOIN canonical_brawlers cb ON cb.id = psi.brawler_id
      WHERE psi.published_snapshot_id = ?
      ORDER BY psi.overall_score DESC`,
    [snapshotId]
  );

  const [matchupRows] = await db.query<RowDataPacket[]>(
    `SELECT pmi.brawler_id AS brawlerId, pmi.relationship AS relationship, pmi.confidence_level AS confidence,
            pmi.win_rate AS winRate, pmi.sample_size AS sampleSize, pmi.game_mode_id AS gameModeId,
            pmi.patch_version_label AS patchVersionLabel,
            cb.slug AS opponentSlug, cb.name AS opponentName
       FROM published_matchup_items pmi
       JOIN canonical_brawlers cb ON cb.id = pmi.opponent_brawler_id
      WHERE pmi.published_snapshot_id = ?`,
    [snapshotId]
  );

  const matchupsByBrawler = new Map<string, RowDataPacket[]>();
  for (const row of matchupRows) {
    const list = matchupsByBrawler.get(row.brawlerId) ?? [];
    list.push(row);
    matchupsByBrawler.set(row.brawlerId, list);
  }

  return itemRows.map((row) => {
    const related = matchupsByBrawler.get(row.brawlerId) ?? [];
    const toEntry = (r: RowDataPacket): PublicMatchupEntry => ({
      opponentSlug: r.opponentSlug,
      opponentName: r.opponentName,
      relationship: r.relationship,
      confidence: r.confidence,
      winRate: Number(r.winRate),
      sampleSize: Number(r.sampleSize),
      gameModeId: r.gameModeId,
      patchVersionLabel: r.patchVersionLabel,
    });
    return {
      brawlerSlug: row.brawlerSlug,
      brawlerName: row.brawlerName,
      overallTier: row.overallTier,
      overallScore: Number(row.overallScore),
      overallConfidence: row.overallConfidence,
      modeTiers: JSON.parse(row.modeTiers),
      patchVersionLabel: row.patchVersionLabel,
      calculatedAt: row.calculatedAt.toISOString(),
      publishedAt: row.publishedAt.toISOString(),
      dataLimitations: JSON.parse(row.dataLimitations),
      counters: related.filter((r) => COUNTER_RELATIONSHIPS.has(r.relationship)).map(toEntry),
      strongAgainst: related.filter((r) => STRONG_RELATIONSHIPS.has(r.relationship)).map(toEntry),
    };
  });
}
