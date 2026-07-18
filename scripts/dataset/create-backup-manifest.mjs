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
 *     --source-env production --operator "Name" --out manifest.json
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
      // Host is deliberately omitted. It is private configuration and is
      // not needed to validate or restore a downloaded artifact.
      hostRecorded: false,
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

  const sourceEnv = args[args.indexOf("--source-env") + 1] ?? "unknown";
  const operator = args[args.indexOf("--operator") + 1] ?? "unrecorded";

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
      backupType: result.foundTableCount > 0 ? "logical dump containing schema" : "logical dump (schema not detected in head)",
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
      environment: sourceEnv,
      provider: "Hostinger shared MySQL",
      databaseName: result.detectedDatabaseName,
      engine: result.sourceServerVersion,
      hostRecorded: false,
    },
    verification: {
      verifiedWith: "scripts/dataset/verify-backup.mjs",
      verifiedAt: new Date().toISOString(),
      checksPassed: result.checks.filter((c) => c.passed).length,
      checksFailed: result.checks.filter((c) => !c.passed && c.severity === "error").length,
      expectedTableCount: result.expectedTableCount,
      foundTableCount: result.foundTableCount,
      missingTables: result.missingTables,
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
