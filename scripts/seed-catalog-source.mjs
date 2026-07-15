#!/usr/bin/env node
/**
 * Registers the "Official Brawl Stars API" data source and its verified
 * /v1/brawlers source_endpoint row (BRAWLRANKS_WEBSITE_SPEC.md Section 7.1 /
 * 7.21). This is data seeding, not schema DDL — it is intentionally kept out
 * of migrations/*.sql so it can be re-run (e.g. to bump verified_at) without
 * tripping the migration runner's checksum-drift protection.
 *
 * Idempotent: uses INSERT ... ON DUPLICATE KEY UPDATE keyed on the UNIQUE
 * columns (data_sources.name, source_endpoints (data_source_id,
 * endpoint_category)), so running this repeatedly never creates duplicate
 * rows.
 *
 * Usage: node scripts/seed-catalog-source.mjs
 */

import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";

const SOURCE_NAME = "official-brawl-stars-api";
const ENDPOINT_CATEGORY = "brawlers_catalog";
const ENDPOINT_PATH = "/v1/brawlers";

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
    const dataSourceId = randomUUID();
    await connection.execute(
      `INSERT INTO data_sources
         (id, name, source_type, reliability_weight, priority_rank, is_enabled)
       VALUES (?, ?, 'official_api', 1.000, 10, 1)
       ON DUPLICATE KEY UPDATE
         source_type = VALUES(source_type),
         is_enabled = VALUES(is_enabled)`,
      [dataSourceId, SOURCE_NAME]
    );

    const [[sourceRow]] = await connection.query(
      "SELECT id FROM data_sources WHERE name = ?",
      [SOURCE_NAME]
    );
    const resolvedSourceId = sourceRow.id;

    const endpointId = randomUUID();
    await connection.execute(
      `INSERT INTO source_endpoints
         (id, data_source_id, endpoint_category, path, method, schema_version, is_enabled, verified_at, verified_against_doc_version)
       VALUES (?, ?, ?, ?, 'GET', 'v1', 1, NOW(3), 'session-defensive-shape')
       ON DUPLICATE KEY UPDATE
         path = VALUES(path),
         is_enabled = VALUES(is_enabled),
         verified_at = VALUES(verified_at),
         verified_against_doc_version = VALUES(verified_against_doc_version)`,
      [endpointId, resolvedSourceId, ENDPOINT_CATEGORY, ENDPOINT_PATH]
    );

    console.log(`Seeded data_source "${SOURCE_NAME}" (id=${resolvedSourceId}).`);
    console.log(`Seeded source_endpoint "${ENDPOINT_CATEGORY}" -> ${ENDPOINT_PATH}.`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`Seed failed: ${error.message}`);
  process.exitCode = 1;
});
