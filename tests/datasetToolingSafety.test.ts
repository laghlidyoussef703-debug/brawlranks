/**
 * DATASET Phase 1/2 tooling safety tests.
 *
 * These tests exist because the dataset tooling's ONLY job is to be safe:
 * a restore script that can be pointed at production, an audit script that
 * can write, or a manifest that can carry a secret would each be worse than
 * having no tooling at all. Every test below asserts a refusal, not a
 * feature.
 *
 * Pure/DB-free. Nothing here connects to a database, and nothing here reads
 * production configuration. The restore-script tests actually EXECUTE
 * scripts/dataset/restore-isolated.sh with hostile arguments and assert it
 * exits non-zero before reaching any client call — the guards are proven by
 * running them, not by reading them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const SCRIPTS_DIR = path.join(REPO_ROOT, "scripts", "dataset");
const RESTORE_SCRIPT = path.join(SCRIPTS_DIR, "restore-isolated.sh");

/**
 * Runs the restore script and returns its exit code and stderr. The script
 * is expected to refuse long before it would contact any database, so these
 * calls are safe even with no MySQL client installed.
 */
function runRestoreScript(args: string[]): { code: number; stderr: string } {
  try {
    execFileSync("bash", [RESTORE_SCRIPT, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      // Empty stdin: if a guard ever failed to fire and the script reached
      // its confirmation prompt, the read would get EOF and still not
      // proceed — so a bug can never turn this test into a real restore.
      input: "",
      timeout: 20_000,
    });
    return { code: 0, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stderr?: string };
    return { code: e.status ?? -1, stderr: e.stderr ?? "" };
  }
}

