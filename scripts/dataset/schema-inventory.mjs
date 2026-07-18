#!/usr/bin/env node
/**
 * DATASET Phase 1 — deterministic schema inventory built from migration files.
 *
 * Read-only in the strongest sense: this script NEVER opens a database
 * connection. It parses migrations/*.sql in applied order and emits a
 * machine-readable inventory of tables, columns, keys, foreign keys,
 * generated columns, and CHECK constraints.
 *
 * The result is therefore the REPOSITORY-DECLARED schema, not the live
 * production schema. DATASET.md is explicit that the two must not be
 * conflated ("Do not invent the live schema from migrations alone").
 * Compare this output against information_schema using
 * scripts/dataset/production-size-report.sql before trusting it for a
 * migration decision — any difference is schema drift.
 *
 * Usage:
 *   node scripts/dataset/schema-inventory.mjs              # human summary
 *   node scripts/dataset/schema-inventory.mjs --json       # full JSON
 *   node scripts/dataset/schema-inventory.mjs --out FILE   # write JSON to FILE
 */

import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

/** Columns whose growth is driven by unbounded payload text rather than row count. */
const HIGH_GROWTH_TYPES = new Set(["LONGTEXT", "MEDIUMTEXT", "TEXT", "BLOB", "LONGBLOB"]);

/** Column names that a retention/archival policy must reason about explicitly. */
const RETENTION_SENSITIVE = /^(created_at|updated_at|started_at|completed_at|occurred_at|observed_at|recorded_at|received_at|first_observed_at|last_seen_at|first_seen_at|resolved_at|published_at|superseded_at|detected_at|expires_at|released_at|archived_at|verified_at|payload_removed_at|next_attempt_at|last_crawled_at|lease_expires_at)$/;

function stripComments(sql) {
  // Only line comments are used by this repository's migrations.
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/**
 * Splits a CREATE TABLE body on top-level commas only, so a comma inside
 * CHECK (status IN ('a','b')) or a multi-column key does not split the item.
 */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      current += ch;
      if (ch === "'" && body[i - 1] !== "\\") inString = false;
      continue;
    }
    if (ch === "'") { inString = true; current += ch; continue; }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

function emptyTable(name, migration) {
  return {
    table: name,
    createdByMigration: migration,
    alteredByMigrations: [],
    engine: null,
    collation: null,
    columns: [],
    primaryKey: [],
    uniqueKeys: [],
    indexes: [],
    foreignKeys: [],
    generatedColumns: [],
    checkConstraints: [],
    timestampColumns: [],
    statusColumns: [],
    retentionSensitiveColumns: [],
    highGrowthColumns: [],
  };
}

