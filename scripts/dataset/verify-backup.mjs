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
 *   - which of this repository's 45 expected tables appear
 *   - restore hazards: DEFINER clauses, routines/triggers/events,
 *     non-utf8mb4 charsets, MariaDB-specific syntax
 *   - whether the dump embeds credentials in comments (reported as a
 *     boolean only — the offending text is NEVER printed)
 *
 * Usage:
 *   node scripts/dataset/verify-backup.mjs <path-to-backup>
 *   node scripts/dataset/verify-backup.mjs <path-to-backup> --json
 *
 * Exit codes: 0 = all checks passed, 1 = a check failed, 2 = unusable input.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventory } from "./schema-inventory.mjs";

/** Bytes of decompressed SQL to inspect. The interesting DDL is at the head and we never need the data section. */
const INSPECT_BYTES = 8 * 1024 * 1024;

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
 * Streams the artifact, decompressing when needed, and returns the first
 * INSPECT_BYTES of plaintext plus whether the whole stream decompressed
 * without error. Decompression integrity is verified over the FULL stream,
 * not just the inspected head.
 */
async function readPlaintextHead(filePath, format) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let collected = 0;
    let decompressOk = true;
    let decompressError = null;

    const source = createReadStream(filePath);
    let stream = source;

    if (format === "gzip") {
      const gunzip = createGunzip();
      gunzip.on("error", (err) => { decompressOk = false; decompressError = err.message; });
      stream = source.pipe(gunzip);
    }

    stream.on("data", (chunk) => {
      if (collected < INSPECT_BYTES) {
        chunks.push(chunk);
        collected += chunk.length;
      }
      // Keep draining so gzip integrity is checked over the entire stream.
    });
    stream.on("end", () => resolve({ text: Buffer.concat(chunks).toString("utf8"), decompressOk, decompressError }));
    stream.on("error", (err) => {
      if (format === "gzip") resolve({ text: Buffer.concat(chunks).toString("utf8"), decompressOk: false, decompressError: err.message });
      else reject(err);
    });
  });
}

export async function verifyBackup(filePath) {
  const checks = [];
  const add = (name, passed, detail, severity = "error") => checks.push({ name, passed, detail, severity });

  let stats;
  try {
    stats = await stat(filePath);
  } catch {
    return { filePath, usable: false, checks: [{ name: "file_exists", passed: false, detail: "File not found or unreadable.", severity: "error" }] };
  }
  if (!stats.isFile()) {
    return { filePath, usable: false, checks: [{ name: "file_exists", passed: false, detail: "Path is not a regular file.", severity: "error" }] };
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
    return { filePath, usable: false, sizeBytes: bytes, sha256, format, checks };
  }

  const { text, decompressOk, decompressError } = await readPlaintextHead(filePath, format);
  if (format === "gzip") {
    add("decompression_integrity", decompressOk, decompressOk ? "Full gzip stream decompressed cleanly." : `Decompression failed: ${decompressError}`);
  }

  add("sql_dump_readable", /CREATE TABLE/i.test(text), /CREATE TABLE/i.test(text)
    ? "Contains CREATE TABLE statements."
    : "No CREATE TABLE found in the inspected head — this may be a data-only dump, or not a SQL dump at all.");

  const inv = await buildInventory();
  const expected = inv.tables.map((t) => t.table).concat(["schema_migrations"]);
  const found = expected.filter((t) => new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?\`?${t}\`?`, "i").test(text));
  const missing = expected.filter((t) => !found.includes(t));
  add("expected_tables_present", missing.length === 0,
    `${found.length}/${expected.length} expected tables found in the inspected head.` +
    (missing.length ? ` Missing: ${missing.join(", ")}.` : ""),
    missing.length === expected.length ? "error" : "warning");

  const dbNameMatch = /(?:CREATE DATABASE[^;]*?|USE )`?(\w+)`?/i.exec(text);
  add("database_name_detected", Boolean(dbNameMatch), dbNameMatch
    ? `Dump targets database: ${dbNameMatch[1]}`
    : "No CREATE DATABASE/USE statement found — the dump is database-agnostic and can be restored into any target name (this is SAFE and preferred).",
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
  return {
    filePath,
    usable: blocking.length === 0,
    sizeBytes: bytes,
    sizeMb: Number((bytes / 1024 / 1024).toFixed(2)),
    sha256,
    format,
    detectedDatabaseName: dbNameMatch?.[1] ?? null,
    sourceServerVersion: serverVersion,
    expectedTableCount: expected.length,
    foundTableCount: found.length,
    missingTables: missing,
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
  const result = await verifyBackup(target);
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
