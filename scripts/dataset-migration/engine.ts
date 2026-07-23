import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { canonicalRow, checksumRow, checksumRows, DivergenceError, type DbRow } from "./canonical";
import { compareCursor, pagePredicate, TABLE_PLANS, type CompositeCursor, type TablePlan } from "./model";
import type { MigrationStateStore, PageManifest, SyncState } from "./state";
import { redactSecrets } from "./config";
import type { SourceReader } from "./source-reader";
import { normalizeTimeCursor, normalizeTimestamp, normalizeTimestampRow, timestampForTarget } from "./timestamp";
import { classifyWorkflowLockRow, isMariaDbZeroDate, type SkippedEphemeralStaleLockEvidence } from "./workflow-lock-normalization";
import { assertTupleProgress, nextRetryAttempt, validatePageProgress, type MigrationProgressTracker } from "./progress";

export interface TableMetadata {
  columns: string[];
  generatedColumns: string[];
  primaryKey: string[];
  uniqueKeys: string[][];
  timestampColumns: string[];
  nullableColumns: string[];
}

export interface SyncOptions {
  apply: boolean;
  pageSize: number;
  maxRetries: number;
  overlapSeconds: number;
  allowReconcileDelete: boolean;
  sourceIdentity: string;
  targetIdentity: string;
  passId?: string;
  progress?: MigrationProgressTracker;
}

export interface TableReport {
  passId: string;
  family: string;
  table: string;
  mode: "dry-run" | "apply";
  status: "completed" | "failed";
  pages: number;
  sourceRows: number;
  inserted: number;
  updated: number;
  matched: number;
  deleted: number;
  plannedDeleted?: number;
  deletionRequired?: boolean;
  lagSeconds: number | null;
  reconciliation: ReconciliationReport;
  sourceTimeWatermark?: string | null;
  skippedEphemeralStaleLocks?: number;
  error?: string;
}

interface TargetLookupPolicy {
  sourceTimeWatermark: string;
  apply: boolean;
  allowReconcileDelete: boolean;
}

const TARGET_TIMESTAMP_REPAIR = Symbol("targetTimestampRepair");
type ExistingTargetRow = DbRow & { [TARGET_TIMESTAMP_REPAIR]?: boolean };

export interface ReconciliationReport {
  sourceCount: number;
  targetCount: number;
  sourceMin: string | null;
  sourceMax: string | null;
  targetMin: string | null;
  targetMax: string | null;
  hourlyBucketsMatch: boolean | null;
  sourceOnlyKeys: number | null;
  targetOnlyKeys: number | null;
  orphanCount: number;
  checks: string[];
  passed: boolean;
}

export const RUN_NONTERMINAL_STATUSES: Record<string, string[]> = {
  workflow_runs: ["running"],
  data_fetch_runs: ["pending", "running"],
  aggregation_runs: ["running"],
  ranking_runs: ["running"],
};

const q = (identifier: string): string => `\`${identifier.replace(/`/g, "``")}\``;
const keyText = (row: DbRow, key: string[]): string => key.map((column) => `${column}=${String(row[column])}`).join(",");
const TABLE_PLAN_BY_TABLE = new Map(TABLE_PLANS.map((plan) => [plan.table, plan]));
const PARENT_TABLES = new Set(TABLE_PLANS.flatMap((plan) => plan.parent ? [plan.parent.table] : []));

async function tracked<T>(options: SyncOptions, stage: string, task: () => Promise<T>): Promise<T> {
  return options.progress ? options.progress.query(stage, task) : task();
}

export const retryDelayMs = (retry: number): number => Math.min(2_000, 100 * (2 ** retry));

