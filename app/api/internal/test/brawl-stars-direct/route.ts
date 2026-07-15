import { randomUUID } from "node:crypto";
import mysql, { type Connection } from "mysql2/promise";
import { NextResponse } from "next/server";
import type { ResultSetHeader } from "mysql2";
import { verifyInternalCronBearer } from "@/lib/auth";
import { fetchBrawlersFromProxy, validateProxyEnvelope } from "@/lib/proxy";
import { stableStringify, sha256Hex } from "@/lib/hash";
import { errorBody, logSafeError } from "@/lib/errors";

/**
 * TEMPORARY, ONE-OFF DIAGNOSTIC ENDPOINT.
 *
 * Runs the full proxy -> official API -> validate -> MySQL insert chain
 * using a MySQL password supplied only via the `x-db-test-password` header
 * for this single request — never an environment variable, never the
 * shared pool in lib/mysql.ts (which is intentionally not imported or
 * modified here). The supplied password is never logged, hashed, stored,
 * written to a file, added to an environment variable, or returned in any
 * response. This file, and the temporary-credential pattern it uses, is
 * meant to be deleted once Hostinger's environment-variable injection is
 * fixed — see BRAWLRANKS_WEBSITE_SPEC.md Section 24 for the intended
 * env-var-based architecture this endpoint deliberately bypasses.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Never linked from any public page and never intended to be crawled.
const NOINDEX_HEADERS = { "X-Robots-Tag": "noindex, nofollow" };

const SOURCE = "official-brawl-stars-api";
const ENDPOINT = "/v1/brawlers";
const MAX_DUPLICATE_RUN_ID_RETRIES = 1;

type Stage = "auth" | "input_validation" | "config" | "proxy" | "proxy_validation" | "mysql";

function failure(
  status: number,
  stage: Stage,
  code: string,
  message: string,
  extra?: Record<string, unknown>
) {
  return NextResponse.json(
    {
      ok: false,
      stage,
      code,
      errno: null,
      sqlState: null,
      message,
      ...extra,
    },
    { status, headers: NOINDEX_HEADERS }
  );
}

function parsePort(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isDuplicateRunIdError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ER_DUP_ENTRY"
  );
}

/** Safe MySQL driver error fields only — never a stack trace, never the password. */
function safeMysqlErrorFields(error: unknown) {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  return {
    code: typeof record.code === "string" ? record.code : "MYSQL_ERROR",
    errno: typeof record.errno === "number" ? record.errno : null,
    sqlState: typeof record.sqlState === "string" ? record.sqlState : null,
    message: error instanceof Error ? error.message : "Failed to connect to or write to MySQL.",
  };
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("brawl-stars-direct", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), {
      status: 401,
      headers: NOINDEX_HEADERS,
    });
  }

  // The temporary MySQL password is read ONLY from this header, for this
  // single request. It is never logged, hashed, persisted, written to a
  // file, added to an environment variable, or echoed back in any response.
  const dbTestPassword = request.headers.get("x-db-test-password");
  if (!dbTestPassword) {
    return failure(
      400,
      "input_validation",
      "MISSING_PASSWORD",
      "The x-db-test-password header is required and must not be empty."
    );
  }

  const host = process.env.DB_HOST;
  const port = parsePort(process.env.DB_PORT);
  const database = process.env.DB_NAME;
  const user = process.env.DB_USER;

  if (!host || !port || !database || !user) {
    return failure(
      500,
      "config",
      "SERVER_MISCONFIGURED",
      "DB_HOST, DB_PORT, DB_NAME, and DB_USER must all be configured."
    );
  }

  // Step 1: DigitalOcean proxy -> official Brawl Stars API (reuses the
  // existing proxy client, which already reads DIGITALOCEAN_PROXY_URL and
  // PROXY_SHARED_SECRET — nothing about the proxy is duplicated or changed).
  const proxyResult = await fetchBrawlersFromProxy();

  if (!proxyResult.proxyReached) {
    const code = proxyResult.transportError === "proxy_timeout" ? "PROXY_TIMEOUT" : "PROXY_UNREACHABLE";
    logSafeError("brawl-stars-direct", code, proxyResult.transportError);
    return failure(502, "proxy", code, "Could not reach the DigitalOcean proxy.", {
      proxyReached: false,
      officialApiReached: false,
      durationMs: Date.now() - startedAt,
    });
  }

  const validated = validateProxyEnvelope(proxyResult);
  if (!validated) {
    logSafeError("brawl-stars-direct", "INVALID_PROXY_RESPONSE", `httpStatus=${proxyResult.httpStatus}`);
    return failure(
      502,
      "proxy_validation",
      "INVALID_PROXY_RESPONSE",
      "Proxy response failed validation (status, ok flag, or payload.items shape).",
      {
        proxyReached: true,
        officialApiReached: false,
        durationMs: Date.now() - startedAt,
      }
    );
  }

  const payloadJson = stableStringify(validated.payload);
  const payloadHash = sha256Hex(payloadJson);
  const fetchedAt = new Date(validated.fetchedAt);
  const fetchedAtSafe = Number.isNaN(fetchedAt.getTime()) ? new Date() : fetchedAt;
  const brawlerCount = Array.isArray(validated.payload.items) ? validated.payload.items.length : 0;

  // Step 2: one-request MySQL connection — NOT the shared pool from
  // lib/mysql.ts — using the header-supplied password only for the
  // lifetime of this single connection.
  let connection: Connection | null = null;
  let runId = randomUUID();
  let insertId: number | null = null;

  try {
    connection = await mysql.createConnection({
      host,
      port,
      database,
      user,
      password: dbTestPassword,
      connectTimeout: 10_000,
      charset: "utf8mb4",
    });

    let attempts = 0;
    while (insertId === null) {
      try {
        const [result] = await connection.execute<ResultSetHeader>(
          `INSERT INTO api_test_snapshots
             (source, endpoint, http_status, payload, payload_hash, fetched_at, received_at, run_id)
           VALUES (?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?)`,
          [
            SOURCE,
            ENDPOINT,
            validated.officialApiStatus,
            payloadJson,
            payloadHash,
            fetchedAtSafe,
            new Date(),
            runId,
          ]
        );
        insertId = result.insertId;
      } catch (insertError) {
        if (isDuplicateRunIdError(insertError) && attempts < MAX_DUPLICATE_RUN_ID_RETRIES) {
          attempts += 1;
          runId = randomUUID();
          continue;
        }
        throw insertError;
      }
    }
  } catch (error) {
    // Log only safe, non-sensitive fields — never the raw error object,
    // never the connection config, and never the supplied password.
    logSafeError("brawl-stars-direct", "MYSQL_ERROR", error);

    return failure(502, "mysql", "MYSQL_ERROR", "Failed to connect to or write to MySQL.", {
      proxyReached: true,
      officialApiReached: true,
      mysqlConnected: false,
      snapshotInserted: false,
      ...safeMysqlErrorFields(error),
      durationMs: Date.now() - startedAt,
    });
  } finally {
    // Always close the temporary connection, success or failure.
    if (connection) {
      await connection.end().catch(() => {
        // Best-effort close — there is nothing sensitive to leak either way.
      });
    }
  }

  return NextResponse.json(
    {
      ok: true,
      runId,
      proxyReached: true,
      officialApiReached: true,
      officialApiStatus: validated.officialApiStatus,
      brawlerCount,
      mysqlConnected: true,
      snapshotInserted: true,
      insertId,
      payloadHash,
      durationMs: Date.now() - startedAt,
    },
    { headers: NOINDEX_HEADERS }
  );
}