function classifyColumn(table, col) {
  if (RETENTION_SENSITIVE.test(col.name)) table.retentionSensitiveColumns.push(col.name);
  if (/^(DATETIME|TIMESTAMP|DATE)/i.test(col.type)) table.timestampColumns.push(col.name);
  if (/^(status|archive_status|outcome|hold_reason)$/.test(col.name)) table.statusColumns.push(col.name);
  const baseType = col.type.replace(/\(.*$/, "").toUpperCase();
  if (HIGH_GROWTH_TYPES.has(baseType)) table.highGrowthColumns.push({ column: col.name, type: baseType, nullable: col.nullable });
}

function parseColumnOrConstraint(table, item) {
  const upper = item.toUpperCase();

  if (upper.startsWith("PRIMARY KEY")) {
    table.primaryKey = (item.match(/\(([^)]*)\)/)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return;
  }
  if (upper.startsWith("UNIQUE KEY") || upper.startsWith("UNIQUE INDEX")) {
    const m = /UNIQUE\s+(?:KEY|INDEX)\s+(\w+)\s*\(([^)]*)\)/i.exec(item);
    if (m) table.uniqueKeys.push({ name: m[1], columns: m[2].split(",").map((s) => s.trim()) });
    return;
  }
  if (upper.startsWith("KEY ") || upper.startsWith("INDEX ")) {
    const m = /(?:KEY|INDEX)\s+(\w+)\s*\(([^)]*)\)/i.exec(item);
    if (m) table.indexes.push({ name: m[1], columns: m[2].split(",").map((s) => s.trim()) });
    return;
  }
  if (upper.startsWith("CONSTRAINT")) {
    const fk = /CONSTRAINT\s+(\w+)\s+FOREIGN KEY\s*\(([^)]*)\)\s*REFERENCES\s+(\w+)\s*\(([^)]*)\)/i.exec(item);
    if (fk) {
      table.foreignKeys.push({
        name: fk[1],
        columns: fk[2].split(",").map((s) => s.trim()),
        referencedTable: fk[3],
        referencedColumns: fk[4].split(",").map((s) => s.trim()),
      });
      return;
    }
    const chk = /CONSTRAINT\s+(\w+)\s+CHECK\s*\(([\s\S]*)\)\s*$/i.exec(item);
    if (chk) {
      table.checkConstraints.push({ name: chk[1], expression: chk[2].replace(/\s+/g, " ").trim() });
      return;
    }
    return;
  }

  const colMatch = /^`?(\w+)`?\s+([A-Za-z]+(?:\([^)]*\))?(?:\s+UNSIGNED)?)/.exec(item);
  if (!colMatch) return;
  const [, name, type] = colMatch;

  const generated = /GENERATED\s+ALWAYS\s+AS\s*\(([\s\S]*?)\)\s*(STORED|VIRTUAL)/i.exec(item);
  const column = {
    name,
    type: type.trim(),
    nullable: !/NOT NULL/i.test(item),
    default: /DEFAULT\s+([^,]+?)(?:\s+ON UPDATE|\s*$)/i.exec(item)?.[1]?.trim() ?? null,
    onUpdate: /ON UPDATE\s+([A-Z_0-9()]+)/i.exec(item)?.[1] ?? null,
    generated: Boolean(generated),
  };
  table.columns.push(column);
  classifyColumn(table, column);

  if (generated) {
    table.generatedColumns.push({
      column: name,
      expression: generated[1].replace(/\s+/g, " ").trim(),
      storage: generated[2].toUpperCase(),
    });
  }
}

function applyCreateTable(tables, sql, migration) {
  const re = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?`?(\w+)`?\s*\(([\s\S]*?)\)\s*ENGINE\s*=\s*(\w+)([^;]*);/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const [, name, body, engine, tail] = m;
    const table = emptyTable(name, migration);
    table.engine = engine;
    table.collation = /COLLATE\s*=?\s*(\w+)/i.exec(tail)?.[1] ?? null;
    for (const item of splitTopLevel(body)) parseColumnOrConstraint(table, item);
    tables.set(name, table);
  }
}

function applyAlterTable(tables, sql, migration) {
  const re = /ALTER TABLE\s+`?(\w+)`?\s*([\s\S]*?);/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const [, name, body] = m;
    const table = tables.get(name);
    if (!table) continue;
    if (!table.alteredByMigrations.includes(migration)) table.alteredByMigrations.push(migration);

    for (const clause of splitTopLevel(body)) {
      const addCol = /^ADD COLUMN\s+([\s\S]+)$/i.exec(clause);
      if (addCol) { parseColumnOrConstraint(table, addCol[1]); continue; }
      const modifyCol = /^MODIFY COLUMN\s+([\s\S]+)$/i.exec(clause);
      if (modifyCol) {
        const nameMatch = /^`?(\w+)`?/.exec(modifyCol[1]);
        if (nameMatch) {
          const idx = table.columns.findIndex((c) => c.name === nameMatch[1]);
          if (idx >= 0) table.columns.splice(idx, 1);
        }
        parseColumnOrConstraint(table, modifyCol[1]);
        continue;
      }
      const dropConstraint = /^DROP CONSTRAINT\s+`?(\w+)`?/i.exec(clause);
      if (dropConstraint) {
        table.checkConstraints = table.checkConstraints.filter((c) => c.name !== dropConstraint[1]);
        continue;
      }
      const addUnique = /^ADD UNIQUE KEY\s+(\w+)\s*\(([^)]*)\)/i.exec(clause);
      if (addUnique) { table.uniqueKeys.push({ name: addUnique[1], columns: addUnique[2].split(",").map((s) => s.trim()) }); continue; }
      const addKey = /^ADD KEY\s+(\w+)\s*\(([^)]*)\)/i.exec(clause);
      if (addKey) { table.indexes.push({ name: addKey[1], columns: addKey[2].split(",").map((s) => s.trim()) }); continue; }
      const addConstraint = /^ADD CONSTRAINT\s+([\s\S]+)$/i.exec(clause);
      if (addConstraint) { parseColumnOrConstraint(table, `CONSTRAINT ${addConstraint[1]}`); continue; }
    }
  }
}

