import { Socket } from "node:net";
import { NextResponse } from "next/server";
import type { RowDataPacket } from "mysql2";
import mysql2Package from "mysql2/package.json";
import { verifyInternalCronBearer } from "@/lib/auth";
import { getPool } from "@/lib/mysql";
import { errorBody, logSafeError } from "@/lib/errors";

// Node.js runtime required: this route uses mysql2 and node:net.
export const runtime = "nodejs";

// Never linked from any public page and never intended to be crawled.
const NOINDEX_HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

interface ConnectionCheckRow extends RowDataPacket {
  currentUser: string;
  authenticatedAs: string;
  databaseName: string | null;
  mysqlVersion: string;
  serverTime: Date | string;
}

/** Safe, non-secret connection settings only — the MySQL credential itself is never read here. */
function safeConnectionInfo() {
  return {
    dbHost: process.env.DB_HOST ?? null,
    dbPort: process.env.DB_PORT ?? null,
    dbName: process.env.DB_NAME ?? null,
    dbUser: process.env.DB_USER ?? null,
  };
}

interface TcpCheckResult {
  tcpReachable: boolean;
  tcpAddressFamily: string | null;
  tcpRemoteAddress: string | null;
}

/**
 * Opens a raw TCP connection to host:port with a short timeout, to prove or
 * disprove network reachability independently of MySQL authentication. The
 * socket is always destroyed before this resolves — nothing is left open.
 */
function checkTcpReachable(host: string, port: number, timeoutMs = 5000): Promise<TcpCheckResult> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;

    const finish = (result: TcpCheckResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.once("connect", () => {
      finish({
        tcpReachable: true,
        tcpAddressFamily: socket.remoteFamily ?? null,
        tcpRemoteAddress: socket.remoteAddress ?? null,
      });
    });

    socket.once("timeout", () => {
      finish({ tcpReachable: false, tcpAddressFamily: null, tcpRemoteAddress: null });
    });

    socket.once("error", () => {
      finish({ tcpReachable: false, tcpAddressFamily: null, tcpRemoteAddress: null });
    });

    socket.connect(port, host);
  });
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Safe MySQL driver error fields only — never a stack trace, never a secret. */
function safeMysqlErrorFields(error: unknown) {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  return {
    code: typeof record.code === "string" ? record.code : "MYSQL_CONNECTION_ERROR",
    errno: typeof record.errno === "number" ? record.errno : null,
    sqlState: typeof record.sqlState === "string" ? record.sqlState : null,
    message: error instanceof Error ? error.message : "Failed to connect to MySQL.",
  };
}

export async function GET(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("mysql-connection", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), {
      status: 401,
      headers: NOINDEX_HEADERS,
    });
  }

  const connectionInfo = safeConnectionInfo();
  const nodeVersion = process.version;
  const mysqlDriverVersion = mysql2Package.version ?? null;

  const rawPort = Number(process.env.DB_PORT);
  const tcpPort = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 3306;
  const tcpCheck = process.env.DB_HOST
    ? await checkTcpReachable(process.env.DB_HOST, tcpPort)
    : { tcpReachable: false, tcpAddressFamily: null, tcpRemoteAddress: null };

  const commonFields = {
    ...connectionInfo,
    ...tcpCheck,
    nodeVersion,
    mysqlDriverVersion,
    runtime: "nodejs" as const,
  };

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

    return NextResponse.json(
      {
        ok: true,
        connected: true,
        currentUser: row.currentUser,
        authenticatedAs: row.authenticatedAs,
        databaseName: row.databaseName,
        mysqlVersion: row.mysqlVersion,
        serverTime: toIsoString(row.serverTime),
        ...commonFields,
      },
      { headers: NOINDEX_HEADERS }
    );
  } catch (error) {
    // Log only safe, non-sensitive fields server-side — never the raw
    // error object (which could carry a stack trace) and never a secret.
    logSafeError("mysql-connection", "MYSQL_CONNECTION_ERROR", error);

    return NextResponse.json(
      {
        ok: false,
        connected: false,
        ...commonFields,
        ...safeMysqlErrorFields(error),
      },
      { status: 502, headers: NOINDEX_HEADERS }
    );
  }
}