export async function readMetadata(pool: Pick<Pool, "query">, table: string): Promise<TableMetadata> {
  const [columns] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME, EXTRA, DATA_TYPE, IS_NULLABLE
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [table]
  );
  if (columns.length === 0) throw new Error(`Table ${table} does not exist in ${await databaseName(pool)}`);
  const [indexes] = await pool.query<RowDataPacket[]>(
    `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [table]
  );
  const grouped = new Map<string, string[]>();
  for (const row of indexes) {
    if (Number(row.NON_UNIQUE) !== 0) continue;
    const list = grouped.get(String(row.INDEX_NAME)) ?? [];
    list.push(String(row.COLUMN_NAME));
    grouped.set(String(row.INDEX_NAME), list);
  }
  return {
    columns: columns.map((row) => String(row.COLUMN_NAME)),
    generatedColumns: columns.filter((row) => String(row.EXTRA).toUpperCase().includes("GENERATED")).map((row) => String(row.COLUMN_NAME)),
    primaryKey: grouped.get("PRIMARY") ?? [],
    uniqueKeys: [...grouped.entries()].filter(([name]) => name !== "PRIMARY").map(([, value]) => value),
    timestampColumns: columns.filter((row) => /^(date|datetime|timestamp)$/i.test(String(row.DATA_TYPE))).map((row) => String(row.COLUMN_NAME)),
    nullableColumns: columns.filter((row) => String(row.IS_NULLABLE).toUpperCase() === "YES").map((row) => String(row.COLUMN_NAME)),
  };
}

async function databaseName(pool: Pick<Pool, "query">): Promise<string> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT DATABASE() AS db");
  return String(rows[0]?.db ?? "unknown");
}

export function assertSchemaCompatible(source: TableMetadata, target: TableMetadata, table: string): void {
  if (JSON.stringify(source.columns) !== JSON.stringify(target.columns)) throw new Error(`Schema mismatch for ${table}: ordered columns differ`);
  if (JSON.stringify(source.primaryKey) !== JSON.stringify(target.primaryKey)) throw new Error(`Schema mismatch for ${table}: primary key differs`);
  const sourceUnique = source.uniqueKeys.map((key) => key.join(",")).sort();
  const targetUnique = target.uniqueKeys.map((key) => key.join(",")).sort();
  if (JSON.stringify(sourceUnique) !== JSON.stringify(targetUnique)) throw new Error(`Schema mismatch for ${table}: unique keys differ`);
}

function startWithOverlap(cursor: CompositeCursor | null, seconds: number, isTime: boolean, plan: TablePlan): CompositeCursor | null {
  if (!cursor) return null;
  if (!isTime) return null; // full/hash scans intentionally restart for exact reconciliation
  const normalized = normalizeTimestamp(cursor.timestamp, { family: plan.family, table: plan.table, column: plan.cursorColumn!, operation: "overlap start calculation", nullable: false })!;
  const date = new Date(normalized);
  return { timestamp: new Date(date.getTime() - seconds * 1000).toISOString(), id: "" };
}

function hashExpression(primary: string): string {
  return `SHA2(COALESCE(CAST(${q(primary)} AS CHAR), ''), 256)`;
}

async function upperWatermark(source: SourceReader, plan: TablePlan, metadata: TableMetadata): Promise<CompositeCursor | null> {
  const primary = metadata.primaryKey[0];
  if (!primary) throw new Error(`${plan.table} has no primary key`);
  if (plan.cursorColumn) {
    const [rows] = await source.query<RowDataPacket[]>(
      `SELECT ${q(plan.cursorColumn)} AS cursor_value, ${q(primary)} AS cursor_id FROM ${q(plan.table)} ORDER BY ${q(plan.cursorColumn)} DESC, ${q(primary)} DESC LIMIT 1`
    );
    return rows.length ? {
      timestamp: normalizeTimestamp(rows[0].cursor_value, { family: plan.family, table: plan.table, column: plan.cursorColumn, operation: "fixed upper-watermark calculation", nullable: false })!,
      id: String(rows[0].cursor_id),
    } : null;
  }
  const expression = hashExpression(primary);
  const [rows] = await source.query<RowDataPacket[]>(
    `SELECT ${expression} AS cursor_value, ${q(primary)} AS cursor_id FROM ${q(plan.table)} ORDER BY cursor_value DESC, ${q(primary)} DESC LIMIT 1`
  );
  return rows.length ? { timestamp: String(rows[0].cursor_value), id: String(rows[0].cursor_id) } : null;
}

async function readPage(
  source: SourceReader,
  plan: TablePlan,
  metadata: TableMetadata,
  lower: CompositeCursor | null,
  upper: CompositeCursor,
  limit: number,
  parentState: SyncState | null,
  workflowSlugs: Map<string, string> | null,
  sourceTimeWatermark: string | null
): Promise<{ rows: DbRow[]; cursorRow: DbRow | null; rawSourceRowCount: number; firstRawRow: DbRow | null; normalizedTimestampCounts: Record<string, number>; skippedEvidence: SkippedEphemeralStaleLockEvidence[] }> {
  const primary = metadata.primaryKey[0];
  const cursorExpression = plan.cursorColumn ? q(plan.cursorColumn) : hashExpression(primary);
  const lowerValue = lower?.timestamp ?? "";
  const lowerId = lower?.id ?? "";
  const predicates = [pagePredicate(cursorExpression)];
  const params: unknown[] = [lowerValue, lowerValue, lowerId, upper.timestamp, upper.timestamp, upper.id];
  if (plan.parent) {
    const parentPlan = TABLE_PLAN_BY_TABLE.get(plan.parent.table);
    const selectionParts: string[] = [];
    if (parentPlan?.cursorColumn && parentState?.overlapStart && parentState.cursor) {
      selectionParts.push(pagePredicate(q(parentPlan.cursorColumn)));
      params.push(parentState.overlapStart.timestamp, parentState.overlapStart.timestamp, parentState.overlapStart.id, parentState.cursor.timestamp, parentState.cursor.timestamp, parentState.cursor.id);
    }
    const touched = parentState?.touchedKeys ?? [];
    if (touched.length > 0 && touched.length <= 5000) {
      selectionParts.push(`id IN (${touched.map(() => "?").join(",")})`); params.push(...touched);
    }
    const parentParts: string[] = [];
    if (selectionParts.length > 0) parentParts.push(`(${selectionParts.join(" OR ")})`);
    if (plan.parent.terminalStatuses?.length) {
      parentParts.push(`status IN (${plan.parent.terminalStatuses.map(() => "?").join(",")})`);
      params.push(...plan.parent.terminalStatuses);
    }
    if (parentParts.length > 0) predicates.push(`${q(plan.parent.foreignKey)} IN (SELECT id FROM ${q(plan.parent.table)} WHERE ${parentParts.join(" AND ")})`);
  }
  const [rows] = await source.query<RowDataPacket[]>(
    `SELECT * FROM ${q(plan.table)} WHERE ${predicates.join(" AND ")} ORDER BY ${cursorExpression}, ${q(primary)} LIMIT ?`,
    [...params, limit]
  );
  const normalizedTimestampCounts: Record<string, number> = {};
  const skippedEvidence: SkippedEphemeralStaleLockEvidence[] = [];
  const normalizedRows: DbRow[] = [];
  for (const rawRow of rows) {
    let row = rawRow as DbRow;
    if (plan.table === "workflow_locks" && isMariaDbZeroDate(row.locked_at)) {
      const definitionId = String(row.workflow_definition_id);
      const slug = workflowSlugs?.get(definitionId);
      if (!slug) throw new Error(`Cannot normalize workflow_locks.locked_at: no verified workflow slug for definition ${definitionId}`);
      if (!sourceTimeWatermark) throw new Error("Cannot classify workflow_locks zero-date row without a fixed source watermark");
      const decision = classifyWorkflowLockRow(row, slug, sourceTimeWatermark);
      if (decision.action === "skip") { skippedEvidence.push(decision.evidence); continue; }
      row = decision.row;
      if (decision.normalized) normalizedTimestampCounts[slug] = (normalizedTimestampCounts[slug] ?? 0) + 1;
    }
    normalizedRows.push(normalizeTimestampRow(row, metadata, plan, "source page normalization"));
  }
  return {
    rows: normalizedRows,
    cursorRow: rows.length ? rows[rows.length - 1] as DbRow : null,
    rawSourceRowCount: rows.length,
    firstRawRow: rows.length ? rows[0] as DbRow : null,
    normalizedTimestampCounts,
    skippedEvidence,
  };
}

async function workflowSlugMap(source: SourceReader): Promise<Map<string, string>> {
  const [rows] = await source.query<RowDataPacket[]>("SELECT id, slug FROM workflow_definitions ORDER BY id");
  return new Map(rows.map((row) => [String(row.id), String(row.slug)]));
}

async function fixedSourceTimeWatermark(source: SourceReader): Promise<string> {
  const [rows] = await source.query<RowDataPacket[]>("SELECT UTC_TIMESTAMP(3) AS source_time_watermark");
  return normalizeTimestamp(rows[0]?.source_time_watermark, {
    family: "workflow-children", table: "workflow_locks", column: "source_time_watermark",
    operation: "fixed source watermark capture", nullable: false,
  })!;
}

function nextCursor(row: DbRow, plan: TablePlan, metadata: TableMetadata): CompositeCursor {
  const primary = metadata.primaryKey[0];
  if (plan.cursorColumn) return {
    timestamp: normalizeTimestamp(row[plan.cursorColumn], { family: plan.family, table: plan.table, column: plan.cursorColumn, operation: "page cursor calculation", nullable: false })!,
    id: String(row[primary]),
  };
  const hash = checksumRow({ value: row[primary] }, ["value"]);
  // SQL hashes CAST(pk AS CHAR), while this hash includes JSON framing. Re-querying
  // with a mismatched cursor would be unsafe, so hash pages compute the SQL value explicitly below.
  return { timestamp: hash, id: String(row[primary]) };
}

async function nextCursorFromSource(source: SourceReader, plan: TablePlan, metadata: TableMetadata, row: DbRow): Promise<CompositeCursor> {
  if (plan.cursorColumn) return nextCursor(row, plan, metadata);
  const primary = metadata.primaryKey[0];
  const [rows] = await source.query<RowDataPacket[]>(`SELECT ${hashExpression(primary)} AS h FROM ${q(plan.table)} WHERE ${q(primary)} = ?`, [row[primary]]);
  return { timestamp: String(rows[0].h), id: String(row[primary]) };
}

function sameRow(source: DbRow, target: DbRow, columns: string[]): boolean {
  return canonicalRow(source, columns) === canonicalRow(target, columns);
}

async function findExisting(connection: PoolConnection, plan: TablePlan, row: DbRow, metadata: TableMetadata, naturalKeys: string[][], targetPolicy?: TargetLookupPolicy): Promise<ExistingTargetRow | null> {
  const keys = [metadata.primaryKey, ...naturalKeys, ...metadata.uniqueKeys].filter((key) => key.length > 0 && key.every((column) => row[column] !== null && row[column] !== undefined));
  for (const key of keys) {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT * FROM ${q(plan.table)} WHERE ${key.map((column) => `${q(column)} <=> ?`).join(" AND ")} LIMIT 1`,
      key.map((column) => row[column])
    );
    if (rows.length > 0) {
      const rawTarget = rows[0] as DbRow;
      if (plan.table === "workflow_locks" && isMariaDbZeroDate(rawTarget.locked_at)) {
        if (!targetPolicy) throw new Error("Cannot classify target workflow_locks zero-date row without the fixed pass watermark");
        const [definitions] = await connection.query<RowDataPacket[]>(
          "SELECT slug FROM workflow_definitions WHERE id=? LIMIT 1",
          [rawTarget.workflow_definition_id]
        );
        const slug = definitions[0]?.slug == null ? null : String(definitions[0].slug);
        if (!slug) throw new Error(`Cannot reconcile target workflow_locks zero-date lock ${String(rawTarget.id)}: missing workflow definition mapping`);
        const decision = classifyWorkflowLockRow(rawTarget, slug, targetPolicy.sourceTimeWatermark);
        if (decision.action === "skip") {
          if (targetPolicy.apply && !targetPolicy.allowReconcileDelete) {
            throw new Error(`Target workflow_locks historical zero-date lock ${String(rawTarget.id)} requires --allow-reconcile-delete`);
          }
          // The scoped reconciliation scan reports this deletion. Treating the
          // stale row as absent lets dry-run continue without inventing a value.
          return null;
        }
        const normalized = normalizeTimestampRow(decision.row, metadata, plan, "target workflow-lock deterministic normalization") as ExistingTargetRow;
        if (decision.normalized) Object.defineProperty(normalized, TARGET_TIMESTAMP_REPAIR, { value: true });
        return normalized;
      }
      return normalizeTimestampRow(rawTarget, metadata, plan, "target row normalization");
    }
  }
  return null;
}

