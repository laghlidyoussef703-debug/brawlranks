import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { verifyInternalCronBearer } from "@/lib/auth";
import { getPool } from "@/lib/mysql";
import { errorBody, logSafeError } from "@/lib/errors";

/**
 * Read-only, protected Phase 5 (aggregation/ranking) readiness gate
 * (Phase 4.11). Answers "is the dataset ready for Phase 5?" mechanically,
 * from real counts — never asserts readiness by assumption. Does NOT
 * implement any ranking/aggregation calculation itself.
 *
 * These thresholds are CONFIGURED, REASONED DEFAULTS — spec Section 7.28
 * leaves exact sample-size targets as an explicit unresolved owner
 * decision. They are deliberately conservative starting points, not a
 * verified-optimal or spec-mandated set of numbers.
 */
export const runtime = "nodejs";

const HARD_GATES = {
  MIN_TOTAL_BATTLES: 5_000,
  MIN_DISTINCT_REGIONS_WITH_BATTLES: 2,
  MIN_DISTINCT_TROPHY_BRACKETS_WITH_BATTLES: 2,
  MIN_RECENT_BATTLES_LAST_30_DAYS: 500,
  MAX_ZERO_SAMPLE_BRAWLER_RATIO: 0.5,
} as const;

const PREFERRED_TARGETS = {
  TOTAL_BATTLES: 20_000,
  DISTINCT_REGIONS_WITH_BATTLES: 5,
  DISTINCT_TROPHY_BRACKETS_WITH_BATTLES: 3,
  MAX_BELOW_THRESHOLD_BRAWLER_RATIO: 0.2,
  MIN_BATTLE_LOG_SUCCESS_RATE: 0.9,
} as const;

