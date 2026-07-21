import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { verifyInternalCronBearer } from "@/lib/auth";
import { getWritePool } from "@/lib/mysql";
import { errorBody, logSafeError } from "@/lib/errors";

/**
 * Read-only, protected verification route for the Phase 2 catalog pipeline.
 * Exposes only safe operational metadata (counts, timestamps, statuses) —
 * never raw/normalized payload bytes, never secrets. No mutation of any
 * kind happens in this route.
 */
export const runtime = "nodejs";

interface CountRow extends RowDataPacket {
  count: number;
}

interface LatestFetchRunRow extends RowDataPacket {
  id: string;
  status: string;
  trigger_type: string;
  started_at: Date;
  completed_at: Date | null;
  changes_detected_count: number;
  records_fetched: number | null;
  error_code: string | null;
}

interface LatestChangeRow extends RowDataPacket {
  change_type: string;
  entity_id: string;
  severity: string;
  created_at: Date;
}

interface OpenIncidentRow extends RowDataPacket {
  id: string;
  incident_type: string;
  status: string;
  created_at: Date;
}

export async function GET(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("catalog-status", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), {
      status: 401,
    });
  }

  try {
    const pool = getWritePool();

    const [[activeBrawlerCount]] = await pool.query<CountRow[]>(
      "SELECT COUNT(*) AS count FROM canonical_brawlers WHERE is_active = 1"
    );
    const [[inactiveBrawlerCount]] = await pool.query<CountRow[]>(
      "SELECT COUNT(*) AS count FROM canonical_brawlers WHERE is_active = 0"
    );
    const [latestFetchRuns] = await pool.query<LatestFetchRunRow[]>(
      `SELECT id, status, trigger_type, started_at, completed_at, changes_detected_count, records_fetched, error_code
         FROM data_fetch_runs
        ORDER BY started_at DESC
        LIMIT 5`
    );
    const [recentChanges] = await pool.query<LatestChangeRow[]>(
      `SELECT change_type, entity_id, severity, created_at
         FROM detected_changes
        ORDER BY created_at DESC
        LIMIT 10`
    );
    const [openIncidents] = await pool.query<OpenIncidentRow[]>(
      `SELECT id, incident_type, status, created_at
         FROM data_incidents
        WHERE status IN ('open', 'investigating')
        ORDER BY created_at DESC
        LIMIT 10`
    );

    return NextResponse.json({
      ok: true,
      canonicalBrawlers: {
        active: activeBrawlerCount.count,
        inactive: inactiveBrawlerCount.count,
      },
      recentFetchRuns: latestFetchRuns,
      recentChanges,
      openIncidents,
    });
  } catch (error) {
    logSafeError("catalog-status", "MYSQL_ERROR", error);
    return NextResponse.json(errorBody("MYSQL_ERROR", "Failed to read catalog status."), {
      status: 500,
    });
  }
}
