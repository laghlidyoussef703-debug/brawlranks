#!/usr/bin/env node
/**
 * DATASET Phase 2 — backup manifest generator (READ-ONLY).
 *
 * Produces the immutable, non-secret manifest DATASET.md Phase 2 requires
 * next to every retained backup. Reuses scripts/dataset/verify-backup.mjs
 * for hashing and inspection rather than duplicating that logic.
 *
 * The manifest deliberately CANNOT contain a password, token, connection
 * string, host, or any dump row data — see assertNoSecrets() below, which
 * fails closed if a field ever looks secret-bearing.
 *
 * Usage:
 *   # real artifact
 *   node scripts/dataset/create-backup-manifest.mjs <backup-file> \
 *     --source-env production-hostinger --operator "Name" --out manifest.json
 *
 *   --source-env takes a GENERIC LABEL only (letters, digits, hyphens).
 *   A hostname, IP, URL, or connection string is rejected outright.
 *
 *   # template, when no artifact is available yet
 *   node scripts/dataset/create-backup-manifest.mjs --template
 *
 * The manifest is safe to keep in operational records. The BACKUP ITSELF
 * must never be committed to Git (see .gitignore additions).
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBackup } from "./verify-backup.mjs";

/** Fields that must never appear in a manifest, checked by value shape not just name. */
const FORBIDDEN_VALUE_PATTERNS = [
  { pattern: /mysql:\/\/\S+:\S+@/i, label: "connection string with credentials" },
  { pattern: /\bpassword\b\s*[:=]\s*\S/i, label: "inline password" },
  { pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/, label: "long opaque token-like string" },
];

const FORBIDDEN_KEYS = /^(password|secret|token|connection_?string|dsn|db_host|host|credential)/i;

/**
 * The only shape a source label may take: a short generic slug such as
 * "production-hostinger". The character class alone makes a hostname, IP,
 * URL, or connection string unrepresentable — "." ":" "/" "@" are not
 * allowed — so the label can never smuggle an address past assertNoSecrets().
 */
const SAFE_SOURCE_LABEL = /^[a-z0-9][a-z0-9-]{0,47}$/i;

/** Words that make a label suspicious even when its characters are legal. */
const LABEL_FORBIDDEN_WORDS = /(password|passwd|secret|token|credential|apikey|api-key)/i;

/**
 * Normalizes and validates the operator-supplied source label. Returns the
 * label, or throws — an unusable label must stop the run rather than silently
 * degrade to something that might carry an address.
 */
export function assertSafeSourceLabel(label) {
  if (typeof label !== "string" || !SAFE_SOURCE_LABEL.test(label)) {
    throw new Error(
      `Invalid --source-env "${label}". Use a short generic label such as ` +
        `"production-hostinger" (letters, digits and hyphens only). Host addresses, ` +
        `URLs, and connection strings are never accepted.`
    );
  }
  if (LABEL_FORBIDDEN_WORDS.test(label)) {
    throw new Error(`Invalid --source-env "${label}": a source label must not name a credential.`);
  }
  return label;
}

/**
 * Fails closed. A manifest that might carry a secret is never written.
 * Known-safe long hex fields (SHA-256 checksums) are exempt from the
 * token heuristic because they are exactly what this manifest exists for.
 */
export function assertNoSecrets(manifest) {
  const problems = [];

  const walk = (value, keyPath) => {
    if (value === null || value === undefined) return;
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.test(k)) problems.push(`forbidden key "${[...keyPath, k].join(".")}"`);
        walk(v, [...keyPath, k]);
      }
      return;
    }
    if (typeof value !== "string") return;

    const leaf = keyPath[keyPath.length - 1] ?? "";
    const isChecksumField = /checksum|sha256/i.test(leaf) && /^[a-f0-9]{64}$/i.test(value);
    for (const { pattern, label } of FORBIDDEN_VALUE_PATTERNS) {
      if (isChecksumField && label === "long opaque token-like string") continue;
      if (pattern.test(value)) problems.push(`${label} at "${keyPath.join(".")}"`);
    }
  };

  walk(manifest, []);
  if (problems.length > 0) {
    throw new Error(`Refusing to write manifest — possible secret exposure: ${problems.join("; ")}`);
  }
  return true;
}

/** Coarse environment class read off the label; never an address. */
function deriveEnvironment(label) {
  const match = /^(production|staging|development|local)/i.exec(label);
  return match ? match[1].toLowerCase() : "unspecified";
}

