#!/usr/bin/env node
/**
 * Registers the Phase 3 source_endpoints rows on the existing
 * "official-brawl-stars-api" data source (created by
 * scripts/seed-catalog-source.mjs in Phase 2 — this script requires that
 * row to already exist and fails clearly if it doesn't).
 *
 * Only endpoints independently corroborated this session against multiple
 * third-party mirrors of the official API documentation are registered
 * here (see PHASE3.md "Endpoint verification" for the full source list and
 * per-endpoint confidence level) — "events_rotation" is registered as
 * DISABLED (is_enabled = 0) since it was corroborated by only one source
 * this session, consistent with the task rule "register only verified
 * endpoints" and "if the MD marks a capability as unconfirmed, do not
 * invent it."
 *
 * Idempotent: INSERT ... ON DUPLICATE KEY UPDATE keyed on the UNIQUE
 * (data_source_id, endpoint_category) constraint.
 *
 * Usage: node scripts/seed-ingestion-sources.mjs
 */

import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";

const SOURCE_NAME = "official-brawl-stars-api";

const ENDPOINTS = [
  { category: "player_rankings", path: "/v1/rankings/{countryCode}/players", enabled: true },
  { category: "club_rankings", path: "/v1/rankings/{countryCode}/clubs", enabled: true },
  { category: "brawler_rankings", path: "/v1/rankings/{countryCode}/brawlers/{brawlerId}", enabled: true },
  { category: "player_profile", path: "/v1/players/{playerTag}", enabled: true },
  { category: "battle_log", path: "/v1/players/{playerTag}/battlelog", enabled: true },
  { category: "club_profile", path: "/v1/clubs/{clubTag}", enabled: true },
  { category: "events_rotation", path: "/v1/events", enabled: false },
];

function parsePort(raw) {
  if (!raw) return 3306;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`DB_PORT is set but is not a valid port number: "${raw}"`);
  }
  return parsed;
}

async function getConnection() {
  const host = process.env.DB_HOST;
  const port = parsePort(process.env.DB_PORT);
  const database = process.env.DB_NAME;
  const user = process.env.DB_USER;
  const password = process.env.BRAWL_DB_SECRET_V1;

  if (!host || !database || !user || !password) {
    throw new Error(
      "MySQL connection is not configured (missing DB_HOST/DB_NAME/DB_USER/BRAWL_DB_SECRET_V1)."
    );
  }

  return mysql.createConnection({
    host,
    port,
    database,
    user,
    password,
    charset: "utf8mb4",
    connectTimeout: 10_000,
  });
}

async function main() {
  const connection = await getConnection();
  try {
    const [[sourceRow]] = await connection.query("SELECT id FROM data_sources WHERE name = ?", [SOURCE_NAME]);
    if (!sourceRow) {
      throw new Error(
        `Data source "${SOURCE_NAME}" is not registered — run scripts/seed-catalog-source.mjs first.`
      );
    }
    const dataSourceId = sourceRow.id;

    for (const endpoint of ENDPOINTS) {
      const id = randomUUID();
      await connection.execute(
        `INSERT INTO source_endpoints
           (id, data_source_id, endpoint_category, path, method, schema_version, is_enabled, verified_at, verified_against_doc_version)
         VALUES (?, ?, ?, ?, 'GET', 'v1', ?, NOW(3), 'session-cross-referenced-third-party-mirrors')
         ON DUPLICATE KEY UPDATE
           path = VALUES(path),
           is_enabled = VALUES(is_enabled),
           verified_at = VALUES(verified_at),
           verified_against_doc_version = VALUES(verified_against_doc_version)`,
        [id, dataSourceId, endpoint.category, endpoint.path, endpoint.enabled ? 1 : 0]
      );
      console.log(`Seeded source_endpoint "${endpoint.category}" -> ${endpoint.path} (enabled=${endpoint.enabled}).`);
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`Seed failed: ${error.message}`);
  process.exitCode = 1;
});