async function applyRow(connection: PoolConnection, plan: TablePlan, metadata: TableMetadata, row: DbRow, targetPolicy?: TargetLookupPolicy): Promise<"inserted" | "updated" | "matched"> {
  if (plan.parent) {
    const [parentRows] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM ${q(plan.parent.table)} WHERE id = ? LIMIT 1`,
      [row[plan.parent.foreignKey]]
    );
    if (parentRows.length === 0) throw new Error(`Dependency violation: ${plan.parent.table} must be synchronized before ${plan.table}`);
  }
  const writable = metadata.columns.filter((column) => !metadata.generatedColumns.includes(column));
  const targetValue = (column: string): unknown => metadata.timestampColumns.includes(column)
    ? timestampForTarget(row[column], { family: plan.family, table: plan.table, column, operation: "target write binding", nullable: metadata.nullableColumns.includes(column) })
    : row[column];
  const comparable = plan.table === "published_snapshots" ? writable.filter((column) => column !== "is_current") : writable;
  const existing = await findExisting(connection, plan, row, metadata, plan.naturalKeys ?? [], targetPolicy);
  if (existing) {
    const sourcePk = keyText(row, metadata.primaryKey);
    const targetPk = keyText(existing, metadata.primaryKey);
    if (sourcePk !== targetPk) {
      throw new DivergenceError({ table: plan.table, key: sourcePk, sourceChecksum: checksumRow(row, writable), targetChecksum: checksumRow(existing, writable), context: { reason: "natural_key_maps_to_different_primary_key" } });
    }
    if (sameRow(row, existing, comparable) && !existing[TARGET_TIMESTAMP_REPAIR]) return "matched";
    if (plan.mutableColumns) {
      const immutableColumns = comparable.filter((column) => !plan.mutableColumns!.includes(column));
      if (!sameRow(row, existing, immutableColumns)) {
        throw new DivergenceError({ table: plan.table, key: sourcePk, sourceChecksum: checksumRow(row, immutableColumns), targetChecksum: checksumRow(existing, immutableColumns), context: { reason: "immutable_columns_changed_in_mutable_table" } });
      }
    }
    if (plan.mode === "immutable") {
      throw new DivergenceError({ table: plan.table, key: sourcePk, sourceChecksum: checksumRow(row, writable), targetChecksum: checksumRow(existing, writable), context: { primaryKey: sourcePk } });
    }
    const mutable = (plan.mutableColumns ?? comparable).filter((column) => comparable.includes(column) && !metadata.primaryKey.includes(column));
    await connection.query(
      `UPDATE ${q(plan.table)} SET ${mutable.map((column) => `${q(column)} = ?`).join(", ")} WHERE ${metadata.primaryKey.map((column) => `${q(column)} <=> ?`).join(" AND ")}`,
      [...mutable.map(targetValue), ...metadata.primaryKey.map((column) => row[column])]
    );
    return "updated";
  }
  await connection.query(
    `INSERT INTO ${q(plan.table)} (${writable.map(q).join(", ")}) VALUES (${writable.map(() => "?").join(", ")})`,
    writable.map((column) => plan.table === "published_snapshots" && column === "is_current" ? 0 : targetValue(column))
  );
  return "inserted";
}

async function verifyPage(target: PoolConnection, plan: TablePlan, metadata: TableMetadata, rows: DbRow[], targetPolicy?: TargetLookupPolicy): Promise<string> {
  const writable = metadata.columns.filter((column) => !metadata.generatedColumns.includes(column));
  const comparable = plan.table === "published_snapshots" ? writable.filter((column) => column !== "is_current") : writable;
  const verified: DbRow[] = [];
  for (const sourceRow of rows) {
    const targetRow = await findExisting(target, plan, sourceRow, metadata, plan.naturalKeys ?? [], targetPolicy);
    if (!targetRow || !sameRow(sourceRow, targetRow, comparable)) {
      throw new Error(`Target verification failed for ${plan.table} ${keyText(sourceRow, metadata.primaryKey)}`);
    }
    verified.push(targetRow);
  }
  return checksumRows(verified, comparable);
}

function initialState(plan: TablePlan, options: SyncOptions, passId: string, cursor: CompositeCursor | null, upper: CompositeCursor | null, sourceTimeWatermark: string | null): SyncState {
  return {
    version: 1,
    sourceIdentity: options.sourceIdentity,
    targetIdentity: options.targetIdentity,
    family: plan.family,
    table: plan.table,
    cursor,
    upperWatermark: upper,
    overlapStart: cursor,
    passId,
    pageNumber: 0,
    status: "running",
    pageCounts: { completed: 0, failed: 0, rows: 0 },
    latestManifestChecksum: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    sourceTimeWatermark,
    error: null,
    touchedKeys: [],
  };
}

export async function syncTable(source: SourceReader, target: Pool, store: MigrationStateStore, plan: TablePlan, options: SyncOptions): Promise<TableReport> {
  await options.progress?.emit("table_started", { family: plan.family, table: plan.table, pageNumber: 0 });
  const sourceMeta = await tracked(options, `${plan.table}:source_metadata`, () => readMetadata(source, plan.table));
  const targetMeta = await tracked(options, `${plan.table}:target_metadata`, () => readMetadata(target, plan.table));
  await options.progress?.emit("metadata", { family: plan.family, table: plan.table, pageNumber: 0 });
  assertSchemaCompatible(sourceMeta, targetMeta, plan.table);
  const loadedPrevious = await store.read(plan.table);
  const previous = loadedPrevious && plan.cursorColumn ? {
    ...loadedPrevious,
    cursor: normalizeTimeCursor(loadedPrevious.cursor, plan, plan.cursorColumn, "durable cursor loading"),
    upperWatermark: normalizeTimeCursor(loadedPrevious.upperWatermark, plan, plan.cursorColumn, "durable upper-watermark loading"),
    overlapStart: normalizeTimeCursor(loadedPrevious.overlapStart, plan, plan.cursorColumn, "durable overlap loading"),
  } : loadedPrevious;
  if (previous && (previous.sourceIdentity !== options.sourceIdentity || previous.targetIdentity !== options.targetIdentity)) throw new Error(`Durable state identity mismatch for ${plan.table}`);

  const resume = previous?.status === "running" || previous?.status === "failed";
  const passId = options.passId ?? (resume ? previous!.passId : randomUUID());
  const isTimeCursor = Boolean(plan.cursorColumn);
  const overlap = resume ? previous!.overlapStart : startWithOverlap(previous?.cursor ?? null, options.overlapSeconds, isTimeCursor, plan);
  const upper = resume ? previous!.upperWatermark : await tracked(options, `${plan.table}:upper_watermark`, () => upperWatermark(source, plan, sourceMeta));
  const sourceTimeWatermark = plan.table === "workflow_locks"
    ? resume
      ? previous!.sourceTimeWatermark ?? (() => { throw new Error("Cannot resume workflow_locks state without its fixed source watermark; use a fresh state directory"); })()
      : await tracked(options, `${plan.table}:source_time_watermark`, () => fixedSourceTimeWatermark(source))
    : null;
  let state = resume ? { ...previous!, status: "running" as const, error: null } : initialState(plan, options, passId, overlap, upper, sourceTimeWatermark);
  await store.write(plan.table, state);
  options.progress?.activity();
  await options.progress?.emit("upper_watermark", { family: plan.family, table: plan.table, pageNumber: state.pageNumber, cursorAfter: upper });

  let inserted = 0, updated = 0, matched = 0, deleted = 0, plannedDeleted = 0, sourceRows = 0, skippedEphemeralStaleLocks = 0;
  if (!upper) {
    state = { ...state, status: "completed", completedAt: new Date().toISOString() };
    await store.write(plan.table, state);
    options.progress?.activity();
    const reconciliation = await tracked(options, `${plan.table}:empty_reconciliation`, () => reconcileTable(source, target, plan, sourceMeta));
    await options.progress?.emit("table_completed", { family: plan.family, table: plan.table, pageNumber: 0, rowsRead: 0, inserted: 0, updated: 0, deleted: 0, cursorAfter: null });
    return { passId, family: plan.family, table: plan.table, mode: options.apply ? "apply" : "dry-run", status: "completed", pages: 0, sourceRows: 0, inserted: 0, updated: 0, matched: 0, deleted: 0, lagSeconds: 0, reconciliation };
  }

  let cursor = state.cursor;
  const collectTouchedKeys = PARENT_TABLES.has(plan.table) && !plan.cursorColumn;
  const touchedKeys = new Set(collectTouchedKeys ? state.touchedKeys ?? [] : []);
  const parentState = plan.parent ? await store.read(plan.parent.table) : null;
  const workflowSlugs = plan.table === "workflow_locks" ? await tracked(options, `${plan.table}:workflow_definitions`, () => workflowSlugMap(source)) : null;
  const targetPolicy = sourceTimeWatermark ? {
    sourceTimeWatermark,
    apply: options.apply,
    allowReconcileDelete: options.allowReconcileDelete,
  } : undefined;
  try {
    // Ephemeral active-lock uniqueness can otherwise block insertion of the
    // authoritative source lock. This pre-delete is opt-in and allowlisted to
    // workflow_locks only; it occurs in bounded target transactions.
    if (plan.deleteTargetOnly) {
      const deletion = await tracked(options, `${plan.table}:delete_reconciliation`, () => reconcileDeletes(
        source, target, plan, sourceMeta, options.pageSize, sourceTimeWatermark!,
        options.apply && options.allowReconcileDelete
      ));
      plannedDeleted = deletion.planned;
      deleted = deletion.deleted;
    }
    for (;;) {
      const pageStarted = Date.now();
      const page = await tracked(options, `${plan.table}:source_page:${state.pageNumber + 1}`, () => readPage(source, plan, sourceMeta, cursor, upper, options.pageSize, parentState, workflowSlugs, sourceTimeWatermark));
      const { rows, normalizedTimestampCounts, skippedEvidence } = page;
      if (page.rawSourceRowCount === 0) break;
      const next = await tracked(options, `${plan.table}:next_cursor:${state.pageNumber + 1}`, () => nextCursorFromSource(source, plan, sourceMeta, page.cursorRow!));
      const lastRowIdentity = keyText(page.cursorRow!, sourceMeta.primaryKey);
      validatePageProgress(plan, cursor, next, page.rawSourceRowCount, lastRowIdentity);
      if (compareCursor(next, upper) > 0) throw new Error(`Phase 8 cursor progress error: cursor exceeded fixed upper watermark; family=${plan.family}; table=${plan.table}; next=${JSON.stringify(next)}; upper=${JSON.stringify(upper)}; rowCount=${page.rawSourceRowCount}; lastRowIdentity=${lastRowIdentity}`);
      const skippedCountsBySlug = Object.fromEntries([...new Set(skippedEvidence.map((item) => item.workflowSlug))].map((slug) => [slug, skippedEvidence.filter((item) => item.workflowSlug === slug).length]));
      let retry = 0;
      let pageResult = { inserted: 0, updated: 0, matched: 0, targetChecksum: "" };
      for (;;) {
        pageResult = { inserted: 0, updated: 0, matched: 0, targetChecksum: "" };
        const connection = await tracked(options, `${plan.table}:target_connection:${state.pageNumber + 1}`, () => target.getConnection());
        try {
          await tracked(options, `${plan.table}:target_comparison:${state.pageNumber + 1}`, async () => {
            await connection.beginTransaction();
            if (options.apply) {
              for (const row of rows) {
                const result = await applyRow(connection, plan, targetMeta, row, targetPolicy);
                pageResult[result] += 1;
              }
              pageResult.targetChecksum = await verifyPage(connection, plan, targetMeta, rows, targetPolicy);
            } else {
              for (const row of rows) {
                const existing = await findExisting(connection, plan, row, targetMeta, plan.naturalKeys ?? [], targetPolicy);
                if (!existing) pageResult.inserted += 1;
                else if (sameRow(row, existing, targetMeta.columns.filter((column) => !targetMeta.generatedColumns.includes(column))) && !existing[TARGET_TIMESTAMP_REPAIR]) pageResult.matched += 1;
                else if (plan.mode === "immutable") throw new DivergenceError({ table: plan.table, key: keyText(row, targetMeta.primaryKey), sourceChecksum: checksumRow(row, targetMeta.columns), targetChecksum: checksumRow(existing, targetMeta.columns), context: { dryRun: true } });
                else pageResult.updated += 1;
              }
              pageResult.targetChecksum = checksumRows(rows, targetMeta.columns.filter((column) => !targetMeta.generatedColumns.includes(column)));
            }
            await connection.commit();
          });
          break;
        } catch (error) {
          await connection.rollback().catch(() => undefined);
          const nextRetry = nextRetryAttempt(retry, options.maxRetries);
          if (error instanceof DivergenceError || nextRetry === null) {
            const writable = sourceMeta.columns.filter((column) => !sourceMeta.generatedColumns.includes(column));
            await store.writeManifest({
              passId, family: plan.family, table: plan.table, pageNumber: state.pageNumber + 1,
              lowerCursor: cursor, upperWatermark: upper,
              firstKey: keyText(page.firstRawRow!, sourceMeta.primaryKey), lastKey: keyText(page.cursorRow!, sourceMeta.primaryKey),
              sourceRowCount: page.rawSourceRowCount, insertedCount: 0, updatedCount: 0, matchedCount: 0, deletedCount: 0,
              sourceChecksum: checksumRows(rows, writable), targetVerificationChecksum: "",
              durationMs: Date.now() - pageStarted, retryCount: retry, status: "failed",
              normalizedTimestampCounts,
              sourceTimeWatermark: sourceTimeWatermark ?? undefined,
              skippedEphemeralStaleLockCount: skippedEvidence.length,
              skippedEphemeralStaleLockCountsBySlug: skippedCountsBySlug,
              skippedEphemeralStaleLocks: skippedEvidence,
              error: redactSecrets(error instanceof Error ? error.message : "unknown_error"),
            });
            throw error;
          }
          retry = nextRetry;
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs(retry - 1)));
          options.progress?.throwIfStalled(`${plan.table}:retry:${retry}`);
        } finally {
          connection.release();
        }
      }

      const writable = sourceMeta.columns.filter((column) => !sourceMeta.generatedColumns.includes(column));
      const manifest: PageManifest = {
        passId, family: plan.family, table: plan.table, pageNumber: state.pageNumber + 1,
        lowerCursor: cursor, upperWatermark: upper,
        firstKey: keyText(page.firstRawRow!, sourceMeta.primaryKey), lastKey: keyText(page.cursorRow!, sourceMeta.primaryKey),
        sourceRowCount: page.rawSourceRowCount, insertedCount: pageResult.inserted, updatedCount: pageResult.updated,
        matchedCount: pageResult.matched, deletedCount: 0,
        sourceChecksum: checksumRows(rows, writable), targetVerificationChecksum: pageResult.targetChecksum,
        durationMs: Date.now() - pageStarted, retryCount: retry, status: "completed",
        normalizedTimestampCounts,
        sourceTimeWatermark: sourceTimeWatermark ?? undefined,
        skippedEphemeralStaleLockCount: skippedEvidence.length,
        skippedEphemeralStaleLockCountsBySlug: skippedCountsBySlug,
        skippedEphemeralStaleLocks: skippedEvidence,
      };
      await store.writeManifest(manifest);
      cursor = next;
      sourceRows += page.rawSourceRowCount; skippedEphemeralStaleLocks += skippedEvidence.length; inserted += pageResult.inserted; updated += pageResult.updated; matched += pageResult.matched;
      if (collectTouchedKeys) for (const row of rows) touchedKeys.add(String(row[sourceMeta.primaryKey[0]]));
      state = {
        ...state, cursor, pageNumber: manifest.pageNumber,
        pageCounts: { completed: state.pageCounts.completed + 1, failed: state.pageCounts.failed, rows: state.pageCounts.rows + rows.length },
        latestManifestChecksum: checksumRow(manifest as unknown as DbRow, Object.keys(manifest)),
        // Cursor-driven parents are selected by their bounded cursor range.
        // Non-cursor parents collect keys in one Set and serialize only once at completion.
        touchedKeys: collectTouchedKeys ? state.touchedKeys : undefined,
      };
      // Cursor advances only after the target transaction, target verification,
      // and durable page manifest have all completed.
      await store.write(plan.table, state);
      options.progress?.activity();
      await options.progress?.emit("page_completed", {
        family: plan.family, table: plan.table, pageNumber: manifest.pageNumber,
        rowsRead: page.rawSourceRowCount, inserted: pageResult.inserted, updated: pageResult.updated,
        matched: pageResult.matched, deleted, cursorBefore: manifest.lowerCursor, cursorAfter: next,
      });
    }

    const runStatuses = RUN_NONTERMINAL_STATUSES[plan.table];
    if (runStatuses) {
      const rescanned = await tracked(options, `${plan.table}:nonterminal_rescan`, () => rescanRunRows(source, target, plan, targetMeta, runStatuses, options));
      inserted += rescanned.inserted; updated += rescanned.updated; matched += rescanned.matched; sourceRows += rescanned.rows;
      if (collectTouchedKeys) for (const id of rescanned.ids) touchedKeys.add(id);
    }
    const reconciliation = await tracked(options, `${plan.table}:reconciliation`, () => reconcileTable(source, target, plan, sourceMeta, skippedEphemeralStaleLocks));
    state = { ...state, status: "completed", cursor: upper, upperWatermark: null, completedAt: new Date().toISOString(), error: null, touchedKeys: collectTouchedKeys ? [...touchedKeys] : undefined };
    await store.write(plan.table, state);
    options.progress?.activity();
    const lagSeconds = plan.cursorColumn ? Math.max(0, (Date.now() - new Date(normalizeTimestamp(upper.timestamp, { family: plan.family, table: plan.table, column: plan.cursorColumn, operation: "table lag calculation", nullable: false })!).getTime()) / 1000) : null;
    const report = {
      passId, family: plan.family, table: plan.table, mode: options.apply ? "apply" : "dry-run", status: "completed",
      pages: state.pageNumber, sourceRows, inserted, updated, matched, deleted, plannedDeleted,
      deletionRequired: options.apply && plannedDeleted > deleted,
      lagSeconds, reconciliation, sourceTimeWatermark, skippedEphemeralStaleLocks,
    } as TableReport;
    await options.progress?.emit("table_completed", { family: plan.family, table: plan.table, pageNumber: state.pageNumber, rowsRead: sourceRows, inserted, updated, matched, deleted, cursorAfter: state.cursor });
    return report;
  } catch (error) {
    state = { ...state, status: "failed", error: redactSecrets(error instanceof Error ? error.message : "unknown_error"), pageCounts: { ...state.pageCounts, failed: state.pageCounts.failed + 1 } };
    await store.write(plan.table, state);
    options.progress?.activity();
    await options.progress?.emit("failed", { family: plan.family, table: plan.table, pageNumber: state.pageNumber, cursorAfter: state.cursor, error: state.error ?? "unknown_error" });
    throw error;
  }
}

async function rescanRunRows(source: SourceReader, target: Pool, plan: TablePlan, metadata: TableMetadata, statuses: string[], options: SyncOptions): Promise<{ rows: number; inserted: number; updated: number; matched: number; ids: string[] }> {
  const placeholders = statuses.map(() => "?").join(",");
  const [[sourceIds], [targetIds]] = await Promise.all([
    source.query<RowDataPacket[]>(`SELECT id FROM ${q(plan.table)} WHERE status IN (${placeholders})`, statuses),
    target.query<RowDataPacket[]>(`SELECT id FROM ${q(plan.table)} WHERE status IN (${placeholders})`, statuses),
  ]);
  const ids = [...new Set([...sourceIds, ...targetIds].map((row) => String(row.id)))];
  let inserted = 0, updated = 0, matched = 0, rowsSeen = 0;
  for (let offset = 0; offset < ids.length; offset += options.pageSize) {
    const pageIds = ids.slice(offset, offset + options.pageSize);
    const [rawRows] = await source.query<RowDataPacket[]>(`SELECT * FROM ${q(plan.table)} WHERE id IN (${pageIds.map(() => "?").join(",")}) ORDER BY created_at,id`, pageIds);
    const rows = rawRows.map((row) => normalizeTimestampRow(row as DbRow, metadata, plan, "source nonterminal-run rescan"));
    if (rows.length !== pageIds.length) throw new Error(`Target-only ${plan.table} run detected while source remains authoritative`);
    const connection = await target.getConnection();
    try {
      await connection.beginTransaction();
      for (const row of rows) {
        if (!options.apply) { matched += 1; continue; }
        const result = await applyRow(connection, plan, metadata, row as DbRow);
        if (result === "inserted") inserted += 1; else if (result === "updated") updated += 1; else matched += 1;
      }
      if (options.apply) await verifyPage(connection, plan, metadata, rows as DbRow[]);
      await connection.commit(); rowsSeen += rows.length;
    } catch (error) { await connection.rollback().catch(() => undefined); throw error; }
    finally { connection.release(); }
  }
  return { rows: rowsSeen, inserted, updated, matched, ids };
}

async function reconcileDeletes(source: SourceReader, target: Pool, plan: TablePlan, metadata: TableMetadata, pageSize: number, sourceTimeWatermark: string, executeDeletes: boolean): Promise<{ planned: number; deleted: number }> {
  if (plan.table !== "workflow_locks") throw new Error(`Delete reconciliation is not allowlisted for ${plan.table}`);
  const primary = metadata.primaryKey[0];
  const sourceIds = new Set<string>();
  const sourcePrimary = `wl.${q(primary)}`;
  const sourceExpression = `SHA2(COALESCE(CAST(${sourcePrimary} AS CHAR), ''), 256)`;
  const targetExpression = `SHA2(COALESCE(CAST(wl.${q(primary)} AS CHAR), ''), 256)`;
  let sourceAfterHash = "", sourceAfterId = "";
  for (;;) {
    const [sourceRows] = await source.query<RowDataPacket[]>(
      `SELECT ${sourcePrimary} AS id, wl.workflow_definition_id,
              CAST(wl.locked_at AS CHAR) AS locked_at,
              CAST(wl.expires_at AS CHAR) AS expires_at,
              CAST(wl.released_at AS CHAR) AS released_at,
              wd.slug AS workflow_slug, ${sourceExpression} AS h
         FROM ${q(plan.table)} wl
        LEFT JOIN workflow_definitions wd ON wd.id=wl.workflow_definition_id
        WHERE (${sourceExpression} > ? OR (${sourceExpression} = ? AND ${sourcePrimary} > ?))
        ORDER BY h, ${sourcePrimary} LIMIT ?`,
      [sourceAfterHash, sourceAfterHash, sourceAfterId, pageSize]
    );
    if (!sourceRows.length) break;
    for (const sourceRow of sourceRows) {
      if (isMariaDbZeroDate(sourceRow.locked_at)) {
        const slug = sourceRow.workflow_slug == null ? null : String(sourceRow.workflow_slug);
        if (!slug) throw new Error(`Cannot reconcile source workflow_locks zero-date lock ${String(sourceRow.id)}: missing workflow definition mapping`);
        if (classifyWorkflowLockRow(sourceRow as DbRow, slug, sourceTimeWatermark).action === "skip") continue;
      }
      sourceIds.add(String(sourceRow.id));
    }
    const previous = [sourceAfterHash, sourceAfterId] as const;
    sourceAfterHash = String(sourceRows.at(-1)!.h); sourceAfterId = String(sourceRows.at(-1)!.id);
    assertTupleProgress("workflow_locks source delete reconciliation", previous, [sourceAfterHash, sourceAfterId], sourceRows.length);
  }
  const staleIds: string[] = [];
  let afterHash = "", afterId = "";
  for (;;) {
    const [targetRows] = await target.query<RowDataPacket[]>(
      `SELECT wl.id, wl.workflow_definition_id,
              CAST(wl.locked_at AS CHAR) AS locked_at,
              CAST(wl.expires_at AS CHAR) AS expires_at,
              CAST(wl.released_at AS CHAR) AS released_at,
              wd.slug AS workflow_slug, ${targetExpression} AS h
         FROM ${q(plan.table)} wl
        LEFT JOIN workflow_definitions wd ON wd.id=wl.workflow_definition_id
        WHERE (${targetExpression} > ? OR (${targetExpression} = ? AND wl.${q(primary)} > ?))
        ORDER BY h, wl.${q(primary)} LIMIT ?`,
      [afterHash, afterHash, afterId, pageSize]
    );
    if (!targetRows.length) break;
    for (const targetRow of targetRows) {
      const id = String(targetRow.id);
      let historicalStale = false;
      if (isMariaDbZeroDate(targetRow.locked_at)) {
        const slug = targetRow.workflow_slug == null ? null : String(targetRow.workflow_slug);
        if (!slug) throw new Error(`Cannot reconcile target workflow_locks zero-date lock ${id}: missing workflow definition mapping`);
        historicalStale = classifyWorkflowLockRow(targetRow as DbRow, slug, sourceTimeWatermark).action === "skip";
      }
      if (historicalStale || !sourceIds.has(id)) staleIds.push(id);
    }
    const previous = [afterHash, afterId] as const;
    afterHash = String(targetRows[targetRows.length - 1].h);
    afterId = String(targetRows[targetRows.length - 1].id);
    assertTupleProgress("workflow_locks target delete reconciliation", previous, [afterHash, afterId], targetRows.length);
  }
  let deleted = 0;
  if (executeDeletes) {
    for (let offset = 0; offset < staleIds.length; offset += pageSize) {
      const stale = staleIds.slice(offset, offset + pageSize);
      const connection = await target.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(`DELETE FROM ${q(plan.table)} WHERE ${q(primary)} IN (${stale.map(() => "?").join(",")})`, stale);
        await connection.commit();
        deleted += stale.length;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      } finally { connection.release(); }
    }
  }
  return { planned: staleIds.length, deleted };
}

export async function reconcileTable(source: SourceReader, target: Pool, plan: TablePlan, metadata?: TableMetadata, skippedSourceRows = 0): Promise<ReconciliationReport> {
  const meta = metadata ?? await readMetadata(source, plan.table);
  const primary = meta.primaryKey[0];
  const cursor = plan.cursorColumn;
  const aggregate = cursor ? `COUNT(*) AS c, MIN(${q(cursor)}) AS min_v, MAX(${q(cursor)}) AS max_v` : `COUNT(*) AS c, MIN(${q(primary)}) AS min_v, MAX(${q(primary)}) AS max_v`;
  const [[sourceRows], [targetRows]] = await Promise.all([
    source.query<RowDataPacket[]>(`SELECT ${aggregate} FROM ${q(plan.table)}`),
    target.query<RowDataPacket[]>(`SELECT ${aggregate} FROM ${q(plan.table)}`),
  ]);
  const rawSourceCount = Number(sourceRows[0].c), sourceCount = rawSourceCount - skippedSourceRows, targetCount = Number(targetRows[0].c);
  if (sourceCount < 0) throw new Error(`Invalid reconciliation skip count for ${plan.table}`);
  let hourlyBucketsMatch: boolean | null = null;
  if (cursor) {
    const sql = `SELECT DATE_FORMAT(${q(cursor)}, '%Y-%m-%d %H:00:00') AS bucket, COUNT(*) AS c, MIN(${q(cursor)}) AS min_v, MAX(${q(cursor)}) AS max_v FROM ${q(plan.table)} GROUP BY bucket ORDER BY bucket`;
    const [[a], [b]] = await Promise.all([source.query<RowDataPacket[]>(sql), target.query<RowDataPacket[]>(sql)]);
    const normalizeBuckets = (rows: RowDataPacket[], side: "source" | "target"): DbRow[] => rows.map((row) => ({
      ...row,
      bucket: normalizeTimestamp(row.bucket, { family: plan.family, table: plan.table, column: cursor, operation: `${side} hourly bucket normalization`, nullable: false }),
      min_v: normalizeTimestamp(row.min_v, { family: plan.family, table: plan.table, column: cursor, operation: `${side} hourly minimum normalization`, nullable: false }),
      max_v: normalizeTimestamp(row.max_v, { family: plan.family, table: plan.table, column: cursor, operation: `${side} hourly maximum normalization`, nullable: false }),
    }));
    hourlyBucketsMatch = canonicalRow({ rows: normalizeBuckets(a, "source") }, ["rows"]) === canonicalRow({ rows: normalizeBuckets(b, "target") }, ["rows"]);
  }
  const checks = [sourceCount === targetCount ? "count_match" : "count_mismatch"];
  if (skippedSourceRows > 0) checks.push(`excluded_${skippedSourceRows}_classified_ephemeral_stale_locks`);
  if (hourlyBucketsMatch !== null) checks.push(hourlyBucketsMatch ? "hourly_buckets_match" : "hourly_buckets_mismatch");
  if (targetCount > sourceCount) checks.push("possible_target_only_keys");
  return {
    sourceCount, targetCount,
    sourceMin: cursor ? normalizeTimestamp(sourceRows[0].min_v, { family: plan.family, table: plan.table, column: cursor, operation: "source reconciliation minimum", nullable: sourceCount === 0 }) : sourceRows[0].min_v == null ? null : String(sourceRows[0].min_v),
    sourceMax: cursor ? normalizeTimestamp(sourceRows[0].max_v, { family: plan.family, table: plan.table, column: cursor, operation: "source reconciliation maximum", nullable: sourceCount === 0 }) : sourceRows[0].max_v == null ? null : String(sourceRows[0].max_v),
    targetMin: cursor ? normalizeTimestamp(targetRows[0].min_v, { family: plan.family, table: plan.table, column: cursor, operation: "target reconciliation minimum", nullable: targetCount === 0 }) : targetRows[0].min_v == null ? null : String(targetRows[0].min_v),
    targetMax: cursor ? normalizeTimestamp(targetRows[0].max_v, { family: plan.family, table: plan.table, column: cursor, operation: "target reconciliation maximum", nullable: targetCount === 0 }) : targetRows[0].max_v == null ? null : String(targetRows[0].max_v),
    hourlyBucketsMatch, sourceOnlyKeys: sourceCount === targetCount ? 0 : null,
    targetOnlyKeys: targetCount > sourceCount ? targetCount - sourceCount : 0,
    orphanCount: 0, checks,
    passed: sourceCount === targetCount && hourlyBucketsMatch !== false,
  };
}
