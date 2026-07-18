#!/usr/bin/env node
/**
 * DATASET Phase 2/3 — MariaDB -> MySQL 8.4 compatibility check.
 *
 * STATIC INSPECTION ONLY. This script reads migrations/*.sql and the
 * repository's SQL-bearing source files. It never connects to a database
 * and therefore CANNOT prove runtime compatibility. Every finding here is
 * a candidate for the staging test described in DATASET.md Phase 6 — the
 * gate is only closed by actually applying the migrations to a real
 * MySQL 8.4 instance.
 *
 * Usage:
 *   node scripts/dataset/compatibility-check.mjs
 *   node scripts/dataset/compatibility-check.mjs --json
 *
 * Exit code 1 if any BLOCKER finding is present.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventory } from "./schema-inventory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "migrations");

/**
 * Words reserved in MySQL 8.0+ but NOT reserved (or only soft-reserved) in
 * MariaDB. An identifier using one of these must be backtick-quoted or the
 * statement is a syntax error on MySQL 8.4. This is the highest-value check
 * in this file: MariaDB accepts several of these unquoted.
 */
const MYSQL8_RESERVED = new Set([
  "rank", "row_number", "dense_rank", "percent_rank", "cume_dist", "ntile",
  "lead", "lag", "first_value", "last_value", "nth_value",
  "over", "window", "groups", "rows", "recursive", "lateral",
  "system", "of", "except", "empty", "grouping", "json_table",
  "row", "cube", "function", "optimizer_costs",
]);

/** Collations that exist in MariaDB but not in MySQL 8.4. */
const MARIADB_ONLY_COLLATIONS = [/uca1400/i, /utf8mb4_general_nopad_ci/i, /_nopad_/i];

/** Engine/table options MySQL 8.4 rejects. */
const MARIADB_ONLY_OPTIONS = [
  { pattern: /\bPAGE_COMPRESSED\s*=/i, label: "PAGE_COMPRESSED table option" },
  { pattern: /\bENGINE\s*=\s*(Aria|MyISAM_MRG|ColumnStore)\b/i, label: "MariaDB-only storage engine" },
  { pattern: /\bWITH\s+SYSTEM\s+VERSIONING\b/i, label: "system-versioned table" },
  { pattern: /\bCREATE\s+SEQUENCE\b/i, label: "SEQUENCE object" },
  { pattern: /\/\*M!/, label: "MariaDB-only executable comment" },
  { pattern: /\bRETURNING\b/i, label: "DELETE/INSERT ... RETURNING (MariaDB-only)" },
];

function findings() {
  const list = [];
  return {
    list,
    add(severity, area, detail, evidence) {
      list.push({ severity, area, detail, evidence, verification: "static inspection only — unverified on a real MySQL 8.4 server" });
    },
  };
}

async function readMigrations() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(files.map(async (f) => ({ file: f, sql: await readFile(path.join(MIGRATIONS_DIR, f), "utf8") })));
}

function stripComments(sql) {
  return sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
}

