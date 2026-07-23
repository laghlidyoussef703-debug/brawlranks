#!/usr/bin/env node
/**
 * DATASET Phase 2 — backup artifact verification (READ-ONLY).
 *
 * Inspects a downloaded database backup WITHOUT loading it into any
 * database. It never connects to MySQL, never writes to the artifact, and
 * never prints dump row data.
 *
 * What it checks:
 *   - the file exists, its size, and its SHA-256 (streamed, so a
 *     multi-gigabyte dump does not need to fit in memory)
 *   - container format (gzip / zip / plain SQL) and, for gzip, that the
 *     stream decompresses cleanly end to end
 *   - that the plaintext looks like a real SQL dump (CREATE TABLE etc.)
 *   - which of this repository's expected tables appear, enumerated over the
 *     ENTIRE dump (mysqldump interleaves DDL with data, so a head-only scan
 *     cannot see past the first few tables)
 *   - restore hazards: DEFINER clauses, routines/triggers/events,
 *     non-utf8mb4 charsets, MariaDB-specific syntax
 *   - whether the dump embeds credentials in comments (reported as a
 *     boolean only — the offending text is NEVER printed)
 *
 * Usage:
 *   node scripts/dataset/verify-backup.mjs <path-to-backup>
 *   node scripts/dataset/verify-backup.mjs <path-to-backup> --json
 *   node scripts/dataset/verify-backup.mjs <path-to-backup> --head-only
 *
 * --head-only inspects just the dump header. It is fast, and its table
 * enumeration is reported as INCONCLUSIVE — never as "tables missing".
 *
 * The four verdicts it reports (gzip integrity, SQL structure, table
 * enumeration, expected tables) are deliberately separate, and NONE of them
 * is restore proof. Only an actual isolated restore closes that gate.
 *
 * Exit codes: 0 = all checks passed, 1 = a check failed, 2 = unusable input.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventory } from "./schema-inventory.mjs";

/**
 * Bytes of decompressed SQL retained for the HEURISTIC checks (charset,
 * DEFINER, credential shapes, engine banner). Those live in the dump header.
 *
 * Table ENUMERATION must never use this window: mysqldump interleaves each
 * table's DDL with its INSERT data, so in a real dump the 40th table's
 * CREATE TABLE can sit hundreds of megabytes in. Enumeration streams the
 * whole artifact instead — see scanDump().
 */
const HEAD_BYTES = 8 * 1024 * 1024;

/**
 * One table DDL statement. Anchored to line start (the `m` flag), which is
 * what keeps row data from being mistaken for schema: mysqldump writes DDL
 * at column 0 and packs row data into single long INSERT lines, so a
 * "CREATE TABLE" appearing inside a quoted JSON payload can never match.
 *
 * Handles: backticks, IF NOT EXISTS, DROP TABLE IF EXISTS, database-qualified
 * names, versioned comments (/*!32312 IF NOT EXISTS *\/), TEMPORARY, and any
 * case, since dumps are not required to shout their keywords.
 */
const TABLE_DDL =
  /^[ \t]*(?:CREATE|DROP)\s+(?:TEMPORARY\s+)?TABLE\s+(?:\/\*![0-9]{5}\s*)?(?:IF\s+(?:NOT\s+)?EXISTS\s*)?(?:\*\/\s*)?(?:`([^`]+)`|([A-Za-z0-9_$]+))(?:\s*\.\s*(?:`([^`]+)`|([A-Za-z0-9_$]+)))?/gim;

/**
 * A real USE / CREATE DATABASE statement: line-anchored and semicolon
 * terminated. Both anchors matter — an unanchored /USE `?(\w+)`?/i matches
 * the substring "USE KICK" inside a dumped JSON row containing
 * "ROUNDHOUSE KICK", which is exactly how a manifest once ended up naming
 * the source database "KICK".
 */
