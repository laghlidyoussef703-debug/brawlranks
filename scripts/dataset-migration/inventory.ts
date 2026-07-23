import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { TABLE_PLANS, type TablePlan } from "./model";
import type { SourceReader } from "./source-reader";

/** DATASET.md's authoritative source restore proof requires exact migrations through 0025. */
export const AUTHORITATIVE_SOURCE_MIGRATION_CEILING = 25;

// Must remain identical to scripts/migrate.mjs ACCEPTED_PRIOR_CHECKSUMS.
// This is the reviewed, schema-preserving MySQL 8.4 backtick-only supersession.
const ACCEPTED_PRIOR_CHECKSUMS: Readonly<Record<string, ReadonlySet<string>>> = {
  "0014": new Set(["aab4acd247747216c2a56ad2396d0c724d7fb74df02ba8b4fc36b075a4272302"]),
};

export interface RepositoryMigration {
  version: string;
  name: string;
  checksum: string;
  tables: string[];
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

export type SourceRequirement = "required" | "optional";
export type SchemaRole = "authoritative-source-and-target" | "target-only-or-future-schema";
export type InventoryAction = "sync" | "skip" | "fatal";

export interface TableInventoryEntry {
  table: string;
  family: string;
  creatingMigration: string;
  sourceRequirement: SourceRequirement;
  schemaRole: SchemaRole;
  sourceMigrationApplied: boolean;
  existsOnSource: boolean;
  existsOnTarget: boolean;
  action: InventoryAction;
  status: "ready_to_sync" | "skipped_absent_source_table" | "fatal_inventory_error" | "fatal_target_schema_error";
  reason: string;
}

export interface SkippedTableReport {
  passId: string;
  family: string;
  table: string;
  mode: "dry-run" | "apply";
  status: "skipped_absent_source_table";
  sourceRequirement: SourceRequirement;
  creatingMigration: string;
  reason: string;
  lagSeconds?: never;
  sourceTimeWatermark?: never;
  deletionRequired?: never;
}

const migrationNumber = (version: string): number => Number.parseInt(version, 10);

export async function readRepositoryMigrations(directory = path.resolve("migrations")): Promise<RepositoryMigration[]> {
  const filenames = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  return Promise.all(filenames.map(async (filename) => {
    const match = /^(\d+)_(.+)\.sql$/.exec(filename)!;
    const content = await readFile(path.join(directory, filename), "utf8");
    const tables = [...content.matchAll(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([a-zA-Z0-9_]+)`?\s*\(/gmi)].map((item) => item[1]);
    return {
      version: match[1],
      name: match[2],
      checksum: createHash("sha256").update(content, "utf8").digest("hex"),
      tables,
    };
  }));
}

function validateMigrationEvidence(repository: RepositoryMigration[], applied: AppliedMigration[]): Map<string, AppliedMigration> {
  const repositoryByVersion = new Map(repository.map((migration) => [migration.version, migration]));
  const appliedByVersion = new Map<string, AppliedMigration>();
  for (const row of applied) {
    const local = repositoryByVersion.get(row.version);
    if (!local) throw new Error(`Phase 8 inventory error: source schema_migrations contains unknown migration ${row.version}_${row.name}`);
    const checksumAccepted = local.checksum === row.checksum || ACCEPTED_PRIOR_CHECKSUMS[row.version]?.has(row.checksum) === true;
    if (local.name !== row.name || !checksumAccepted) {
      throw new Error(`Phase 8 inventory error: source migration ${row.version} does not match repository name/checksum`);
    }
    appliedByVersion.set(row.version, row);
  }
  return appliedByVersion;
}

export function classifyTableInventory(
  plans: TablePlan[],
  repository: RepositoryMigration[],
  applied: AppliedMigration[],
  sourceTables: ReadonlySet<string>,
  targetTables: ReadonlySet<string>
): TableInventoryEntry[] {
  const appliedByVersion = validateMigrationEvidence(repository, applied);
  const creatorByTable = new Map<string, RepositoryMigration>();
  for (const migration of repository) for (const table of migration.tables) {
    if (creatorByTable.has(table)) throw new Error(`Phase 8 inventory error: multiple creating migrations declare ${table}`);
    creatorByTable.set(table, migration);
  }

  return plans.map((plan) => {
    const creator = creatorByTable.get(plan.table);
    if (!creator) throw new Error(`Phase 8 inventory error: ${plan.family}.${plan.table} has no audited creating migration`);
    const baselineRequired = migrationNumber(creator.version) <= AUTHORITATIVE_SOURCE_MIGRATION_CEILING;
    const sourceMigrationApplied = appliedByVersion.has(creator.version);
    const sourceRequirement: SourceRequirement = baselineRequired || sourceMigrationApplied ? "required" : "optional";
    const schemaRole: SchemaRole = baselineRequired ? "authoritative-source-and-target" : "target-only-or-future-schema";
    const existsOnSource = sourceTables.has(plan.table), existsOnTarget = targetTables.has(plan.table);
    const creatingMigration = `${creator.version}_${creator.name}`;

    if (!existsOnSource) {
      if (sourceRequirement === "optional") return {
        table: plan.table, family: plan.family, creatingMigration, sourceRequirement, schemaRole,
        sourceMigrationApplied, existsOnSource, existsOnTarget, action: "skip", status: "skipped_absent_source_table",
        reason: `optional/source-conditional table is absent; ${creatingMigration} is not confirmed applied on the source`,
      };
      return {
        table: plan.table, family: plan.family, creatingMigration, sourceRequirement, schemaRole,
        sourceMigrationApplied, existsOnSource, existsOnTarget, action: "fatal", status: "fatal_inventory_error",
        reason: `required Phase 8 source table is absent; creating migration ${creatingMigration} is required or confirmed applied`,
      };
    }
    if (!existsOnTarget) return {
      table: plan.table, family: plan.family, creatingMigration, sourceRequirement, schemaRole,
      sourceMigrationApplied, existsOnSource, existsOnTarget, action: "fatal", status: "fatal_target_schema_error",
      reason: `source table exists but target table is absent; approved target migration ${creatingMigration} should already have created it`,
    };
    return {
      table: plan.table, family: plan.family, creatingMigration, sourceRequirement, schemaRole,
      sourceMigrationApplied, existsOnSource, existsOnTarget, action: "sync", status: "ready_to_sync",
      reason: "table exists on source and target",
    };
  });
}

async function tableNames(database: Pick<Pool, "query">): Promise<Set<string>> {
  const [rows] = await database.query<RowDataPacket[]>(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME"
  );
  return new Set(rows.map((row) => String(row.TABLE_NAME)));
}

export async function discoverTableInventory(source: SourceReader, target: Pool): Promise<TableInventoryEntry[]> {
  // Each side's tables are discovered exactly once before any table metadata or row reads.
  const [repository, sourceTables, targetTables] = await Promise.all([
    readRepositoryMigrations(), tableNames(source), tableNames(target),
  ]);
  if (!sourceTables.has("schema_migrations")) throw new Error("Phase 8 inventory error: required source table schema_migrations is absent");
  const [rows] = await source.query<RowDataPacket[]>("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
  return classifyTableInventory(
    TABLE_PLANS, repository,
    rows.map((row) => ({ version: String(row.version), name: String(row.name), checksum: String(row.checksum) })),
    sourceTables, targetTables
  );
}

export function assertInventoryReady(entries: TableInventoryEntry[], selectedTables?: ReadonlySet<string>): void {
  const fatal = entries.filter((entry) => entry.action === "fatal" && (!selectedTables || selectedTables.has(entry.table)));
  if (fatal.length) throw new Error(fatal.map((entry) => `[${entry.status}] ${entry.family}.${entry.table}: ${entry.reason}`).join("\n"));
}

export function skippedTableReport(entry: TableInventoryEntry, passId: string, apply: boolean): SkippedTableReport {
  return {
    passId, family: entry.family, table: entry.table, mode: apply ? "apply" : "dry-run",
    status: "skipped_absent_source_table", sourceRequirement: entry.sourceRequirement,
    creatingMigration: entry.creatingMigration, reason: entry.reason,
  };
}

export async function runInventoriedPlans<T>(
  entries: TableInventoryEntry[],
  plans: TablePlan[],
  sync: (plan: TablePlan, entry: TableInventoryEntry) => Promise<T>,
  skip: (entry: TableInventoryEntry) => T
): Promise<T[]> {
  const selectedTables = new Set(plans.map((plan) => plan.table));
  assertInventoryReady(entries, selectedTables);
  const output: T[] = [];
  for (const plan of plans) {
    const entry = entries.find((item) => item.table === plan.table);
    if (!entry) throw new Error(`Phase 8 inventory error: no inventory entry for ${plan.family}.${plan.table}`);
    output.push(entry.action === "skip" ? skip(entry) : await sync(plan, entry));
  }
  return output;
}
