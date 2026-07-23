#!/usr/bin/env node
/**
 * BrawlRanks migration runner.
 *
 * Usage:
 *   node scripts/migrate.mjs status   # list applied/pending migrations, no changes
 *   node scripts/migrate.mjs up       # apply all pending migrations, in order
 *
 * Design (see PHASE2.md "Migration System" for the full write-up):
 *   - Migrations are discovered from migrations/*.sql, applied in
 *     filename-sorted (deterministic) order.
 *   - A `schema_migrations` bookkeeping table (bootstrap-created with
 *     `CREATE TABLE IF NOT EXISTS`) tracks version, name, a SHA-256
 *     checksum of the file's exact contents, and when it was applied.
 *   - Before applying anything, every ALREADY-APPLIED migration's current
 *     on-disk checksum is compared against the recorded one. Any mismatch
 *     (someone edited a migration that already ran) aborts immediately —
 *     nothing is silently re-applied or ignored.
 *   - A MariaDB named lock (GET_LOCK/RELEASE_LOCK) serializes concurrent
 *     runs of this script against the same database, so two deploys (or a
 *     human and a cron job) can never apply migrations at the same time.
 *   - Every migration file runs inside its own transaction. A failure
 *     rolls back that migration's statements and stops immediately —
 *     later pending migrations are never attempted.
 *   - This script only ever CREATEs new tables. It never drops or alters
 *     an existing table, and it never touches `api_test_snapshots`.
 *   - There is no automatic `down`/rollback command. Rollback, if ever
 *     needed, is a manual, reviewed action — see PHASE2.md "Rollback
 *     Procedure" for the exact DROP TABLE statements, run by a human.
 *
 * Never prints DB_PASSWORD / BRAWL_DB_SECRET_V1 or any other secret.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const LOCK_NAME = "brawlranks_schema_migration";
const LOCK_TIMEOUT_SECONDS = 30;

/**
 * Explicit, reviewed checksum supersessions.
 *
 * Maps a migration version to the set of PRIOR file checksums that are known
 * to describe a schema IDENTICAL to the current file's. An environment whose
 * `schema_migrations` row recorded one of these prior checksums is therefore
 * NOT flagged as drift — because the on-disk change that produced the new
 * checksum could not have changed the resulting schema.
 *
 * This is the ONLY sanctioned way an already-applied checksum may differ from
 * its file, and it is deliberately narrow:
 *   - Every entry must correspond to a change that cannot alter the applied
 *     schema (e.g. backtick-quoting a reserved-word identifier, or a pure
 *     comment/whitespace change).
 *   - It maps a specific (version, oldChecksum) -> the current file only.
 *   - ALL other checksum mismatches still abort. The guard is not weakened
 *     for anything outside this allowlist.
 *
 * No production write is performed to reconcile the old row: the runner simply
 * accepts the recorded prior checksum as equivalent. The row may be left as-is
 * indefinitely.
 */
const ACCEPTED_PRIOR_CHECKSUMS = {
  // 0014: `battle_teams.rank` was backtick-quoted so migrations apply cleanly
  // on MySQL 8.4, where RANK is a reserved word (window functions). MariaDB
  // accepts it unquoted, so production recorded the pre-quote checksum below.
  // Backticks are lexical only — the battle_teams schema is byte-identical on
  // both engines. See DATASET Phase 3 (docs/dataset/phase3-mysql84-compat.md).
  "0014": new Set([
    "aab4acd247747216c2a56ad2396d0c724d7fb74df02ba8b4fc36b075a4272302",
  ]),
};

/**
 * True when `appliedChecksum` is an explicitly allowlisted prior checksum for
 * this version — i.e. a reviewed, schema-preserving supersession, not drift.
 */
function isAcceptedPriorChecksum(version, appliedChecksum) {
  return ACCEPTED_PRIOR_CHECKSUMS[version]?.has(appliedChecksum) ?? false;
}

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
    multipleStatements: true,
    charset: "utf8mb4",
    connectTimeout: 10_000,
  });
}

async function ensureBookkeepingTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(20) NOT NULL,
      name VARCHAR(255) NOT NULL,
      checksum CHAR(64) NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      execution_ms INT NULL,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function discoverMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort();

  return Promise.all(
    sqlFiles.map(async (filename) => {
      const match = /^(\d+)_(.+)\.sql$/.exec(filename);
      if (!match) {
        throw new Error(
          `Migration filename "${filename}" does not match the required "NNNN_name.sql" pattern.`
        );
      }
      const [, version, name] = match;
      const filePath = path.join(MIGRATIONS_DIR, filename);
      const content = await readFile(filePath, "utf8");
      const checksum = createHash("sha256").update(content, "utf8").digest("hex");
      return { version, name, filename, content, checksum };
    })
  );
}

async function loadAppliedMigrations(connection) {
  const [rows] = await connection.query(
    "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version"
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.version, row);
  }
  return map;
}

