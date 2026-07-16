import { NextResponse } from "next/server";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { verifyInternalCronBearer } from "@/lib/auth";
import { getPool } from "@/lib/mysql";
import { errorBody, logSafeError } from "@/lib/errors";
import { runQueriesBounded, DB_QUERY_CONCURRENCY } from "@/lib/dbConcurrency";

/**
 * Read-only, protected ingestion health/status report (Section 30).
 * Exposes only safe operational metadata (counts, timestamps, statuses) —
 * never raw payloads, player-level profile data, or secrets. No mutation.
 *
 * Concurrency note (Phase 4 production fix, same root cause as
 * /api/internal/test/dataset-coverage): this route previously ran its 16
 * independent queries as two `Promise.all` batches (4, then 12).
 * Hostinger's pool (`lib/mysql.ts`) is intentionally constrained to
 * `connectionLimit: 2, queueLimit: 10` (12 total slots) — a 12-query burst
 * sits exactly at that ceiling, so any other concurrent request touching
 * the same shared pool at that moment (another route, a cron job) could
 * push it over and trigger the same `Error: Queue limit reached` seen in
 * dataset-coverage. Both batches are now merged into one list run through
 * `runQueriesBounded`, which never has more than `DB_QUERY_CONCURRENCY`
 * (2) queries in flight at once — see lib/dbConcurrency.ts.
 */
export const runtime = "nodejs";

/** Purely in-memory (no query) — reads a count off an already-fetched row array. Not part of any pool-concurrency concern. */
function readCount(rows: RowDataPacket[]): number {
  return Number(rows[0]?.count ?? 0);
}

export interface IngestionHealthReport {
  ok: true;
  latestRunPerWorkflow: RowDataPacket[];
  recentFailedRuns: RowDataPacket[];
  openIncidentsByType: RowDataPacket[];
  rateBudgets: RowDataPacket[];
  duePlayerBacklog: number;
  activeCrawlLeases: number;
  staleCrawlLeases: number;
  seedPlayersByRegion: RowDataPacket[];
  unpromotedObservedPlayers: number;
  activeCrawlPlayerCount: number;
  normalizedPlayerCount: number;
  normalizedClubCount: number;
  normalizedBattleCount: number;
  battleParticipantCount: number;
  latestBattleOccurredAt: unknown;
  rawSnapshotCountByEndpoint: RowDataPacket[];
}

/**
 * Core reporting logic, separated from the route handler for direct
 * testability against a fake constrained pool (tests/dbConcurrency.test.ts)
 * without a real database — mirrors dataset-coverage's same split.
 */
export async function buildIngestionHealthReport(pool: Pool): Promise<IngestionHealthReport> {
  const queries: Array<() => Promise<[RowDataPacket[], unknown]>> = [
    () =>
      pool.query<RowDataPacket[]>(
        `SELECT wd.slug, wr.status, wr.started_at, wr.completed_at
           FROM workflow_runs wr
           JOIN workflow_definitions wd ON wd.id = wr.workflow_definition_id
          WHERE wr.id IN (
            SELECT MAX(id) FROM workflow_runs GROUP BY workflow_definition_id
          )`
      ),
    () =>
      pool.query<RowDataPacket[]>(
        `SELECT wd.slug, wr.started_at, wr.error_summary
           FROM workflow_runs wr
           JOIN workflow_definitions wd ON wd.id = wr.workflow_definition_id
          WHERE wr.status = 'failed'
          ORDER BY wr.started_at DESC
          LIMIT 10`
      ),
    () =>
      pool.query<RowDataPacket[]>(
        `SELECT incident_type, COUNT(*) AS count FROM data_incidents
          WHERE status IN ('open', 'investigating')
          GROUP BY incident_type`
      ),
    () =>
      pool.query<RowDataPacket[]>(
        `SELECT budget_scope, request_ceiling, reserved_for_priority, requests_used, window_seconds, last_429_at
           FROM ingestion_rate_budgets`
      ),
    () =>
      pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS count FROM player_crawl_schedule WHERE is_active = 1 AND next_due_at <= NOW(3) AND (backoff_until IS NULL OR backoff_until <= NOW(3)) AND leased_by_run_id IS NULL"
      ),
    () =>
      pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS count FROM player_crawl_schedule WHERE leased_by_run_id IS NOT NULL AND lease_expires_at >= NOW(3)"
      ),
    () =>
      pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) AS count FROM player_crawl_schedule WHERE leased_by_run_id IS NOT NULL AND lease_expires_at < NOW(3)"
      ),
    () => pool.query<RowDataPacket[]>("SELECT region, COUNT(*) AS count FROM seed_players GROUP BY region"),
    () => pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM observed_players WHERE promoted_to_active = 0"),
    () => pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM player_crawl_schedule WHERE is_active = 1"),
    () => pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM normalized_players"),
    () => pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM normalized_clubs"),
    () => pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM normalized_battles"),
    () => pool.query<RowDataPacket[]>("SELECT COUNT(*) AS count FROM battle_participants"),
    () => pool.query<RowDataPacket[]>("SELECT MAX(occurred_at) AS latest FROM normalized_battles"),
    () =>
      pool.query<RowDataPacket[]>(
        "SELECT endpoint_category, COUNT(*) AS count FROM raw_api_snapshots GROUP BY endpoint_category"
      ),
  ];

  const [
    latestRunsPerWorkflow,
    recentFailedRuns,
    openIncidentsByType,
    rateBudgets,
    dueBacklogResult,
    activeLeasesResult,
    staleLeasesResult,
    seedByRegion,
    observedCountResult,
    activeCrawlCountResult,
    normalizedPlayerCountResult,
    normalizedClubCountResult,
    normalizedBattleCountResult,
    participantCountResult,
    latestBattleTime,
    rawSnapshotByEndpoint,
  ] = await runQueriesBounded(queries, DB_QUERY_CONCURRENCY);

  const dueBacklog = readCount(dueBacklogResult[0]);
  const activeLeases = readCount(activeLeasesResult[0]);
  const staleLeases = readCount(staleLeasesResult[0]);
  const observedCount = readCount(observedCountResult[0]);
  const activeCrawlCount = readCount(activeCrawlCountResult[0]);
  const normalizedPlayerCount = readCount(normalizedPlayerCountResult[0]);
  const normalizedClubCount = readCount(normalizedClubCountResult[0]);
  const normalizedBattleCount = readCount(normalizedBattleCountResult[0]);
  const participantCount = readCount(participantCountResult[0]);

  return {
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
  };
}

export async function GET(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("ingestion-health", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  try {
    const report = await buildIngestionHealthReport(getPool());
    return NextResponse.json(report);
  } catch (error) {
    logSafeError("ingestion-health", "MYSQL_ERROR", error);
    return NextResponse.json(errorBody("MYSQL_ERROR", "Failed to read ingestion health."), { status: 500 });
  }
}