const MIN_SAMPLE_PER_BRAWLER = 30;

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
    logSafeError("phase5-readiness", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  try {
    const pool = getPool();

    const totalBattles = await scalar(pool, "SELECT COUNT(*) AS count FROM normalized_battles");
    const recentBattles = await scalar(
      pool,
      "SELECT COUNT(*) AS count FROM normalized_battles WHERE occurred_at >= DATE_SUB(NOW(3), INTERVAL 30 DAY)"
    );
    const distinctRegions = await scalar(
      pool,
      `SELECT COUNT(DISTINCT pcs.region) AS count
         FROM battle_participants bp
         JOIN normalized_players np ON np.id = bp.player_id
         JOIN player_crawl_schedule pcs ON pcs.player_tag = np.player_tag
        WHERE pcs.region IS NOT NULL`
    );
    const distinctBrackets = await scalar(
      pool,
      `SELECT COUNT(DISTINCT pcs.trophy_bracket) AS count
         FROM battle_participants bp
         JOIN normalized_players np ON np.id = bp.player_id
         JOIN player_crawl_schedule pcs ON pcs.player_tag = np.player_tag
        WHERE pcs.trophy_bracket IS NOT NULL`
    );

    const [brawlerRows] = await pool.query<RowDataPacket[]>(
      `SELECT cb.id,
              COALESCE((SELECT COUNT(*) FROM battle_participants bp WHERE bp.brawler_id = cb.id), 0) AS sample_count
         FROM canonical_brawlers cb
        WHERE cb.is_active = 1`
    );
    const totalActiveBrawlers = brawlerRows.length;
    const zeroSampleBrawlers = brawlerRows.filter((r) => r.sample_count === 0).length;
    const belowThresholdBrawlers = brawlerRows.filter((r) => r.sample_count > 0 && r.sample_count < MIN_SAMPLE_PER_BRAWLER).length;
    const zeroSampleRatio = totalActiveBrawlers > 0 ? zeroSampleBrawlers / totalActiveBrawlers : 1;
    const belowThresholdRatio = totalActiveBrawlers > 0 ? belowThresholdBrawlers / totalActiveBrawlers : 1;

    const [battleFetchStats] = await pool.query<RowDataPacket[]>(
      `SELECT dfr.status, COUNT(*) AS count
         FROM data_fetch_runs dfr
         JOIN source_endpoints se ON se.id = dfr.source_endpoint_id
        WHERE se.endpoint_category = 'battle_log' AND dfr.started_at >= DATE_SUB(NOW(3), INTERVAL 7 DAY)
        GROUP BY dfr.status`
    );
    const totalFetches = battleFetchStats.reduce((sum, r) => sum + r.count, 0);
    const successFetches = battleFetchStats.find((r) => r.status === "success")?.count ?? 0;
    const battleLogSuccessRate = totalFetches > 0 ? successFetches / totalFetches : null;

    const blockers: string[] = [];
    const warnings: string[] = [];

    const hardGateResults = {
      totalBattles: { value: totalBattles, required: HARD_GATES.MIN_TOTAL_BATTLES, pass: totalBattles >= HARD_GATES.MIN_TOTAL_BATTLES },
      distinctRegionsWithBattles: {
        value: distinctRegions,
        required: HARD_GATES.MIN_DISTINCT_REGIONS_WITH_BATTLES,
        pass: distinctRegions >= HARD_GATES.MIN_DISTINCT_REGIONS_WITH_BATTLES,
      },
      distinctTrophyBracketsWithBattles: {
        value: distinctBrackets,
        required: HARD_GATES.MIN_DISTINCT_TROPHY_BRACKETS_WITH_BATTLES,
        pass: distinctBrackets >= HARD_GATES.MIN_DISTINCT_TROPHY_BRACKETS_WITH_BATTLES,
      },
      recentBattlesLast30Days: {
        value: recentBattles,
        required: HARD_GATES.MIN_RECENT_BATTLES_LAST_30_DAYS,
        pass: recentBattles >= HARD_GATES.MIN_RECENT_BATTLES_LAST_30_DAYS,
      },
      zeroSampleBrawlerRatio: {
        value: zeroSampleRatio,
        maxAllowed: HARD_GATES.MAX_ZERO_SAMPLE_BRAWLER_RATIO,
        pass: zeroSampleRatio <= HARD_GATES.MAX_ZERO_SAMPLE_BRAWLER_RATIO,
      },
    };

    for (const [gate, result] of Object.entries(hardGateResults)) {
      if (!result.pass) blockers.push(gate);
    }

    const preferredTargetResults = {
      totalBattles: { value: totalBattles, target: PREFERRED_TARGETS.TOTAL_BATTLES, met: totalBattles >= PREFERRED_TARGETS.TOTAL_BATTLES },
      distinctRegionsWithBattles: {
        value: distinctRegions,
        target: PREFERRED_TARGETS.DISTINCT_REGIONS_WITH_BATTLES,
        met: distinctRegions >= PREFERRED_TARGETS.DISTINCT_REGIONS_WITH_BATTLES,
      },
      distinctTrophyBracketsWithBattles: {
        value: distinctBrackets,
        target: PREFERRED_TARGETS.DISTINCT_TROPHY_BRACKETS_WITH_BATTLES,
        met: distinctBrackets >= PREFERRED_TARGETS.DISTINCT_TROPHY_BRACKETS_WITH_BATTLES,
      },
      belowThresholdBrawlerRatio: {
        value: belowThresholdRatio,
        maxAllowed: PREFERRED_TARGETS.MAX_BELOW_THRESHOLD_BRAWLER_RATIO,
        met: belowThresholdRatio <= PREFERRED_TARGETS.MAX_BELOW_THRESHOLD_BRAWLER_RATIO,
      },
      battleLogSuccessRate: {
        value: battleLogSuccessRate,
        target: PREFERRED_TARGETS.MIN_BATTLE_LOG_SUCCESS_RATE,
        met: battleLogSuccessRate !== null && battleLogSuccessRate >= PREFERRED_TARGETS.MIN_BATTLE_LOG_SUCCESS_RATE,
      },
    };

    for (const [target, result] of Object.entries(preferredTargetResults)) {
      if (!result.met) warnings.push(target);
    }

    return NextResponse.json({
      ok: true,
      ready: blockers.length === 0,
      hardGates: hardGateResults,
      preferredTargets: preferredTargetResults,
      blockers,
      warnings,
      evaluatedAt: new Date().toISOString(),
    });
  } catch (error) {
    logSafeError("phase5-readiness", "MYSQL_ERROR", error);
    return NextResponse.json(errorBody("MYSQL_ERROR", "Failed to evaluate Phase 5 readiness."), { status: 500 });
  }
}
