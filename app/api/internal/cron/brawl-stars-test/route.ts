import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { ResultSetHeader } from "mysql2";
import { verifyInternalCronBearer } from "@/lib/auth";
import { fetchBrawlersFromProxy, validateProxyEnvelope } from "@/lib/proxy";
import { stableStringify, sha256Hex } from "@/lib/hash";
import { getWritePool } from "@/lib/mysql";
import { errorBody, logSafeError } from "@/lib/errors";

// Node.js runtime required: this route uses mysql2 and node:crypto.
export const runtime = "nodejs";

const SOURCE = "official-brawl-stars-api";
const ENDPOINT = "/v1/brawlers";
const MAX_DUPLICATE_RUN_ID_RETRIES = 1;

async function insertSnapshot(params: {
  runId: string;
  httpStatus: number;
  payloadJson: string;
  payloadHash: string;
  fetchedAt: Date;
}): Promise<number> {
  const pool = getWritePool();
  const [result] = await pool.execute<ResultSetHeader>(
    `INSERT INTO api_test_snapshots
       (source, endpoint, http_status, payload, payload_hash, fetched_at, received_at, run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      SOURCE,
      ENDPOINT,
      params.httpStatus,
      params.payloadJson,
      params.payloadHash,
      params.fetchedAt,
      new Date(),
      params.runId,
    ]
  );
  return result.insertId;
}

function isDuplicateRunIdError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ER_DUP_ENTRY"
  );
}

export async function POST(request: Request) {
  const startedAt = Date.now();

  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("brawl-stars-test", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), {
      status: 401,
    });
  }

  let runId = randomUUID();

  const proxyResult = await fetchBrawlersFromProxy();
  const durationMsBase = () => Date.now() - startedAt;

  if (!proxyResult.proxyReached) {
    const code = proxyResult.transportError === "proxy_timeout" ? "PROXY_TIMEOUT" : "PROXY_UNREACHABLE";
    logSafeError("brawl-stars-test", code, proxyResult.transportError);
    return NextResponse.json(
      {
        ...errorBody(code, "Could not reach the DigitalOcean proxy."),
        runId,
        proxyReached: false,
        officialApiReached: false,
        officialApiStatus: null,
        mysqlConnected: false,
        snapshotInserted: false,
        durationMs: durationMsBase(),
      },
      { status: 502 }
    );
  }

  const validated = validateProxyEnvelope(proxyResult);
  if (!validated) {
    logSafeError("brawl-stars-test", "INVALID_PROXY_RESPONSE", `httpStatus=${proxyResult.httpStatus}`);
    return NextResponse.json(
      {
        ...errorBody(
          "INVALID_PROXY_RESPONSE",
          "Proxy response failed validation (status, ok flag, or payload.items shape)."
        ),
        runId,
        proxyReached: true,
        officialApiReached: false,
        officialApiStatus: proxyResult.httpStatus,
        mysqlConnected: false,
        snapshotInserted: false,
        durationMs: durationMsBase(),
      },
      { status: 502 }
    );
  }

  const payloadJson = stableStringify(validated.payload);
  const payloadHash = sha256Hex(payloadJson);
  const fetchedAt = new Date(validated.fetchedAt);
  const fetchedAtSafe = Number.isNaN(fetchedAt.getTime()) ? new Date() : fetchedAt;
  const brawlerCount = Array.isArray(validated.payload.items) ? validated.payload.items.length : 0;

  let insertId: number | null = null;
  let attempts = 0;

  while (insertId === null) {
    try {
      insertId = await insertSnapshot({
        runId,
        httpStatus: validated.officialApiStatus,
        payloadJson,
        payloadHash,
        fetchedAt: fetchedAtSafe,
      });
    } catch (error) {
      if (isDuplicateRunIdError(error) && attempts < MAX_DUPLICATE_RUN_ID_RETRIES) {
        attempts += 1;
        runId = randomUUID();
        continue;
      }
      logSafeError("brawl-stars-test", "MYSQL_ERROR", error);
      return NextResponse.json(
        {
          ...errorBody("MYSQL_ERROR", "Failed to store the snapshot."),
          runId,
          proxyReached: true,
          officialApiReached: true,
          officialApiStatus: validated.officialApiStatus,
          brawlerCount,
          mysqlConnected: false,
          snapshotInserted: false,
          durationMs: durationMsBase(),
        },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({
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
    durationMs: durationMsBase(),
  });
}