function templateManifest() {
  return {
    manifestVersion: 1,
    manifestKind: "TEMPLATE — no real backup artifact was available when this was generated",
    backup: {
      filename: "<fill in: e.g. u350003894_brawl2-2026-07-18-0658.sql.gz>",
      backupType: "full logical dump (schema + data)",
      createdAt: "<fill in: Hostinger backup creation time, UTC>",
      acquiredAt: "<fill in: when it was downloaded, UTC>",
      sizeBytes: null,
      sizeMb: null,
      sha256: "<fill in: run scripts/dataset/verify-backup.mjs>",
      compression: "<gzip | zip | none>",
      encryptedAtRest: false,
      encryptionMethod: "<age | gpg | provider-managed KMS — see restore-runbook.md>",
    },
    source: {
      environment: "production",
      provider: "Hostinger shared MySQL",
      databaseName: "u350003894_brawl2",
      engine: "<fill in from the dump header, e.g. MariaDB 10.x>",
      // The host address is deliberately absent — not merely unrecorded.
      // It is private configuration and is not needed to validate or
      // restore a downloaded artifact. "label" is a generic identifier
      // only; see assertSafeSourceLabel().
      label: "production-hostinger",
    },
    verification: {
      verifiedWith: "scripts/dataset/verify-backup.mjs",
      verifiedAt: null,
      checksPassed: null,
      checksFailed: null,
      notes: "<paste the non-secret verdict line>",
    },
    restoreTest: {
      status: "NOT_PERFORMED",
      isolatedEngine: null,
      isolatedDatabaseName: null,
      restoreStartedAt: null,
      restoreDurationSeconds: null,
      validationScript: "scripts/dataset/validate-restored-db.sql",
      validationResult: null,
      cleanedUp: null,
    },
    operator: {
      name: "<fill in>",
      notes: "",
    },
  };
}

async function main() {
  const args = process.argv.slice(2);

  const outIndex = args.indexOf("--out");
  const outPath = outIndex >= 0 ? args[outIndex + 1] : null;

  if (args.includes("--template")) {
    const manifest = templateManifest();
    assertNoSecrets(manifest);
    const json = `${JSON.stringify(manifest, null, 2)}\n`;
    if (outPath) {
      await writeFile(outPath, json, "utf8");
      console.log(`Wrote TEMPLATE manifest to ${outPath}`);
      console.log("This is a template. restoreTest.status is NOT_PERFORMED and must stay that way until a real isolated restore runs.");
    } else {
      console.log(json);
    }
    return;
  }

  const target = args.find((a) => !a.startsWith("--") && a !== outPath);
  if (!target) {
    console.error("Usage: node scripts/dataset/create-backup-manifest.mjs <backup-file> [--source-env ENV] [--operator NAME] [--out FILE]");
    console.error("       node scripts/dataset/create-backup-manifest.mjs --template [--out FILE]");
    process.exitCode = 2;
    return;
  }

  // indexOf returns -1 when a flag is absent, and args[-1 + 1] is args[0] —
  // i.e. the backup path would silently become the value. Read flags only
  // when they are actually present.
  const flagValue = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const sourceLabel = assertSafeSourceLabel(flagValue("--source-env") ?? "unspecified-source");
  const operator = flagValue("--operator") ?? "unrecorded";

  const result = await verifyBackup(target);
  if (!result.sha256) {
    console.error(`Cannot manifest an unreadable artifact: ${target}`);
    process.exitCode = 1;
    return;
  }

  const manifest = {
    manifestVersion: 1,
    manifestKind: "REAL",
    backup: {
      filename: path.basename(result.filePath),
      backupType: result.foundTableCount > 0 ? "logical dump containing schema" : "logical dump (no expected table DDL detected)",
      createdAt: null,
      acquiredAt: new Date().toISOString(),
      sizeBytes: result.sizeBytes,
      sizeMb: result.sizeMb,
      sha256: result.sha256,
      compression: result.format,
      encryptedAtRest: false,
      encryptionMethod: null,
    },
    source: {
      environment: deriveEnvironment(sourceLabel),
      provider: "Hostinger shared MySQL",
      databaseName: result.detectedDatabaseName,
      engine: result.sourceServerVersion,
      label: sourceLabel,
    },
    verification: {
      verifiedWith: "scripts/dataset/verify-backup.mjs",
      verifiedAt: new Date().toISOString(),
      checksPassed: result.checks.filter((c) => c.passed).length,
      // Counts every check that did not pass, not only error-severity ones.
      // A required table-presence check that failed must never be summarised
      // as checksFailed: 0 just because it was graded a warning.
      checksFailed: result.checks.filter((c) => !c.passed).length,
      checksFailedBlocking: result.checks.filter((c) => !c.passed && c.severity === "error").length,
      expectedTableCount: result.expectedTableCount,
      foundTableCount: result.foundTableCount,
      // Meaningless unless enumeration completed, so it is reported next to
      // the flag that says whether it means anything.
      tableEnumeration: result.verdict?.tableEnumeration ?? "inconclusive",
      missingTables: result.missingTables,
      missingCriticalTables: result.missingCriticalTables ?? [],
      unexpectedTables: result.unexpectedTables ?? [],
      verdict: result.verdict,
      usable: result.usable,
    },
    restoreTest: {
      // Never pre-filled. Only an operator who actually ran the restore
      // may change this, and only after validate-restored-db.sql passes.
      status: "NOT_PERFORMED",
      isolatedEngine: null,
      isolatedDatabaseName: null,
      restoreStartedAt: null,
      restoreDurationSeconds: null,
      validationScript: "scripts/dataset/validate-restored-db.sql",
      validationResult: null,
      cleanedUp: null,
    },
    operator: { name: operator, notes: "" },
  };

  assertNoSecrets(manifest);
  const json = `${JSON.stringify(manifest, null, 2)}\n`;

  if (outPath) {
    await writeFile(outPath, json, "utf8");
    console.log(`Wrote manifest to ${outPath}`);
  } else {
    console.log(json);
  }
  console.log("restoreTest.status = NOT_PERFORMED. Creating a manifest is not restore proof.");
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`create-backup-manifest error: ${error.message}`);
    process.exitCode = 2;
  });
}