const bashAvailable = (() => {
  try {
    execFileSync("bash", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// restore-isolated.sh — target identity guards
// ---------------------------------------------------------------------------

test("restore script exists and is the only restore entry point", () => {
  assert.ok(existsSync(RESTORE_SCRIPT), "scripts/dataset/restore-isolated.sh must exist");
});

test("restore script refuses the real production database name", { skip: !bashAvailable }, () => {
  const { code, stderr } = runRestoreScript([
    "--backup", "/nonexistent/dump.sql",
    "--database", "u350003894_brawl2",
    "--assume-yes",
  ]);
  assert.notEqual(code, 0, "must exit non-zero for the production database name");
  assert.match(stderr, /Refusing to proceed/, "must refuse explicitly");
});

test("restore script refuses any name lacking the mandatory disposable prefix", { skip: !bashAvailable }, () => {
  for (const name of ["brawlranks", "staging_copy", "test_db", "restore_test"]) {
    const { code, stderr } = runRestoreScript([
      "--backup", "/nonexistent/dump.sql",
      "--database", name,
      "--assume-yes",
    ]);
    assert.notEqual(code, 0, `must refuse target name "${name}"`);
    assert.match(stderr, /brawlranks_restoretest_/, `refusal for "${name}" must name the required prefix`);
  }
});

test("restore script refuses a production marker even behind the correct prefix", { skip: !bashAvailable }, () => {
  // This is the important case: the prefix alone must not be a bypass.
  for (const name of [
    "brawlranks_restoretest_prod",
    "brawlranks_restoretest_u350003894_brawl2",
    "brawlranks_restoretest_production_copy",
    "brawlranks_restoretest_live",
  ]) {
    const { code, stderr } = runRestoreScript([
      "--backup", "/nonexistent/dump.sql",
      "--database", name,
      "--assume-yes",
    ]);
    assert.notEqual(code, 0, `must refuse "${name}" despite the valid prefix`);
    assert.match(stderr, /production marker/, `refusal for "${name}" must cite the production marker`);
  }
});

test("restore script refuses a non-loopback host unless explicitly overridden", { skip: !bashAvailable }, () => {
  const { code, stderr } = runRestoreScript([
    "--backup", "/nonexistent/dump.sql",
    "--database", "brawlranks_restoretest_ci",
    "--host", "db.example.com",
    "--assume-yes",
  ]);
  assert.notEqual(code, 0, "a remote host must be refused by default");
  assert.match(stderr, /not loopback/, "must explain the loopback requirement");
});

test("restore script requires an explicit target — it has no default database", { skip: !bashAvailable }, () => {
  const { code, stderr } = runRestoreScript(["--backup", "/nonexistent/dump.sql", "--assume-yes"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /--database is required/);
});

test("restore script never reads production environment variables", () => {
  const source = readFileSync(RESTORE_SCRIPT, "utf8");
  for (const secretVar of ["BRAWL_DB_SECRET_V1", "DB_HOST", "DB_NAME", "DB_USER", "DB_PORT"]) {
    // Mentioning the name in a comment explaining that it is ignored is fine;
    // an actual expansion ($VAR or ${VAR}) is not.
    assert.ok(
      !new RegExp(`\\$\\{?${secretVar}\\b`).test(source),
      `restore script must never expand ${secretVar} — a stray production env must not become the target`
    );
  }
});

// ---------------------------------------------------------------------------
// verify-backup — dump inspection against REALISTIC mariadb-dump output
// ---------------------------------------------------------------------------

/**
 * Builds a fixture that looks like what mariadb-dump actually emits, not a
 * tidy list of CREATE TABLE lines. It reproduces every property that broke
 * the real run: the sandbox preamble, the `-- Host: ... Database: ...`
 * header, DROP TABLE IF EXISTS before each CREATE, versioned comments, and
 * — critically — bulk INSERT data INTERLEAVED between table definitions, so
 * later tables sit far beyond any fixed head window.
 *
 * The row data deliberately contains the exact strings that fooled the old
 * scanner: "ROUNDHOUSE KICK" (which an unanchored /USE (\w+)/i reads as
 * "USE KICK") and a "CREATE TABLE" mention inside a quoted JSON payload.
 */
function buildMariaDbDump(opts: {
  tables: string[];
  databaseHeader?: string | null;
  useStatement?: string | null;
  padBytesPerTable?: number;
  qualified?: boolean;
  lowercase?: boolean;
}): string {
  const pad = opts.padBytesPerTable ?? 0;
  const lines: string[] = [
    "/*M!999999\\- enable the sandbox mode */ ",
    "-- MariaDB dump 10.19-11.8.8-MariaDB, for Linux (x86_64)",
    "--",
  ];
  if (opts.databaseHeader !== null) {
    lines.push(`-- Host: localhost    Database: ${opts.databaseHeader ?? "u350003894_brawl2"}`);
  }
  lines.push(
    "-- ------------------------------------------------------",
    "-- Server version\t11.8.8-MariaDB-log",
    "",
    "/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;",
    "/*!40101 SET NAMES utf8mb4 */;",
    "/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */;",
    ""
  );
  if (opts.useStatement) lines.push(`USE \`${opts.useStatement}\`;`, "");

  opts.tables.forEach((table, i) => {
    const name = opts.qualified ? `\`u350003894_brawl2\`.\`${table}\`` : `\`${table}\``;
    const create = opts.lowercase && i % 2 === 1 ? "create table if not exists" : "CREATE TABLE";
    lines.push(
      "--",
      `-- Table structure for table \`${table}\``,
      "--",
      "",
      `DROP TABLE IF EXISTS ${name};`,
      "/*!40101 SET @saved_cs_client     = @@character_set_client */;",
      "/*!40101 SET character_set_client = utf8mb4 */;",
      `${create} ${name} (`,
      "  `id` char(36) NOT NULL,",
      "  `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,",
      "  PRIMARY KEY (`id`)",
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
      "/*!40101 SET character_set_client = @saved_cs_client */;",
      "",
      "--",
      `-- Dumping data for table \`${table}\``,
      "--",
      "",
      `LOCK TABLES \`${table}\` WRITE;`,
      `/*!40000 ALTER TABLE \`${table}\` DISABLE KEYS */;`
    );

    // One bulk INSERT written as a single enormous line, exactly as
    // mariadb-dump does with extended inserts. This is what pushes the next
    // table's DDL out of any head window.
    const payload =
      '{\\"gadgets\\":[{\\"id\\":23000464,\\"name\\":\\"ROUNDHOUSE KICK\\"}],' +
      '\\"note\\":\\"CREATE TABLE `not_a_real_table` should never be enumerated\\"}';
    const filler = pad > 0 ? "x".repeat(pad) : "";
    lines.push(
      `INSERT INTO \`${table}\` VALUES ('row-${i}','${payload}${filler}');`,
      `/*!40000 ALTER TABLE \`${table}\` ENABLE KEYS */;`,
      "UNLOCK TABLES;",
      ""
    );
  });

  lines.push("-- Dump completed on 2026-07-18  5:58:47", "");
  return lines.join("\n");
}

function writeGzFixture(sql: string, name = "dump.sql.gz"): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "dump-fixture-")), name);
  writeFileSync(file, gzipSync(Buffer.from(sql, "utf8")));
  return file;
}

/** The repository's own expected table list, so fixtures stay in sync with migrations. */
async function expectedTables(): Promise<string[]> {
  const { buildInventory } = await import("../scripts/dataset/schema-inventory.mjs");
  const inv = await buildInventory();
  return inv.tables.map((t: { table: string }) => t.table).concat(["schema_migrations"]);
}

test("verify-backup enumerates tables whose DDL lies far beyond the header window", async () => {
  const { verifyBackup } = await import("../scripts/dataset/verify-backup.mjs");
  const tables = await expectedTables();

  // ~1 MiB of row data per table pushes the last tables hundreds of MiB in —
  // the exact shape of the real 293 MB artifact, where a head-only scan saw
  // 2 of 46 tables and reported the other 44 as missing.
  const file = writeGzFixture(buildMariaDbDump({ tables, padBytesPerTable: 1024 * 1024 }));
  const result = await verifyBackup(file);

  assert.equal(result.foundTableCount, tables.length, "every table must be found regardless of dump size");
  assert.deepEqual(result.missingTables, [], "a complete dump must report nothing missing");
  assert.equal(result.enumerationComplete, true);
  assert.equal(result.verdict.tableEnumeration, "complete");
  assert.equal(result.verdict.expectedTables, "all_present");
  assert.equal(result.usable, true);
});

test("verify-backup handles the DDL spellings a real dump can contain", async () => {
  const { verifyBackup } = await import("../scripts/dataset/verify-backup.mjs");
  const tables = await expectedTables();

  // Database-qualified names plus alternating lowercase
  // "create table if not exists" — both legal, neither matched by the old
  // fixed `CREATE TABLE (?:IF NOT EXISTS )?` pattern in every position.
  const file = writeGzFixture(buildMariaDbDump({ tables, qualified: true, lowercase: true }));
  const result = await verifyBackup(file);

  assert.deepEqual(result.missingTables, [], "qualified and lowercase DDL must still enumerate");
  assert.equal(result.foundTableCount, tables.length);
});

test("verify-backup never enumerates a table name that only appears inside row data", async () => {
  const { verifyBackup } = await import("../scripts/dataset/verify-backup.mjs");
  const tables = await expectedTables();
  const file = writeGzFixture(buildMariaDbDump({ tables }));
  const result = await verifyBackup(file);

  // The fixture's INSERT payload contains "CREATE TABLE `not_a_real_table`".
  assert.ok(
    !result.unexpectedTables.includes("not_a_real_table"),
    "DDL inside quoted row data must not be mistaken for schema"
  );
});

test("verify-backup reads the database name from the dump, never from row data", async () => {
  const { verifyBackup } = await import("../scripts/dataset/verify-backup.mjs");
  const tables = await expectedTables();

  // Regression: row data containing "ROUNDHOUSE KICK" once produced
  // source.databaseName = "KICK" via an unanchored /USE (\w+)/i.
  const fromHeader = await verifyBackup(writeGzFixture(buildMariaDbDump({ tables })));
  assert.equal(fromHeader.detectedDatabaseName, "u350003894_brawl2");
  assert.notEqual(fromHeader.detectedDatabaseName, "KICK");

  // A real USE statement is authoritative when present.
  const fromUse = await verifyBackup(
    writeGzFixture(buildMariaDbDump({ tables, useStatement: "brawlranks_restoretest_ci" }))
  );
  assert.equal(fromUse.detectedDatabaseName, "brawlranks_restoretest_ci");

  // With neither, the label must be null — not a word scraped out of a row.
  const anonymous = await verifyBackup(
    writeGzFixture(buildMariaDbDump({ tables, databaseHeader: null }))
  );
  assert.equal(anonymous.detectedDatabaseName, null, "an undeclared database must be null, never guessed");
});

test("verify-backup refuses to call an artifact usable when critical tables are absent", async () => {
  const { verifyBackup } = await import("../scripts/dataset/verify-backup.mjs");
  const tables = (await expectedTables()).filter((t) => t !== "normalized_battles" && t !== "battle_participants");

  const result = await verifyBackup(writeGzFixture(buildMariaDbDump({ tables })));

  assert.equal(result.usable, false, "genuinely absent critical tables must fail the verdict");
  assert.equal(result.verdict.expectedTables, "missing_critical");
  assert.deepEqual(result.missingCriticalTables.sort(), ["battle_participants", "normalized_battles"]);

  const tableCheck = result.checks.find((c: { name: string }) => c.name === "expected_tables_present");
  assert.equal(tableCheck.passed, false);
  assert.equal(tableCheck.severity, "error", "a missing critical table is not a warning");
});

test("verify-backup grades a non-critical gap as a warning, not a failure", async () => {
  const { verifyBackup } = await import("../scripts/dataset/verify-backup.mjs");
  const tables = (await expectedTables()).filter((t) => t !== "brawler_aliases");

  const result = await verifyBackup(writeGzFixture(buildMariaDbDump({ tables })));

  assert.equal(result.verdict.expectedTables, "missing_noncritical");
  assert.deepEqual(result.missingTables, ["brawler_aliases"]);
  assert.equal(result.usable, true, "a dump predating one non-critical migration is still structurally usable");
});

test("verify-backup marks a head-only scan inconclusive instead of reporting absences", async () => {
  const { verifyBackup } = await import("../scripts/dataset/verify-backup.mjs");
  const tables = await expectedTables();
  const file = writeGzFixture(buildMariaDbDump({ tables, padBytesPerTable: 1024 * 1024 }));

  const result = await verifyBackup(file, { headOnly: true });

  // This is the ONLY circumstance in which the tool may leave an artifact
  // structurally usable while not having seen every table.
  assert.equal(result.enumerationComplete, false);
  assert.equal(result.verdict.tableEnumeration, "inconclusive");
  assert.equal(result.verdict.expectedTables, "inconclusive");

  const tableCheck = result.checks.find((c: { name: string }) => c.name === "expected_tables_present");
  assert.equal(tableCheck.passed, false, "an ungraded check must not be recorded as passing");
  assert.match(tableCheck.detail, /INCONCLUSIVE/);
});

test("verify-backup keeps the four verdicts separate and never claims restore proof", async () => {
  const { verifyBackup } = await import("../scripts/dataset/verify-backup.mjs");
  const result = await verifyBackup(writeGzFixture(buildMariaDbDump({ tables: await expectedTables() })));

  assert.equal(result.verdict.gzipIntegrity, "pass");
  assert.equal(result.verdict.sqlStructure, "usable");
  assert.equal(result.verdict.tableEnumeration, "complete");
  assert.equal(result.verdict.expectedTables, "all_present");
  assert.equal(result.verdict.restoreProof, "NOT_PERFORMED", "no static check may ever imply a restore happened");
});

test("verify-backup reports corrupt gzip as an integrity failure, not a schema failure", async () => {
  const { verifyBackup } = await import("../scripts/dataset/verify-backup.mjs");
  const good = gzipSync(Buffer.from(buildMariaDbDump({ tables: await expectedTables() }), "utf8"));
  // Truncating mid-stream is the realistic corruption: a partial download.
  const file = path.join(mkdtempSync(path.join(tmpdir(), "dump-fixture-")), "truncated.sql.gz");
  writeFileSync(file, good.subarray(0, Math.floor(good.length / 2)));

  const result = await verifyBackup(file);

  assert.equal(result.verdict.gzipIntegrity, "fail");
  assert.equal(result.usable, false);
  // Enumeration stopped early, so it must be inconclusive rather than
  // claiming the tables it never reached are missing.
  assert.equal(result.verdict.tableEnumeration, "inconclusive");
  assert.equal(result.verdict.expectedTables, "inconclusive");
});

test("a generated manifest never reports checksFailed 0 alongside a failed table check", async () => {
  const tables = (await expectedTables()).filter((t) => t !== "normalized_battles");
  const file = writeGzFixture(buildMariaDbDump({ tables }));
  const out = path.join(path.dirname(file), "manifest.json");

  try {
    execFileSync(
      "node",
      [path.join(SCRIPTS_DIR, "create-backup-manifest.mjs"), file, "--operator", "test", "--out", out],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
  } catch {
    // A non-zero exit is acceptable here; the manifest content is the assertion.
  }

  const manifest = JSON.parse(readFileSync(out, "utf8"));
  assert.ok(manifest.verification.checksFailed > 0, "a failed table-presence check must be counted");
  assert.equal(manifest.verification.usable, false);
  assert.equal(manifest.verification.verdict.expectedTables, "missing_critical");
  assert.notEqual(manifest.source.databaseName, "KICK");
});

// ---------------------------------------------------------------------------
// Manifest generator — secret refusal
// ---------------------------------------------------------------------------

test("manifest generator refuses a manifest carrying a connection string", async () => {
  const { assertNoSecrets } = await import("../scripts/dataset/create-backup-manifest.mjs");
  assert.throws(
    () => assertNoSecrets({ source: { note: "mysql://user:hunter2@dbhost/brawl2" } }),
    /possible secret exposure/
  );
});

test("manifest generator refuses forbidden keys including the database host", async () => {
  const { assertNoSecrets } = await import("../scripts/dataset/create-backup-manifest.mjs");
  for (const key of ["password", "secret", "token", "db_host", "host", "connection_string"]) {
    assert.throws(
      () => assertNoSecrets({ backup: { [key]: "anything" } }),
      /possible secret exposure/,
      `key "${key}" must be refused`
    );
  }
});

test("manifest generator accepts a legitimate SHA-256 checksum", async () => {
  const { assertNoSecrets } = await import("../scripts/dataset/create-backup-manifest.mjs");
  // A 64-char hex checksum trips the generic "long opaque token" heuristic,
  // so the exemption for checksum fields must actually work — otherwise the
  // tool could never manifest a real backup.
  assert.ok(assertNoSecrets({ backup: { sha256: "a".repeat(64) } }));
});

test("manifest generator accepts a generic source label but no address of any kind", async () => {
  const { assertSafeSourceLabel } = await import("../scripts/dataset/create-backup-manifest.mjs");

  for (const safe of ["production-hostinger", "staging", "local-docker", "unspecified-source"]) {
    assert.equal(assertSafeSourceLabel(safe), safe, `"${safe}" is a generic label and must be accepted`);
  }

  // The label is the ONLY operator-controlled string that reaches source.*,
  // so it is the one place a host could realistically be pasted in. Every
  // shape that could locate or authenticate to a server must be refused.
  for (const unsafe of [
    "db.example.com",
    "srv1234.hstgr.io",
    "127.0.0.1",
    "10.0.0.5:3306",
    "https://panel.example.com/db",
    "mysql://user:hunter2@dbhost/brawl2",
    "user@dbhost",
    "prod password=hunter2",
    "prod-token-abc",
    "api-key-live",
    "secret-store",
  ]) {
    assert.throws(
      () => assertSafeSourceLabel(unsafe),
      /Invalid --source-env/,
      `"${unsafe}" must be refused as a source label`
    );
  }
});

test("manifest generator emits no host field and passes its own secret scan", async () => {
  const { assertNoSecrets } = await import("../scripts/dataset/create-backup-manifest.mjs");
  const out = path.join(mkdtempSync(path.join(tmpdir(), "manifest-test-")), "template.json");

  // Template mode is the regression case: it used to carry source.hostRecorded,
  // whose name alone tripped the forbidden-key scan on every single run.
  execFileSync("node", [path.join(SCRIPTS_DIR, "create-backup-manifest.mjs"), "--template", "--out", out], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const manifest = JSON.parse(readFileSync(out, "utf8"));
  assert.ok(assertNoSecrets(manifest), "a generated template must survive the scanner it ships with");
  assert.ok(!("hostRecorded" in manifest.source), "source.hostRecorded must be gone, not renamed back in");
  assert.equal(manifest.source.label, "production-hostinger");
  assert.deepEqual(
    Object.keys(manifest.source).filter((k) => /host/i.test(k)),
    [],
    "no source field may reference a host at all"
  );
});

test("the forbidden-key scan is still strict about host-shaped keys", async () => {
  const { assertNoSecrets } = await import("../scripts/dataset/create-backup-manifest.mjs");
  // Fixing hostRecorded must not have been done by loosening the scanner.
  for (const key of ["host", "hostname", "hostRecorded", "db_host", "password", "token", "secret", "dsn"]) {
    assert.throws(
      () => assertNoSecrets({ source: { [key]: "anything" } }),
      /possible secret exposure/,
      `key "${key}" must still be refused`
    );
  }
});

// ---------------------------------------------------------------------------
// Audit SQL — read-only proof
// ---------------------------------------------------------------------------

const SQL_FILES = [
  "production-size-report.sql",
  "data-growth-report.sql",
  "validate-restored-db.sql",
];

/** Strips -- line comments so a commented-out example cannot fail the scan. */
function activeSqlOf(file: string): string {
  return readFileSync(path.join(SCRIPTS_DIR, file), "utf8")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

test("every dataset SQL report contains only read-only statements", () => {
  const forbidden = [
    /\bDELETE\s+FROM\b/i,
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+\w+\s+SET\b/i,
    /\bDROP\s+(TABLE|DATABASE|INDEX)\b/i,
    /\bTRUNCATE\b/i,
    /\bALTER\s+TABLE\b/i,
    /\bOPTIMIZE\s+TABLE\b/i,
    /\bCREATE\s+(TABLE|DATABASE)\b/i,
    /\bGRANT\b/i,
  ];

  for (const file of SQL_FILES) {
    const sql = activeSqlOf(file);
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(sql),
        `${file} contains a non-read-only statement matching ${pattern}`
      );
    }
  }
});

test("expensive production queries stay behind an explicit approval guard", () => {
  // Section 7+ of the size report and section 7+ of the growth report scan
  // real table data. They must remain commented out so that piping the file
  // straight into a production client cannot run them by accident.
  const sizeReport = readFileSync(path.join(SCRIPTS_DIR, "production-size-report.sql"), "utf8");
  const growthReport = readFileSync(path.join(SCRIPTS_DIR, "data-growth-report.sql"), "utf8");

  for (const [name, content] of [["production-size-report.sql", sizeReport], ["data-growth-report.sql", growthReport]] as const) {
    assert.match(content, /EXPENSIVE/, `${name} must label its expensive section`);
    assert.match(content, /-- APPROVED:/, `${name} must gate expensive queries behind an APPROVED comment`);
  }

  // The uncommented portion must never COUNT(*) a large table unbounded.
  const activeSize = activeSqlOf("production-size-report.sql");
  assert.ok(
    !/COUNT\(\*\)[\s\S]{0,40}FROM\s+(matchup_aggregates|battle_participants)/i.test(activeSize),
    "an unbounded COUNT(*) on a dominant table must stay behind the approval guard"
  );
});

test("the restore validation suite refuses to certify a production target", () => {
  const sql = readFileSync(path.join(SCRIPTS_DIR, "validate-restored-db.sql"), "utf8");
  assert.match(sql, /brawlranks\\_restoretest\\_%/, "must check DATABASE() against the disposable prefix");
  assert.match(sql, /THIS IS NOT AN ISOLATED RESTORE TARGET/, "must fail loudly on a non-isolated target");
});

// ---------------------------------------------------------------------------
// Schema inventory — must never touch a database
// ---------------------------------------------------------------------------

test("schema inventory reflects the repository's declared schema", async () => {
  const { buildInventory } = await import("../scripts/dataset/schema-inventory.mjs");
  const inv = await buildInventory();

  assert.equal(inv.migrationCount, 25, "25 migration files are expected");
  assert.equal(inv.tableCount, 45, "45 tables are declared by migrations (schema_migrations is created by the runner)");

  const names = inv.tables.map((t: { table: string }) => t.table);
  for (const critical of [
    "normalized_battles", "battle_participants", "battle_teams", "battle_observations",
    "matchup_aggregates", "published_snapshots", "published_snapshot_items",
  ]) {
    assert.ok(names.includes(critical), `inventory must include ${critical}`);
  }

  // The dedupe guarantee must be visible in the inventory, since the whole
  // retention/archival argument depends on battle_key being unique.
  const battles = inv.tables.find((t: { table: string }) => t.table === "normalized_battles");
  assert.ok(
    battles.uniqueKeys.some((k: { columns: string[] }) => k.columns.includes("battle_key")),
    "normalized_battles.battle_key must be recorded as unique"
  );

  // raw_api_snapshots.payload is the dominant archivable payload column.
  const raw = inv.tables.find((t: { table: string }) => t.table === "raw_api_snapshots");
  assert.ok(
    raw.highGrowthColumns.some((c: { column: string }) => c.column === "payload"),
    "raw_api_snapshots.payload must be flagged as a high-growth column"
  );
});

test("schema inventory opens no database connection", () => {
  const source = readFileSync(path.join(SCRIPTS_DIR, "schema-inventory.mjs"), "utf8");
  assert.ok(!/from\s+["']mysql2/.test(source), "schema-inventory must not import mysql2");
  assert.ok(!/createPool|createConnection/.test(source), "schema-inventory must not create a connection");
});

// ---------------------------------------------------------------------------
// Compatibility check — must surface the known MySQL 8.4 blocker
// ---------------------------------------------------------------------------

test("compatibility check flags the unquoted reserved-word column", async () => {
  const { runCompatibilityCheck } = await import("../scripts/dataset/compatibility-check.mjs");
  const report = await runCompatibilityCheck();

  const blockers = report.findings.filter((f: { severity: string }) => f.severity === "BLOCKER");
  const rankBlocker = blockers.find((f: { evidence: string }) => /battle_teams\.rank/.test(f.evidence));

  assert.ok(
    rankBlocker,
    "battle_teams.rank is unquoted in migration 0014 and RANK is reserved in MySQL 8.4 — this must be reported as a blocker"
  );
});

test("compatibility check never claims runtime verification", async () => {
  const { runCompatibilityCheck } = await import("../scripts/dataset/compatibility-check.mjs");
  const report = await runCompatibilityCheck();

  assert.match(report.evidenceClass, /static/i, "the report must label itself static-only");
  for (const finding of report.findings) {
    assert.match(
      finding.verification,
      /static inspection only/,
      "no finding may imply it was verified against a real MySQL 8.4 server"
    );
  }
});
