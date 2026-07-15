import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { verifyInternalCronBearer } from "@/lib/auth";
import { getPool } from "@/lib/mysql";
import { errorBody, logSafeError } from "@/lib/errors";

// Node.js runtime required: this route uses mysql2.
export const runtime = "nodejs";

interface SnapshotRow extends RowDataPacket {
  id: number;
  source: string;
  endpoint: string;
  http_status: number;
  payload: unknown;
  payload_hash: string;
  fetched_at: Date;
  received_at: Date;
  run_id: string;
}

function extractBrawlerCount(payload: unknown): number | null {
  if (payload && typeof payload === "object" && "items" in payload) {
    const items = (payload as { items?: unknown }).items;
    if (Array.isArray(items)) return items.length;
  }
  return null;
}

export async function GET(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("latest-snapshot", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), {
      status: 401,
    });
  }

  try {
    const pool = getPool();
    const [rows] = await pool.query<SnapshotRow[]>(
      `SELECT id, source, endpoint, http_status, payload, payload_hash, fetched_at, received_at, run_id
         FROM api_test_snapshots
        ORDER BY id DESC
        LIMIT 1`
    );

    const row = rows[0];
    if (!row) {
      return NextResponse.json(errorBody("NOT_FOUND", "No snapshot has been stored yet."), {
        status: 404,
      });
    }

    // payload is read only to derive a count — the full payload is never
    // returned by this endpoint.
    const rawPayload =
      typeof row.payload === "string" ? safeJsonParse(row.payload) : row.payload;

    return NextResponse.json({
      ok: true,
      id: row.id,
      source: row.source,
      endpoint: row.endpoint,
      http_status: row.http_status,
      payload_hash: row.payload_hash,
      fetched_at: row.fetched_at,
      received_at: row.received_at,
      run_id: row.run_id,
      brawlerCount: extractBrawlerCount(rawPayload),
    });
  } catch (error) {
    logSafeError("latest-snapshot", "MYSQL_ERROR", error);
    return NextResponse.json(errorBody("MYSQL_ERROR", "Failed to read the latest snapshot."), {
      status: 500,
    });
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