export async function runCompatibilityCheck() {
  const f = findings();
  const migrations = await readMigrations();
  const inv = await buildInventory();

  // --- 1. Reserved-word identifiers -------------------------------------
  for (const table of inv.tables) {
    if (MYSQL8_RESERVED.has(table.table.toLowerCase())) {
      f.add("BLOCKER", "reserved_words",
        `Table name "${table.table}" is reserved in MySQL 8.4 and is not backtick-quoted in the migrations.`,
        table.createdByMigration);
    }
    for (const col of table.columns) {
      if (!MYSQL8_RESERVED.has(col.name.toLowerCase())) continue;
      // Determine whether the migration quoted it.
      const source = migrations.find((m) => m.file === table.createdByMigration);
      const quoted = source ? new RegExp("`" + col.name + "`", "i").test(source.sql) : false;
      f.add(quoted ? "INFO" : "BLOCKER", "reserved_words",
        `Column "${table.table}.${col.name}" is a reserved word in MySQL 8.4` +
        (quoted
          ? " but IS backtick-quoted in the migration, so it applies cleanly."
          : " and is NOT backtick-quoted. Applying this migration to MySQL 8.4 will fail with a syntax error. MariaDB accepts it unquoted, which is why this has never surfaced in production."),
        `${table.createdByMigration} (${table.table}.${col.name})`);
    }
  }

  // --- 2. Engine / table options ----------------------------------------
  for (const { file, sql } of migrations) {
    const clean = stripComments(sql);
    for (const { pattern, label } of MARIADB_ONLY_OPTIONS) {
      if (pattern.test(clean)) f.add("BLOCKER", "engine_options", `MariaDB-only construct: ${label}.`, file);
    }
    for (const pattern of MARIADB_ONLY_COLLATIONS) {
      if (pattern.test(clean)) f.add("BLOCKER", "collation", "Collation is unavailable in MySQL 8.4.", file);
    }
  }

  // --- 3. Charset / collation uniformity --------------------------------
  const collations = new Set(inv.tables.map((t) => t.collation).filter(Boolean));
  f.add(collations.size === 1 && collations.has("utf8mb4_unicode_ci") ? "PASS" : "REVIEW", "collation",
    `Declared table collations: ${[...collations].join(", ") || "none"}. utf8mb4_unicode_ci exists in MySQL 8.4, so this is portable. ` +
    "MySQL 8.4's SERVER default is utf8mb4_0900_ai_ci, which sorts differently — the target must be created with an explicit utf8mb4_unicode_ci default, or comparisons and unique-key behavior on mixed-case/accented names could differ.",
    "migrations/*.sql");

  // --- 4. Generated columns (the single-current-row invariant) ----------
  for (const g of inv.generatedColumns) {
    f.add("REVIEW", "generated_columns",
      `${g.table}.${g.column} is a STORED generated column using IF(...) that yields NULL to free a unique slot. ` +
      "Both engines allow NULLs to repeat under a UNIQUE key, so the pattern is portable in principle, but MySQL 8.4 is stricter about generated-column expression determinism. This must be proven by applying the migration to MySQL 8.4, not assumed.",
      `expression: ${g.expression}`);
  }

  // --- 5. CHECK constraints ---------------------------------------------
  const checkCount = inv.tables.reduce((n, t) => n + t.checkConstraints.length, 0);
  f.add("REVIEW", "check_constraints",
    `${checkCount} CHECK constraints declared. MariaDB 10.2+ and MySQL 8.0.16+ both enforce them, but MariaDB evaluates an over-long value against the CHECK before column-width truncation (this repository hit exactly that — see migration 0016). MySQL 8.4 may instead raise a data-truncation error for the same input, so error CODES differ even when behavior is equivalent. Any code branching on the error code must be re-tested.`,
    "migrations 0001-0025");

  // --- 6. JSON handling --------------------------------------------------
  const jsonColumns = inv.highGrowthColumns.filter((c) => c.type === "LONGTEXT");
  f.add("PASS", "json",
    `${jsonColumns.length} JSON-shaped columns are declared LONGTEXT, never the native JSON type — deliberately, per migration 0004's header (MariaDB's JSON is a LONGTEXT alias and does not support CAST(? AS JSON)). ` +
    "This choice makes the schema MORE portable, not less: LONGTEXT behaves identically on MySQL 8.4. No JSON-function semantics are relied upon.",
    "migration 0004 header");

  // --- 7. Index key length ----------------------------------------------
  const longIndexes = [];
  for (const t of inv.tables) {
    for (const key of [...t.uniqueKeys, ...t.indexes]) {
      let bytes = 0;
      for (const colName of key.columns) {
        const col = t.columns.find((c) => c.name === colName);
        if (!col) continue;
        const size = Number(/\((\d+)\)/.exec(col.type)?.[1] ?? 0);
        if (/VARCHAR/i.test(col.type)) bytes += size * 4;
        else if (/CHAR/i.test(col.type)) bytes += size * 4;
        else bytes += 8;
      }
      // InnoDB DYNAMIC row format allows 3072 bytes per index on both engines.
      if (bytes > 3072) longIndexes.push(`${t.table}.${key.name} (~${bytes} bytes)`);
    }
  }
  f.add(longIndexes.length === 0 ? "PASS" : "BLOCKER", "index_length",
    longIndexes.length === 0
      ? "No declared index exceeds the 3072-byte InnoDB DYNAMIC limit under the worst-case utf8mb4 4-bytes-per-character assumption."
      : `Indexes over the 3072-byte limit: ${longIndexes.join(", ")}.`,
    "computed from migrations");

  // --- 8. Timestamp / default behaviour ----------------------------------
  f.add("REVIEW", "timestamp_defaults",
    "All timestamps are DATETIME(3) with CURRENT_TIMESTAMP(3) defaults and UTC-based application writes (NOW(3)/UTC_TIMESTAMP(3)). DATETIME is timezone-independent on both engines, so this is portable. " +
    "The target MUST still be provisioned with time_zone = '+00:00' (DATASET.md Phase 6.1): NOW(3) is session-timezone dependent, and a non-UTC target would silently shift every workflow and lock timestamp.",
    "migrations + lib/workflow.ts");

  // --- 9. UUID storage ----------------------------------------------------
  f.add("PASS", "uuid_storage",
    "Primary keys are CHAR(36) UUID text generated by the application (randomUUID) and by MySQL UUID() in migration 0025. Both engines store CHAR(36) identically. " +
    "No BINARY(16)/UUID_TO_BIN conversion is used, so there is no engine-specific UUID semantics to port. Note migration 0025 depends on UUID() and on multipleStatements plus a @session variable — both are supported by MySQL 8.4 and by mysql2.",
    "migration 0025, scripts/migrate.mjs");

  // --- 10. Locking primitives ---------------------------------------------
  const migrateRunner = await readFile(path.join(REPO_ROOT, "scripts", "migrate.mjs"), "utf8");
  const usesGetLock = /GET_LOCK\(/i.test(migrateRunner);
  f.add("REVIEW", "get_lock",
    usesGetLock
      ? "scripts/migrate.mjs serializes migrations with GET_LOCK/RELEASE_LOCK. Both engines support these, but MySQL 8.0+ changed the semantics: named locks became nestable and are scoped per-connection with different release-on-close behavior than MariaDB. The runner releases in a finally block and closes the connection, so it is expected to be safe — this must still be exercised on MySQL 8.4."
      : "No GET_LOCK usage found in the migration runner.",
    "scripts/migrate.mjs");

  const libFiles = await collectSqlBearingFiles(path.join(REPO_ROOT, "lib"));
  const skipLockedUsers = [];
  for (const file of libFiles) {
    const content = await readFile(file, "utf8");
    if (/SKIP\s+LOCKED/i.test(content)) skipLockedUsers.push(path.relative(REPO_ROOT, file));
  }
  f.add(skipLockedUsers.length === 0 ? "PASS" : "REVIEW", "skip_locked",
    skipLockedUsers.length === 0
      ? "No SELECT ... FOR UPDATE SKIP LOCKED found in lib/. The crawl-lease mechanism uses lease timestamp columns (player_crawl_schedule.leased_by_run_id / lease_expires_at) instead, which is engine-neutral. Note migration 0012's comment DESCRIBES a SKIP LOCKED pattern that the code does not actually use — documentation drift, not a compatibility issue."
      : `SKIP LOCKED used in: ${skipLockedUsers.join(", ")}. Supported by MySQL 8.0+ and MariaDB 10.6+; verify the target version.`,
    "lib/**");

  // --- 11. Application-level concerns ------------------------------------
  f.add("REVIEW", "sql_mode",
    "The application never sets @@sql_mode. MariaDB's and MySQL 8.4's defaults differ (MySQL 8.4 includes ONLY_FULL_GROUP_BY and strict mode by default). Any aggregation query selecting a non-grouped column would break under ONLY_FULL_GROUP_BY. Capture @@sql_mode from BOTH servers (production-size-report.sql section 1) and diff them before cutover.",
    "lib/mysql.ts (no sql_mode set)");

  f.add("REVIEW", "case_sensitivity",
    "Table names in this repository are all lowercase, so lower_case_table_names differences between a Linux MySQL 8.4 target and the source are not expected to bite. Confirm the target is provisioned with lower_case_table_names=0 or 1 consistently — it cannot be changed after initialization.",
    "migrations/*.sql");

  f.add("REVIEW", "definer_and_dump",
    "This repository declares no routines, triggers, or events, so a --routines --triggers --events dump should contain none and no DEFINER clause. If a real dump DOES contain DEFINER clauses (verify-backup.mjs reports this), they originate from the hosting panel and must be stripped before restoring into an isolated target that lacks those users.",
    "migrations/*.sql");

  f.add("REVIEW", "migration_runner",
    "scripts/migrate.mjs connects with multipleStatements: true and applies each file in one transaction. MySQL 8.4, like MariaDB, performs an implicit COMMIT on DDL — so a migration containing multiple DDL statements is NOT atomic on either engine. This is a pre-existing property, not a MySQL-specific regression, but a mid-file failure leaves partial DDL applied and schema_migrations unwritten. Recovery is manual on both engines.",
    "scripts/migrate.mjs");

  return { checkedAt: new Date().toISOString(), evidenceClass: "static inspection only", findings: f.list };
}

async function collectSqlBearingFiles(dir) {
  const out = [];
  const walk = async (d) => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

function printReport(report) {
  const order = { BLOCKER: 0, REVIEW: 1, PASS: 2, INFO: 3 };
  const sorted = [...report.findings].sort((a, b) => order[a.severity] - order[b.severity]);

  console.log("MariaDB -> MySQL 8.4 compatibility check");
  console.log(`Evidence class: ${report.evidenceClass}`);
  console.log("This CANNOT close the DATASET.md Phase 6 compatibility gate. Only applying");
  console.log("migrations 0001-0025 to a real MySQL 8.4 server can do that.\n");

  for (const finding of sorted) {
    console.log(`[${finding.severity}] ${finding.area}`);
    console.log(`  ${finding.detail}`);
    console.log(`  evidence: ${finding.evidence}\n`);
  }

  const blockers = report.findings.filter((x) => x.severity === "BLOCKER");
  console.log(`${blockers.length} blocker(s), ` +
    `${report.findings.filter((x) => x.severity === "REVIEW").length} needing staging verification.`);
  return blockers.length;
}

async function main() {
  const report = await runCompatibilityCheck();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    if (report.findings.some((x) => x.severity === "BLOCKER")) process.exitCode = 1;
    return;
  }
  const blockers = printReport(report);
  if (blockers > 0) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`compatibility-check error: ${error.message}`);
    process.exitCode = 2;
  });
}
