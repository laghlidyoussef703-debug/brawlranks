import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { verifyInternalCronBearer } from "@/lib/auth";
import { getPool } from "@/lib/mysql";
import { errorBody, logSafeError } from "@/lib/errors";

/**
 * Read-only, protected ingestion health/status report (Section 30).
 * Exposes only safe operational metadata (counts, timestamps, statuses) —
 * never raw payloads, player-level profile data, or secrets. No mutation.
 */
export const runtime = "nodejs";

interface CountRow extends RowDataPacket {
  count: number;
}

async function scalarCount(pool: ReturnType<typeof getPool>, sql: string, params: unknown[] = []): Promise<number> {
  const [rows] = await pool.query<CountRow[]>(sql, params);
  return rows[0]?.count ?? 0;
}

export async function GET(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("ingestion-health", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  try {
    const pool = getPool();

    const [latestRunsPerWorkflow, recentFailedRuns, openIncidentsByType, rateBudgets] = await Promise.all([
      pool.query<RowDataPacket[]>(
        `SELECT wd.slug, wr.status, wr.started_at, wr.completed_at
           FROM workflow_runs wr
           JOIN workflow_definitions wd ON wd.id = wr.workflow_definition_id
          WHERE wr.id IN (
            SELECT MAX(id) FROM workflow_runs GROUP BY workflow_definition_id
          )`
      ),
      pool.query<RowDataPacket[]>(
        `SELECT wd.slug, wr.started_at, wr.error_summary
           FROM workflow_runs wr
           JOIN workflow_definitions wd ON wd.id = wr.workflow_definition_id
          WHERE wr.status = 'failed'
          ORDER BY wr.started_at DESC
          LIMIT 10`
      ),
      pool.query<RowDataPacket[]>(
        `SELECT incident_type, COUNT(*) AS count FROM data_incidents
          WHERE status IN ('open', 'investigating')
          GROUP BY incident_type`
      ),
      pool.query<RowDataPacket[]>(
        `SELECT budget_scope, request_ceiling, reserved_for_priority, requests_used, window_seconds, last_429_at
           FROM ingestion_rate_budgets`
      ),
    ]);

    const [dueBacklog, activeLeases, staleLeases, seedByRegion, observedCount, activeCrawlCount, normalizedPlayerCount, normalizedClubCount, normalizedBattleCount, participantCount, latestBattleTime, rawSnapshotByEndpoint] =
      await Promise.all([
        scalarCount(
          pool,
          "SELECT COUNT(*) AS count FROM player_crawl_schedule WHERE is_active = 1 AND next_due_at <= NOW(3) AND (backoff_until IS NULL OR backoff_until <= NOW(3)) AND leased_by_run_id IS NULL"
        ),
        scalarCount(pool, "SELECT COUNT(*) AS count FROM player_crawl_schedule WHERE leased_by_run_id IS NOT NULL AND lease_expires_at >= NOW(3)"),
        scalarCount(pool, "SELECT COUNT(*) AS count FROM player_crawl_schedule WHERE leased_by_run_id IS NOT NULL AND lease_expires_at < NOW(3)"),
        pool.query<RowDataPacket[]>("SELECT region, COUNT(*) AS count FROM seed_players GROUP BY region"),
        scalarCount(pool, "SELECT COUNT(*) AS count FROM observed_players WHERE promoted_to_active = 0"),
        scalarCount(pool, "SELECT COUNT(*) AS count FROM player_crawl_schedule WHERE is_active = 1"),
        scalarCount(pool, "SELECT COUNT(*) AS count FROM normalized_players"),
        scalarCount(pool, "SELECT COUNT(*) AS count FROM normalized_clubs"),
        scalarCount(pool, "SELECT COUNT(*) AS count FROM normalized_battles"),
        scalarCount(pool, "SELECT COUNT(*) AS count FROM battle_participants"),
        pool.query<RowDataPacket[]>("SELECT MAX(occurred_at) AS latest FROM normalized_battles"),
        pool.query<RowDataPacket[]>("SELECT endpoint_category, COUNT(*) AS count FROM raw_api_snapshots GROUP BY endpoint_category"),
      ]);

    return NextResponse.json({
      ok: true,
      latestRunPerWorkflow: latestRunsPerWorkflow[0],
      recentFailedRuns: recentFailedRuns[0],
      openIncidentsByType: openIncidentsByType[0],
      rateBudgets: rateBudgets[0],
      duePlayerBacklog: dueBacklog,
      activeCrawlLeases: activeLeases,
      staleCrawlLeases: staleLeases,
      seedPlayersByRegion: seedByRegion[0],
      unpromotedObservedPlayers: observedCount,
      activeCrawlPlayerCount: activeCrawlCount,
      normalizedPlayerCount,
      normalizedClubCount,
      normalizedBattleCount,
      battleParticipantCount: participantCount,
      latestBattleOccurredAt: latestBattleTime[0][0]?.latest ?? null,
      rawSnapshotCountByEndpoint: rawSnapshotByEndpoint[0],
    });
  } catch (error) {
    logSafeError("ingestion-health", "MYSQL_ERROR", error);
    return NextResponse.json(errorBody("MYSQL_ERROR", "Failed to read ingestion health."), { status: 500 });
  }
}
