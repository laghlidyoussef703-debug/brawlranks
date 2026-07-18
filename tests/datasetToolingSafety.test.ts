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
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
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