const DB_NAME_STATEMENT =
  /^[ \t]*(?:USE\s+|CREATE\s+DATABASE\s+(?:\/\*![0-9]{5}\s*)?(?:IF\s+NOT\s+EXISTS\s*)?(?:\*\/\s*)?)(?:`([^`]+)`|([A-Za-z0-9_$]+))\s*;/im;

/**
 * The mysqldump/mariadb-dump header comment, e.g.
 *   -- Host: localhost    Database: u350003894_brawl2
 * Only the Database token is captured. The Host is deliberately not captured
 * and never recorded anywhere — it is private connection detail.
 */
const DB_NAME_HEADER = /^--\s+Host:.*?\bDatabase:\s+([A-Za-z0-9_$]+)\s*$/im;

/** A syntactically legal, non-secret-bearing database identifier. */
const SAFE_DB_IDENTIFIER = /^[A-Za-z0-9_$]{1,64}$/;

/**
 * Tables without which a restored copy cannot serve or be rebuilt. Missing
 * ANY of these is a hard failure, not a warning — a dump missing them is not
 * a usable backup of this system no matter how cleanly it decompresses.
 */
const CRITICAL_TABLES = [
  "normalized_battles",
  "battle_participants",
  "battle_teams",
  "battle_observations",
  "matchup_aggregates",
  "published_snapshots",
  "published_snapshot_items",
  "schema_migrations",
];

/**
 * Patterns that indicate a credential was written into the dump (some
 * hosting panels add a connection banner). We report only WHETHER one
 * matched — never the matched text, never a captured value.
 */
const CREDENTIAL_PATTERNS = [
  /\bpassword\s*[:=]\s*\S/i,
  /\bIDENTIFIED\s+BY\b/i,
  /\bmysql:\/\/[^\s]*:[^\s]*@/i,
  /\bBRAWL_DB_SECRET/i,
];

const MARIADB_SPECIFIC = [
  { pattern: /\/\*M!\d+/, label: "MariaDB-only executable comment (/*M!...*/)" },
  { pattern: /\bPAGE_COMPRESSED\s*=/i, label: "PAGE_COMPRESSED table option (MariaDB-only)" },
  { pattern: /\bENGINE\s*=\s*Aria\b/i, label: "Aria storage engine (MariaDB-only)" },
  { pattern: /\bWITH\s+SYSTEM\s+VERSIONING\b/i, label: "System-versioned table (MariaDB-only)" },
  { pattern: /\bSEQUENCE\b/i, label: "SEQUENCE object (MariaDB-only)" },
  { pattern: /\buca1400/i, label: "uca1400 collation (MariaDB 11.x-only)" },
];

function detectFormat(head) {
  if (head[0] === 0x1f && head[1] === 0x8b) return "gzip";
  if (head[0] === 0x50 && head[1] === 0x4b) return "zip";
  if (head.subarray(0, 6).toString("utf8") === "\x28\xb5\x2f\xfd".slice(0, 4)) return "zstd";
  if (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return "zstd";
  return "plain";
}

async function hashAndSize(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => { hash.update(chunk); bytes += chunk.length; });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return { sha256: hash.digest("hex"), bytes };
}

/**
 * Streams the whole artifact once, decompressing when needed, and returns:
 *   - `head`: the first HEAD_BYTES of plaintext, for the header heuristics
 *   - `tables`: every table named by a DDL statement ANYWHERE in the dump
 *   - `enumerationComplete`: whether the scan actually reached the end
 *
 * enumerationComplete is the honesty flag. It is false when the stream was
 * cut short (decompression error, or --head-only), and callers must then
 * report table enumeration as INCONCLUSIVE rather than reporting an absence
 * they never actually looked for.
 *
 * Lines are assembled across chunk boundaries so a DDL statement split by
 * the reader is still seen at column 0. A "line" longer than MAX_LINE is a
 * bulk INSERT, never DDL, so it is skipped without buffering — this is what
 * keeps a multi-gigabyte dump inside a small, constant memory footprint.
 */
const MAX_LINE = 1024 * 1024;

async function scanDump(filePath, format, { headOnly = false } = {}) {
  return new Promise((resolve, reject) => {
    const headChunks = [];
    let headBytes = 0;
    let plaintextBytes = 0;
    let decompressOk = true;
    let decompressError = null;
    let reachedEnd = false;

    const tables = new Set();
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let skippingLongLine = false;

    const scanLines = (text) => {
      // Cheap pre-filter: the overwhelming majority of a dump is row data
      // with no DDL keyword, and skipping the regex there is what makes a
      // full-stream scan take seconds rather than minutes.
      if (!text.includes("TABLE") && !text.includes("table") && !text.includes("Table")) return;
      TABLE_DDL.lastIndex = 0;
      for (const m of text.matchAll(TABLE_DDL)) {
        // A database-qualified name puts the table in the second position.
        const name = m[3] ?? m[4] ?? m[1] ?? m[2];
        if (name) tables.add(name.toLowerCase());
      }
    };

    const source = createReadStream(filePath);
    let stream = source;

    if (format === "gzip") {
      const gunzip = createGunzip();
      gunzip.on("error", (err) => { decompressOk = false; decompressError = err.message; });
      stream = source.pipe(gunzip);
    }

    const finish = () => resolve({
      text: Buffer.concat(headChunks).toString("utf8"),
      tables,
      plaintextBytes,
      decompressOk,
      decompressError,
      // A clean end is required for enumeration to count as complete: a
      // truncated stream simply has not been looked at.
      enumerationComplete: reachedEnd && decompressOk && !headOnly,
    });

    stream.on("data", (chunk) => {
      plaintextBytes += chunk.length;
      if (headBytes < HEAD_BYTES) {
        headChunks.push(chunk);
        headBytes += chunk.length;
      }
      if (headOnly) {
        if (headBytes >= HEAD_BYTES) stream.destroy();
        return;
      }

      let str = decoder.write(chunk);
      if (skippingLongLine) {
        const nl = str.indexOf("\n");
        if (nl === -1) return;
        str = str.slice(nl + 1);
        skippingLongLine = false;
      }

      const text = pending + str;
      const nl = text.lastIndexOf("\n");
      if (nl === -1) {
        if (text.length > MAX_LINE) { pending = ""; skippingLongLine = true; }
        else pending = text;
        return;
      }
      const rest = text.slice(nl + 1);
      if (rest.length > MAX_LINE) { pending = ""; skippingLongLine = true; }
      else pending = rest;
      scanLines(text.slice(0, nl + 1));
    });

    stream.on("end", () => {
      if (pending) scanLines(`${pending}\n`);
      reachedEnd = true;
      finish();
    });
    stream.on("close", () => { if (headOnly) finish(); });
    stream.on("error", (err) => {
      if (format === "gzip") {
        decompressOk = false;
        decompressError = decompressError ?? err.message;
        finish();
      } else {
        reject(err);
      }
    });
  });
}

/**
 * The shape every early return must also satisfy, so a caller never has to
 * guess whether a verdict is present. An unreadable artifact is unusable and
 * its enumeration is inconclusive — stated, not omitted.
 */
function unusableResult(filePath, checks, extra = {}) {
  return {
    filePath,
    usable: false,
    verdict: {
      gzipIntegrity: "not_applicable",
      sqlStructure: "unusable",
      tableEnumeration: "inconclusive",
      expectedTables: "inconclusive",
      restoreProof: "NOT_PERFORMED",
    },
    detectedDatabaseName: null,
    sourceServerVersion: null,
    expectedTableCount: null,
    foundTableCount: 0,
    missingTables: /** @type {string[]} */ ([]),
    missingCriticalTables: /** @type {string[]} */ ([]),
    unexpectedTables: /** @type {string[]} */ ([]),
    enumerationComplete: false,
    checks,
    ...extra,
  };
}

export async function verifyBackup(filePath, { headOnly = false } = {}) {
  const checks = [];
  const add = (name, passed, detail, severity = "error") => checks.push({ name, passed, detail, severity });

  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    return unusableResult(filePath, [{ name: "file_exists", passed: false, detail: "File not found or unreadable.", severity: "error" }]);
  }
  if (!stats.isFile()) {
    return unusableResult(filePath, [{ name: "file_exists", passed: false, detail: "Path is not a regular file.", severity: "error" }]);
  }

  const { sha256, bytes } = await hashAndSize(filePath);
  add("file_exists", true, `${bytes} bytes`);
  add("nonempty", bytes > 0, bytes > 0 ? "Artifact is not empty." : "Artifact is zero bytes.");

  const headBuf = Buffer.alloc(8);
  await new Promise((resolve, reject) => {
    const s = createReadStream(filePath, { start: 0, end: 7 });
    s.on("data", (c) => c.copy(headBuf));
    s.on("end", resolve);
    s.on("error", reject);
  });
  const format = detectFormat(headBuf);
  add("container_format", format !== "zip" && format !== "zstd", `Detected: ${format}.` +
    (format === "zip" ? " Unzip it first; this tool inspects gzip or plain SQL." : "") +
    (format === "zstd" ? " Decompress with zstd first; Node has no built-in zstd." : ""));

  if (format === "zip" || format === "zstd") {
    return unusableResult(filePath, checks, { sizeBytes: bytes, sizeMb: Number((bytes / 1024 / 1024).toFixed(2)), sha256, format });
  }

  const { text, tables, plaintextBytes, decompressOk, decompressError, enumerationComplete } =
    await scanDump(filePath, format, { headOnly });

  // ---- Concern 1: container integrity. Says nothing about SQL contents. ----
  if (format === "gzip") {
    add("decompression_integrity", decompressOk, decompressOk
      ? `Full gzip stream decompressed cleanly (${plaintextBytes} plaintext bytes).`
      : `Decompression failed: ${decompressError}`);
  }

  // ---- Concern 2: SQL structural usability. Says nothing about WHICH tables. ----
  const looksLikeSql = /^[ \t]*CREATE\s+TABLE/im.test(text) || tables.size > 0;
  add("sql_dump_readable", looksLikeSql, looksLikeSql
    ? "Contains CREATE TABLE statements."
    : "No CREATE TABLE statement found — this may be a data-only dump, or not a SQL dump at all.");

  // ---- Concern 3: expected-table enumeration. Scanned over the WHOLE dump. ----
  const inv = await buildInventory();
  const expected = inv.tables.map((t) => t.table).concat(["schema_migrations"]);
  const found = expected.filter((t) => tables.has(t.toLowerCase()));
  const missing = expected.filter((t) => !tables.has(t.toLowerCase()));
  const missingCritical = missing.filter((t) => CRITICAL_TABLES.includes(t));

  add("table_enumeration_complete", enumerationComplete, enumerationComplete
    ? `Enumerated table DDL across the entire artifact (${plaintextBytes} plaintext bytes); the table list below is authoritative.`
    : headOnly
      ? "INCONCLUSIVE: --head-only was requested, so only the first 8 MiB was enumerated. mysqldump interleaves DDL with each table's data, so absence here does NOT mean a table is missing."
      : "INCONCLUSIVE: the stream ended early, so enumeration never reached the end of the dump. Absence below does NOT mean a table is missing.",
    enumerationComplete ? "info" : "warning");

  if (!enumerationComplete) {
    // Refusing to grade an enumeration we did not finish. Reporting "44
    // missing" from a partial scan is how a healthy artifact got 44 false
    // absences and a passing verdict in the same manifest.
    add("expected_tables_present", false,
      `INCONCLUSIVE — not graded. ${found.length}/${expected.length} expected tables were seen before the scan stopped.`,
      "warning");
  } else {
    add("expected_tables_present", missing.length === 0,
      `${found.length}/${expected.length} expected tables found.` +
      (missing.length ? ` Missing: ${missing.join(", ")}.` : "") +
      (missingCritical.length ? ` CRITICAL tables missing: ${missingCritical.join(", ")}. This artifact is not a usable backup of this system.` : ""),
      // A genuinely-absent critical table is a hard failure. Non-critical
      // gaps stay a warning: a dump may legitimately predate a migration.
      missingCritical.length > 0 ? "error" : "warning");
  }

  const extraTables = [...tables].filter((t) => !expected.some((e) => e.toLowerCase() === t)).sort();

  const dbNameRaw = DB_NAME_STATEMENT.exec(text) ?? DB_NAME_HEADER.exec(text);
  const dbNameCandidate = dbNameRaw ? (dbNameRaw[1] ?? dbNameRaw[2]) : null;
  // Fails to null rather than recording something unvalidated: an
  // unrecognisable value is worse than no value, because it gets copied
  // into the manifest and read as fact.
  const detectedDatabaseName =
    dbNameCandidate && SAFE_DB_IDENTIFIER.test(dbNameCandidate) ? dbNameCandidate : null;
  add("database_name_detected", true, detectedDatabaseName
    ? `Dump declares source database: ${detectedDatabaseName}`
    : "No USE/CREATE DATABASE statement and no dump header naming a database — the dump is database-agnostic and can be restored into any target name (this is SAFE and preferred). Recorded as null.",
    "info");

  // Everything below reads the dump HEADER only (first 8 MiB). These are
  // hazard heuristics, not enumeration, and they are labelled as such so a
  // reader never mistakes their scope for the full-artifact table scan above.
  add("header_heuristics_scope", true,
    `DEFINER, routine/trigger, charset, MariaDB-syntax and credential heuristics below were evaluated over the first ${HEAD_BYTES} bytes of plaintext only.`,
    "info");

  const serverVersion = /-- Server version\s+(\S+)/i.exec(text)?.[1]
    ?? /Distrib\s+([\d.]+-?\w*)/i.exec(text)?.[1] ?? null;
  add("source_engine_detected", true, serverVersion ? `Source server version: ${serverVersion}` : "Source server version not recorded in the dump header.", "info");

  const definerCount = (text.match(/DEFINER\s*=/gi) ?? []).length;
  add("no_definer_clauses", definerCount === 0, definerCount === 0
    ? "No DEFINER clauses — restore will not fail on a missing user."
    : `${definerCount} DEFINER clause(s) found. These reference a source user that will not exist in the isolated target and can abort the restore. Strip them (see docs/dataset/restore-runbook.md) or restore as a superuser.`,
    "warning");

  const routines = /CREATE\s+(DEFINER=[^ ]+\s+)?(PROCEDURE|FUNCTION)/i.test(text);
  const triggers = /CREATE\s+(DEFINER=[^ ]+\s+)?TRIGGER/i.test(text);
  const events = /CREATE\s+(DEFINER=[^ ]+\s+)?EVENT/i.test(text);
  add("routines_triggers_events", true,
    `routines=${routines} triggers=${triggers} events=${events}. This repository's migrations define none, so all-false is EXPECTED. Any true value means the dump carries objects the repository does not declare — investigate before trusting the schema.`,
    "info");

  const charsets = [...new Set((text.match(/CHARSET=\w+/gi) ?? []).map((s) => s.split("=")[1].toLowerCase()))];
  const collations = [...new Set((text.match(/COLLATE[= ]\s*(\w+)/gi) ?? []).map((s) => s.split(/[= ]+/).pop().toLowerCase()))];
  const charsetOk = charsets.length === 0 || charsets.every((c) => c === "utf8mb4");
  add("charset_utf8mb4", charsetOk,
    `charsets=[${charsets.join(", ") || "none in head"}] collations=[${collations.join(", ") || "none in head"}]. ` +
    (charsetOk ? "Matches the migrations' utf8mb4 declaration." : "A non-utf8mb4 charset would silently change string semantics on restore."),
    charsetOk ? "info" : "error");

  const mariadbFindings = MARIADB_SPECIFIC.filter((m) => m.pattern.test(text)).map((m) => m.label);
  add("mysql8_compatible_syntax", mariadbFindings.length === 0,
    mariadbFindings.length === 0
      ? "No MariaDB-only syntax detected in the inspected head."
      : `MariaDB-only constructs found: ${mariadbFindings.join("; ")}. These block a MySQL 8.4 target (DATASET.md Phase 3/6 gate).`,
    "warning");

  const credentialHit = CREDENTIAL_PATTERNS.some((p) => p.test(text));
  add("no_embedded_credentials", !credentialHit,
    credentialHit
      ? "A credential-shaped pattern was matched in the dump header. The matching text is deliberately NOT printed. Treat this artifact as secret-bearing: store it encrypted and never commit or share it."
      : "No credential-shaped pattern in the inspected head.",
    credentialHit ? "error" : "info");

  const blocking = checks.filter((c) => c.severity === "error" && !c.passed);

  // Four separate verdicts, because they answer four different questions and
  // conflating them is what let a manifest say "44 tables missing" and
  // "usable: true" at once. Nothing here is ever restore proof.
  const verdict = {
    gzipIntegrity: format === "gzip" ? (decompressOk ? "pass" : "fail") : "not_applicable",
    sqlStructure: looksLikeSql && blocking.length === 0 ? "usable" : "unusable",
    tableEnumeration: enumerationComplete ? "complete" : "inconclusive",
    expectedTables: !enumerationComplete
      ? "inconclusive"
      : missing.length === 0
        ? "all_present"
        : missingCritical.length > 0
          ? "missing_critical"
          : "missing_noncritical",
    // Only an actual isolated restore may ever change this, and this tool
    // does not perform one. It is stated here so a reader of the verdict
    // block cannot mistake structural checks for restore proof.
    restoreProof: "NOT_PERFORMED",
  };

  return {
    filePath,
    // Structural usability only. False whenever a critical expected table is
    // genuinely absent; may stay true when enumeration is INCONCLUSIVE, in
    // which case verdict.tableEnumeration says so explicitly.
    usable: blocking.length === 0,
    verdict,
    sizeBytes: bytes,
    sizeMb: Number((bytes / 1024 / 1024).toFixed(2)),
    sha256,
    format,
    plaintextBytes,
    detectedDatabaseName,
    sourceServerVersion: serverVersion,
    expectedTableCount: expected.length,
    foundTableCount: found.length,
    missingTables: missing,
    missingCriticalTables: missingCritical,
    unexpectedTables: extraTables,
    enumerationComplete,
    checks,
  };
}