export async function buildInventory() {
  const entries = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const tables = new Map();
  const migrations = [];

  for (const filename of entries) {
    const raw = await readFile(path.join(MIGRATIONS_DIR, filename), "utf8");
    migrations.push({
      filename,
      version: /^(\d+)_/.exec(filename)?.[1] ?? null,
      // Checksum over the RAW file bytes, matching scripts/migrate.mjs exactly,
      // so this inventory's checksums can be compared with schema_migrations.
      checksum: createHash("sha256").update(raw, "utf8").digest("hex"),
    });
    const sql = stripComments(raw);
    applyCreateTable(tables, sql, filename);
    applyAlterTable(tables, sql, filename);
  }

  const tableList = [...tables.values()].sort((a, b) => a.table.localeCompare(b.table));

  return {
    generatedFrom: "migrations/*.sql",
    evidenceClass: "repository-declared (NOT verified against the live database)",
    migrationCount: migrations.length,
    tableCount: tableList.length,
    migrations,
    tables: tableList,
    referentialGraph: tableList.flatMap((t) =>
      t.foreignKeys.map((fk) => ({ from: t.table, columns: fk.columns, to: fk.referencedTable, constraint: fk.name }))
    ),
    highGrowthColumns: tableList.flatMap((t) =>
      t.highGrowthColumns.map((c) => ({ table: t.table, ...c }))
    ),
    generatedColumns: tableList.flatMap((t) =>
      t.generatedColumns.map((g) => ({ table: t.table, ...g }))
    ),
  };
}

function printSummary(inv) {
  console.log(`Schema inventory from ${inv.generatedFrom}`);
  console.log(`Evidence class: ${inv.evidenceClass}`);
  console.log(`${inv.migrationCount} migrations, ${inv.tableCount} tables\n`);

  for (const t of inv.tables) {
    const pk = t.primaryKey.length ? t.primaryKey.join(",") : "(none)";
    console.log(
      `${t.table.padEnd(30)} cols=${String(t.columns.length).padStart(2)} pk=${pk} ` +
        `uniq=${t.uniqueKeys.length} idx=${t.indexes.length} fk=${t.foreignKeys.length} ` +
        `chk=${t.checkConstraints.length} gen=${t.generatedColumns.length}`
    );
  }

  console.log(`\nHigh-growth (TEXT/BLOB) columns — ${inv.highGrowthColumns.length}:`);
  for (const c of inv.highGrowthColumns) {
    console.log(`  ${c.table}.${c.column} ${c.type}${c.nullable ? " NULL" : " NOT NULL"}`);
  }

  console.log(`\nGenerated columns (single-current-row invariants) — ${inv.generatedColumns.length}:`);
  for (const g of inv.generatedColumns) console.log(`  ${g.table}.${g.column} ${g.storage} := ${g.expression}`);

  console.log(`\nForeign-key edges — ${inv.referentialGraph.length}. Reminder: this is repository truth only.`);
  console.log("Verify against information_schema before acting on it (see docs/dataset/phase1-schema-audit.md).");
}

async function main() {
  const args = process.argv.slice(2);
  const inv = await buildInventory();

  const outIndex = args.indexOf("--out");
  if (outIndex >= 0) {
    const target = args[outIndex + 1];
    if (!target) throw new Error("--out requires a file path");
    await writeFile(target, `${JSON.stringify(inv, null, 2)}\n`, "utf8");
    console.log(`Wrote inventory for ${inv.tableCount} tables to ${target}`);
    return;
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(inv, null, 2));
    return;
  }

  printSummary(inv);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("schema-inventory.mjs")) {
  main().catch((error) => {
    console.error(`schema-inventory error: ${error.message}`);
    process.exitCode = 1;
  });
}
