import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import { verifyInternalCronBearer } from "@/lib/auth";
import { getPool } from "@/lib/mysql";
import { errorBody, logSafeError } from "@/lib/errors";

// Node.js runtime required: this route uses mysql2.
export const runtime = "nodejs";

interface ConnectionCheckRow extends RowDataPacket {
  currentUser: string;
  authenticatedAs: string;
  databaseName: string | null;
  mysqlVersion: string;
  serverTime: Date | string;
}

/**
 * Safe, non-secret connection settings only — DB_PASSWORD is never read
 * or referenced anywhere in this file.
 */
function safeConnectionInfo() {
  return {
    dbHost: process.env.DB_HOST ?? null,
    dbPort: process.env.DB_PORT ?? null,
    dbName: process.env.DB_NAME ?? null,
    dbUser: process.env.DB_USER ?? null,
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function GET(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("mysql-connection", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), {
      status: 401,
    });
  }

  try {
    const pool = getPool();
    const [rows] = await pool.query<ConnectionCheckRow[]>(
      `SELECT CURRENT_USER() AS currentUser,
              USER() AS authenticatedAs,
              DATABASE() AS databaseName,
              VERSION() AS mysqlVersion,
              NOW() AS serverTime`
    );

    const row = rows[0];

    return NextResponse.json({
      ok: true,
      connected: true,
      currentUser: row.currentUser,
      authenticatedAs: row.authenticatedAs,
      databaseName: row.databaseName,
      mysqlVersion: row.mysqlVersion,
      serverTime: toIsoString(row.serverTime),
      connectionInfo: safeConnectionInfo(),
    });
  } catch (error) {
    // Log only a safe message server-side — never the raw error object,
    // which could otherwise carry a stack trace or driver-internal detail.
    logSafeError("mysql-connection", "MYSQL_CONNECTION_ERROR", error);

    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "MYSQL_CONNECTION_ERROR";
    const message = error instanceof Error ? error.message : "Failed to connect to MySQL.";

    return NextResponse.json(
      {
        ok: false,
        connected: false,
        code,
        message,
      },
      { status: 502 }
    );
  }
}