function printReport(result) {
  console.log(`Backup artifact: ${path.basename(result.filePath)}`);
  if (result.sizeBytes !== undefined) {
    console.log(`Size:            ${result.sizeBytes} bytes (${result.sizeMb} MB)`);
    console.log(`SHA-256:         ${result.sha256}`);
    console.log(`Format:          ${result.format}`);
  }
  console.log("");
  for (const c of result.checks) {
    const mark = c.passed ? "PASS" : c.severity === "warning" ? "WARN" : c.severity === "info" ? "INFO" : "FAIL";
    console.log(`[${mark}] ${c.name}`);
    console.log(`       ${c.detail}`);
  }
  console.log("");
  if (result.verdict) {
    console.log("VERDICTS (four separate questions):");
    console.log(`  gzip integrity:      ${result.verdict.gzipIntegrity}`);
    console.log(`  SQL structure:       ${result.verdict.sqlStructure}`);
    console.log(`  table enumeration:   ${result.verdict.tableEnumeration}`);
    console.log(`  expected tables:     ${result.verdict.expectedTables} (${result.foundTableCount}/${result.expectedTableCount})`);
    console.log(`  restore proof:       ${result.verdict.restoreProof}`);
    console.log("");
  }
  console.log(result.usable
    ? "VERDICT: artifact is structurally usable for an ISOLATED restore test."
    : "VERDICT: artifact FAILED verification. Do not proceed to a restore test.");
  console.log("Reminder: passing verification is NOT restore proof. Only an actual isolated restore + validate-restored-db.sql closes the DATASET.md Phase 2 gate.");
}

async function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error("Usage: node scripts/dataset/verify-backup.mjs <path-to-backup> [--json]");
    process.exitCode = 2;
    return;
  }
  const result = await verifyBackup(target, { headOnly: args.includes("--head-only") });
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else printReport(result);
  if (!result.usable) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`verify-backup error: ${error.message}`);
    process.exitCode = 2;
  });
}