function verifyNoChecksumDrift(migrationFiles, applied) {
  for (const file of migrationFiles) {
    const appliedRow = applied.get(file.version);
    if (!appliedRow || appliedRow.checksum === file.checksum) continue;

    // A reviewed, schema-preserving supersession is not drift.
    if (isAcceptedPriorChecksum(file.version, appliedRow.checksum)) {
      console.log(
        `[note] migration ${file.version} (${file.filename}) recorded an allowlisted prior ` +
          `checksum (${appliedRow.checksum.slice(0, 12)}...). Accepted as a reviewed, ` +
          "schema-preserving supersession — see ACCEPTED_PRIOR_CHECKSUMS in scripts/migrate.mjs."
      );
      continue;
    }

    throw new Error(
      `Checksum drift detected for migration ${file.version} (${file.filename}): ` +
        `applied checksum ${appliedRow.checksum.slice(0, 12)}... does not match the current file's ` +
        `checksum ${file.checksum.slice(0, 12)}.... This migration was already applied with different ` +
        "content. Refusing to proceed — do not edit an applied migration; create a new one instead."
    );
  }
}

async function withNamedLock(connection, fn) {
  const [[lockRow]] = await connection.query("SELECT GET_LOCK(?, ?) AS acquired", [
    LOCK_NAME,
    LOCK_TIMEOUT_SECONDS,
  ]);
  if (Number(lockRow.acquired) !== 1) {
    throw new Error(
      `Could not acquire the "${LOCK_NAME}" migration lock within ${LOCK_TIMEOUT_SECONDS}s — ` +
        "another migration run may already be in progress. Refusing to proceed concurrently."
    );
  }
  try {
    return await fn();
  } finally {
    await connection.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]).catch(() => {
      // Best-effort release; the lock also has no fixed TTL in MariaDB but
      // is automatically released when this connection closes.
    });
  }
}

async function cmdStatus() {
  const connection = await getConnection();
  try {
    await ensureBookkeepingTable(connection);
    const migrationFiles = await discoverMigrationFiles();
    const applied = await loadAppliedMigrations(connection);

    console.log(`Migrations directory: ${MIGRATIONS_DIR}`);
    console.log(`Discovered ${migrationFiles.length} migration file(s).\n`);

    let pendingCount = 0;
    for (const file of migrationFiles) {
      const appliedRow = applied.get(file.version);
      if (appliedRow) {
        let driftNote = "";
        if (appliedRow.checksum !== file.checksum) {
          driftNote = isAcceptedPriorChecksum(file.version, appliedRow.checksum)
            ? "  (allowlisted prior checksum — reviewed supersession)"
            : "  ** CHECKSUM DRIFT **";
        }
        console.log(`[applied] ${file.version}_${file.name}  (applied_at=${appliedRow.applied_at.toISOString()})${driftNote}`);
      } else {
        pendingCount += 1;
        console.log(`[pending] ${file.version}_${file.name}`);
      }
    }

    console.log(`\n${pendingCount} pending, ${migrationFiles.length - pendingCount} applied.`);
    verifyNoChecksumDrift(migrationFiles, applied);
  } finally {
    await connection.end();
  }
}

async function cmdUp() {
  const connection = await getConnection();
  try {
    await ensureBookkeepingTable(connection);

    await withNamedLock(connection, async () => {
      const migrationFiles = await discoverMigrationFiles();
      const applied = await loadAppliedMigrations(connection);
      verifyNoChecksumDrift(migrationFiles, applied);

      const pending = migrationFiles.filter((f) => !applied.has(f.version));
      if (pending.length === 0) {
        console.log("No pending migrations. Database is up to date.");
        return;
      }

      console.log(`Applying ${pending.length} pending migration(s)...\n`);

      for (const file of pending) {
        const startedAt = Date.now();
        console.log(`-> Applying ${file.version}_${file.name} ...`);

        try {
          await connection.beginTransaction();
          await connection.query(file.content);
          const executionMs = Date.now() - startedAt;
          await connection.query(
            "INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES (?, ?, ?, ?)",
            [file.version, file.name, file.checksum, executionMs]
          );
          await connection.commit();
          console.log(`   OK (${executionMs}ms)`);
        } catch (error) {
          await connection.rollback().catch(() => {});
          console.error(`   FAILED: ${error.message}`);
          console.error("   Migration run stopped. No later pending migrations were attempted.");
          process.exitCode = 1;
          return;
        }
      }

      console.log("\nAll pending migrations applied successfully.");
    });
  } finally {
    await connection.end();
  }
}

async function main() {
  const command = process.argv[2];

  if (command === "status") {
    await cmdStatus();
  } else if (command === "up") {
    await cmdUp();
  } else {
    console.error("Usage: node scripts/migrate.mjs <status|up>");
    process.exitCode = 1;
  }
}

// Exported for tests. The reconciliation allowlist is security-relevant, so it
// is exercised directly rather than only through the CLI.
export { ACCEPTED_PRIOR_CHECKSUMS, isAcceptedPriorChecksum, verifyNoChecksumDrift };

// Only run the CLI when invoked directly, so importing this module in a test
// does not attempt a database connection.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`Migration runner error: ${error.message}`);
    process.exitCode = 1;
  });
}
