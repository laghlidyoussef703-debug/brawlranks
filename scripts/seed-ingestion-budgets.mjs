#!/usr/bin/env node
/**
 * Seeds conservative default rate-limit budgets into ingestion_rate_budgets
 * (migration 0015). Idempotent (INSERT ... ON DUPLICATE KEY UPDATE) — safe
 * to re-run to adjust the configured ceilings.
 *
 * These numbers are CONFIGURED, CONSERVATIVE DEFAULTS, not a verified
 * measurement of the official Brawl Stars API's real rate limit — no live
 * proxy access was available this session (see PHASE3.md "Known
 * limitations"). Tighten or loosen them once real usage against the live
 * proxy has been observed and measured.
 *
 * Usage: node scripts/seed-ingestion-budgets.mjs
 */

import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";

const BUDGETS = [
  { scope: "global_daily", windowSeconds: 86_400, ceiling: 5000, reserved: 200 },
  { scope: "catalog", windowSeconds: 86_400, ceiling: 50, reserved: 0 },
  { scope: "rankings", windowSeconds: 86_400, ceiling: 300, reserved: 0 },
  { scope: "player_profile", windowSeconds: 3_600, ceiling: 500, reserved: 0 },
  { scope: "battle_log", windowSeconds: 3_600, ceiling: 1000, reserved: 0 },
  { scope: "club", windowSeconds: 86_400, ceiling: 200, reserved: 0 },
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
    for (const budget of BUDGETS) {
      const id = randomUUID();
      await connection.execute(
        `INSERT INTO ingestion_rate_budgets (id, budget_scope, window_seconds, request_ceiling, reserved_for_priority)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           window_seconds = VALUES(window_seconds),
           request_ceiling = VALUES(request_ceiling),
           reserved_for_priority = VALUES(reserved_for_priority)`,
        [id, budget.scope, budget.windowSeconds, budget.ceiling, budget.reserved]
      );
      console.log(`Seeded budget "${budget.scope}" (ceiling=${budget.ceiling}/${budget.windowSeconds}s, reserved=${budget.reserved}).`);
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`Seed failed: ${error.message}`);
  process.exitCode = 1;
});
