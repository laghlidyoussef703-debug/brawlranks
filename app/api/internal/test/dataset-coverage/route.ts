import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { verifyInternalCronBearer } from "@/lib/auth";
import { getPool } from "@/lib/mysql";
import { errorBody, logSafeError } from "@/lib/errors";

/**
 * Read-only, protected dataset-coverage/sufficiency report (Phase 4.9).
 * Distinct from /api/internal/test/ingestion-health, which reports
 * operational status (is the pipeline running); this reports whether the
 * COLLECTED DATA is diverse/sufficient enough to move to Phase 5 —
 * distributions, not just counts. Never returns player tags/names or any
 * raw payload — only aggregate counts.
 *
 * Honesty note (matches the rest of this codebase's convention): region
 * and trophy-bracket breakdowns for BATTLES are approximated via the
 * crawled player's own region/trophy_bracket on player_crawl_schedule
 * (set at seed/discovery time), which is null for most organically
 * discovered players — "where derivable," exactly as the task phrases it,
 * not a claim of full coverage.
 */
export const runtime = "nodejs";

interface CountRow extends RowDataPacket {
  count: number;
}

async function scalar(pool: ReturnType<typeof getPool>, sql: string, params: unknown[] = []): Promise<number> {
  const [rows] = await pool.query<CountRow[]>(sql, params);
  return rows[0]?.count ?? 0;
}

export async function GET(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("dataset-coverage", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  try {
    const pool = getPool();

    const [
      seedByRegion,
      activeCrawlByRegion,
      playersByBracket,
      dueBacklogByRegionBracket,
      totalPlayers,
      totalBattles,
      totalParticipants,
      battlesByDay,
      battlesByRegion,
      battlesByBracket,
      battlesByMode,
      battlesByMap,
      battlesByBrawler,
      brawlerCoverage,
      battleTimeRange,
      clubCoverage,
    ] = await Promise.all([
      pool.query<RowDataPacket[]>("SELECT region, COUNT(*) AS count FROM seed_players GROUP BY region"),
      pool.query<RowDataPacket[]>(
        "SELECT region, COUNT(*) AS count FROM player_crawl_schedule WHERE is_active = 1 GROUP BY region"
      ),
      pool.query<RowDataPacket[]>(
        "SELECT trophy_bracket, COUNT(*) AS count FROM player_crawl_schedule WHERE is_active = 1 GROUP BY trophy_bracket"
      ),
      pool.query<RowDataPacket[]>(
        `SELECT region, trophy_bracket, COUNT(*) AS count FROM player_crawl_schedule
          WHERE is_active = 1 AND next_due_at <= NOW(3)
            AND (backoff_until IS NULL OR backoff_until <= NOW(3)) AND leased_by_run_id IS NULL
          GROUP BY region, trophy_bracket`
      ),
      scalar(pool, "SELECT COUNT(*) AS count FROM normalized_players"),
      scalar(pool, "SELECT COUNT(*) AS count FROM normalized_battles"),
      scalar(pool, "SELECT COUNT(*) AS count FROM battle_participants"),
      pool.query<RowDataPacket[]>(
        `SELECT DATE(occurred_at) AS day, COUNT(*) AS count FROM normalized_battles
          WHERE occurred_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)
          GROUP BY DATE(occurred_at) ORDER BY day DESC`
      ),
      pool.query<RowDataPacket[]>(
        `SELECT pcs.region AS region, COUNT(DISTINCT bp.battle_id) AS count
           FROM battle_participants bp
           JOIN normalized_players np ON np.id = bp.player_id
           JOIN player_crawl_schedule pcs ON pcs.player_tag = np.player_tag
          WHERE pcs.region IS NOT NULL
          GROUP BY pcs.region`
      ),
      pool.query<RowDataPacket[]>(
        `SELECT pcs.trophy_bracket AS trophy_bracket, COUNT(DISTINCT bp.battle_id) AS count
           FROM battle_participants bp
           JOIN normalized_players np ON np.id = bp.player_id
           JOIN player_crawl_schedule pcs ON pcs.player_tag = np.player_tag
          WHERE pcs.trophy_bracket IS NOT NULL
          GROUP BY pcs.trophy_bracket`
      ),
      pool.query<RowDataPacket[]>(
        `SELECT cgm.name AS mode, COUNT(*) AS count FROM normalized_battles nb
           LEFT JOIN canonical_game_modes cgm ON cgm.id = nb.game_mode_id
          GROUP BY cgm.name ORDER BY count DESC`
      ),
      pool.query<RowDataPacket[]>(
        `SELECT cm.name AS map, COUNT(*) AS count FROM normalized_battles nb
           LEFT JOIN canonical_maps cm ON cm.id = nb.map_id
          WHERE nb.map_id IS NOT NULL
          GROUP BY cm.name ORDER BY count DESC LIMIT 50`
      ),
      pool.query<RowDataPacket[]>(
        `SELECT cb.name AS brawler, COUNT(*) AS count FROM battle_participants bp
           JOIN canonical_brawlers cb ON cb.id = bp.brawler_id
          GROUP BY cb.name ORDER BY count DESC`
      ),
      pool.query<RowDataPacket[]>(
        `SELECT cb.id, cb.name,
                COALESCE((SELECT COUNT(*) FROM battle_participants bp WHERE bp.brawler_id = cb.id), 0) AS sample_count
           FROM canonical_brawlers cb
          WHERE cb.is_active = 1`
      ),
      pool.query<RowDataPacket[]>(
        "SELECT MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest FROM normalized_battles"
      ),
      pool.query<RowDataPacket[]>(
        `SELECT
           (SELECT COUNT(*) FROM normalized_clubs) AS normalized_clubs,
           (SELECT COUNT(*) FROM normalized_players WHERE club_id IS NOT NULL) AS players_with_club,
           (SELECT COUNT(*) FROM normalized_players WHERE pending_club_tag IS NOT NULL) AS players_pending_club`
      ),
    ]);

    const MIN_SAMPLE_THRESHOLD = 30; // Section 7.8-style floor — configured, not a spec-mandated number; see PHASE4.md.
    const brawlerRows = brawlerCoverage[0] as Array<{ id: string; name: string; sample_count: number }>;
    const brawlersWithZeroSamples = brawlerRows.filter((r) => r.sample_count === 0).map((r) => r.name);
    const brawlersBelowThreshold = brawlerRows.filter((r) => r.sample_count > 0 && r.sample_count < MIN_SAMPLE_THRESHOLD).length;

    // Crawl success/failure and empty-log rate over a recent window, scoped to the battle_log endpoint specifically.
    const recentWindowDays = 7;
    const [battleFetchStats] = await pool.query<RowDataPacket[]>(
      `SELECT dfr.status, COUNT(*) AS count, SUM(CASE WHEN dfr.records_fetched = 0 THEN 1 ELSE 0 END) AS empty_count
         FROM data_fetch_runs dfr
         JOIN source_endpoints se ON se.id = dfr.source_endpoint_id
        WHERE se.endpoint_category = 'battle_log' AND dfr.started_at >= DATE_SUB(NOW(3), INTERVAL ? DAY)
        GROUP BY dfr.status`,
      [recentWindowDays]
    );
    const totalBattleFetches = battleFetchStats.reduce((sum, r) => sum + r.count, 0);
    const successBattleFetches = battleFetchStats.find((r) => r.status === "success")?.count ?? 0;
    const emptyBattleFetches = battleFetchStats.reduce((sum, r) => sum + (r.empty_count ?? 0), 0);

    const totalObservations = await scalar(pool, "SELECT COUNT(*) AS count FROM battle_observations");

    return NextResponse.json({
      ok: true,
      evaluatedAt: new Date().toISOString(),
      seedPlayersByRegion: seedByRegion[0],
      activeCrawlPlayersByRegion: activeCrawlByRegion[0],
      activeCrawlPlayersByTrophyBracket: playersByBracket[0],
      duePlayerBacklogByRegionAndBracket: dueBacklogByRegionBracket[0],
      normalizedPlayerCount: totalPlayers,
      normalizedBattleCount: totalBattles,
      battleParticipantCount: totalParticipants,
      battlesByDayLast30Days: battlesByDay[0],
      battlesByRegionWhereDerivable: battlesByRegion[0],
      battlesByTrophyBracketWhereDerivable: battlesByBracket[0],
      battlesByGameMode: battlesByMode[0],
      battlesByMap: battlesByMap[0],
      battlesByBrawler: battlesByBrawler[0],
      brawlerCoverage: {
        totalActiveBrawlers: brawlerRows.length,
        brawlersWithZeroSamples,
        brawlersBelowMinimumSampleThreshold: brawlersBelowThreshold,
        minimumSampleThreshold: MIN_SAMPLE_THRESHOLD,
      },
      oldestBattleOccurredAt: battleTimeRange[0][0]?.oldest ?? null,
      newestBattleOccurredAt: battleTimeRange[0][0]?.newest ?? null,
      battleLogCrawlHealth: {
        windowDays: recentWindowDays,
        totalFetches: totalBattleFetches,
        successRate: totalBattleFetches > 0 ? successBattleFetches / totalBattleFetches : null,
        emptyLogRate: totalBattleFetches > 0 ? emptyBattleFetches / totalBattleFetches : null,
      },
      deduplicationRate: totalObservations > 0 ? (totalObservations - totalBattles) / totalObservations : null,
      clubCoverage: clubCoverage[0][0],
    });
  } catch (error) {
    logSafeError("dataset-coverage", "MYSQL_ERROR", error);
    return NextResponse.json(errorBody("MYSQL_ERROR", "Failed to read dataset coverage."), { status: 500 });
  }
}
