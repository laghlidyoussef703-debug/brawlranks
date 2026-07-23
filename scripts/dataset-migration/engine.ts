import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { canonicalRow, checksumRow, checksumRows, DivergenceError, type DbRow } from "./canonical";
import { pagePredicate, TABLE_PLANS, type CompositeCursor, type TablePlan } from "./model";
import { FileStateStore, type PageManifest, type SyncState } from "./state";
import { redactSecrets } from "./config";

export interface TableMetadata {
  columns: string[];
  generatedColumns: string[];
  primaryKey: string[];
  uniqueKeys: string[][];
  timestampColumns: string[];
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
  lagSeconds: number | null;
  reconciliation: ReconciliationReport;
  error?: string;
}

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

export async function readMetadata(pool: Pool, table: string): Promise<TableMetadata> {
  const [columns] = await pool.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME, EXTRA, DATA_TYPE
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
  };
}

async function databaseName(pool: Pool): Promise<string> {
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

function startWithOverlap(cursor: CompositeCursor | null, seconds: number, isTime: boolean): CompositeCursor | null {
  if (!cursor) return null;
  if (!isTime) return null; // full/hash scans intentionally restart for exact reconciliation
  const date = new Date(cursor.timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return { timestamp: new Date(date.getTime() - seconds * 1000).toISOString(), id: "" };
}

function formatCursor(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function hashExpression(primary: string): string {
  return `SHA2(COALESCE(CAST(${q(primary)} AS CHAR), ''), 256)`;
}

async function upperWatermark(source: Pool, plan: TablePlan, metadata: TableMetadata): Promise<CompositeCursor | null> {
  const primary = metadata.primaryKey[0];
  if (!primary) throw new Error(`${plan.table} has no primary key`);
  if (plan.cursorColumn) {
    const [rows] = await source.query<RowDataPacket[]>(
      `SELECT ${q(plan.cursorColumn)} AS cursor_value, ${q(primary)} AS cursor_id FROM ${q(plan.table)} ORDER BY ${q(plan.cursorColumn)} DESC, ${q(primary)} DESC LIMIT 1`
    );
    return rows.length ? { timestamp: formatCursor(rows[0].cursor_value), id: String(rows[0].cursor_id) } : null;
  }
  const expression = hashExpression(primary);
  const [rows] = await source.query<RowDataPacket[]>(
    `SELECT ${expression} AS cursor_value, ${q(primary)} AS cursor_id FROM ${q(plan.table)} ORDER BY cursor_value DESC, ${q(primary)} DESC LIMIT 1`
  );
  return rows.length ? { timestamp: String(rows[0].cursor_value), id: String(rows[0].cursor_id) } : null;
}

async function readPage(
  source: Pool,
  plan: TablePlan,
  metadata: TableMetadata,
  lower: CompositeCursor | null,
  upper: CompositeCursor,
  limit: number,
  parentState: SyncState | null
): Promise<DbRow[]> {
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
  return rows as DbRow[];
}

function nextCursor(row: DbRow, plan: TablePlan, metadata: TableMetadata): CompositeCursor {
  const primary = metadata.primaryKey[0];
  if (plan.cursorColumn) return { timestamp: formatCursor(row[plan.cursorColumn]), id: String(row[primary]) };
  const hash = checksumRow({ value: row[primary] }, ["value"]);
  // SQL hashes CAST(pk AS CHAR), while this hash includes JSON framing. Re-querying
  // with a mismatched cursor would be unsafe, so hash pages compute the SQL value explicitly below.
  return { timestamp: hash, id: String(row[primary]) };
}

async function nextCursorFromSource(source: Pool, plan: TablePlan, metadata: TableMetadata, row: DbRow): Promise<CompositeCursor> {
  if (plan.cursorColumn) return nextCursor(row, plan, metadata);
  const primary = metadata.primaryKey[0];
  const [rows] = await source.query<RowDataPacket[]>(`SELECT ${hashExpression(primary)} AS h FROM ${q(plan.table)} WHERE ${q(primary)} = ?`, [row[primary]]);
  return { timestamp: String(rows[0].h), id: String(row[primary]) };
}

function sameRow(source: DbRow, target: DbRow, columns: string[]): boolean {
  return canonicalRow(source, columns) === canonicalRow(target, columns);
}

async function findExisting(connection: PoolConnection, table: string, row: DbRow, metadata: TableMetadata, naturalKeys: string[][]): Promise<DbRow | null> {
  const keys = [metadata.primaryKey, ...naturalKeys, ...metadata.uniqueKeys].filter((key) => key.length > 0 && key.every((column) => row[column] !== null && row[column] !== undefined));
  for (const key of keys) {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT * FROM ${q(table)} WHERE ${key.map((column) => `${q(column)} <=> ?`).join(" AND ")} LIMIT 1`,
      key.map((column) => row[column])
    );
    if (rows.length > 0) return rows[0] as DbRow;
  }
  return null;
}

async function applyRow(connection: PoolConnection, plan: TablePlan, metadata: TableMetadata, row: DbRow): Promise<"inserted" | "updated" | "matched"> {
  if (plan.parent) {
    const [parentRows] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM ${q(plan.parent.table)} WHERE id = ? LIMIT 1`,
      [row[plan.parent.foreignKey]]
    );
    if (parentRows.length === 0) throw new Error(`Dependency violation: ${plan.parent.table} must be synchronized before ${plan.table}`);
  }
  const writable = metadata.columns.filter((column) => !metadata.generatedColumns.includes(column));
  const comparable = plan.table === "published_snapshots" ? writable.filter((column) => column !== "is_current") : writable;
  const existing = await findExisting(connection, plan.table, row, metadata, plan.naturalKeys ?? []);
  if (existing) {
    const sourcePk = keyText(row, metadata.primaryKey);
    const targetPk = keyText(existing, metadata.primaryKey);
    if (sourcePk !== targetPk) {
      throw new DivergenceError({ table: plan.table, key: sourcePk, sourceChecksum: checksumRow(row, writable), targetChecksum: checksumRow(existing, writable), context: { reason: "natural_key_maps_to_different_primary_key" } });
    }
    if (sameRow(row, existing, comparable)) return "matched";
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
      [...mutable.map((column) => row[column]), ...metadata.primaryKey.map((column) => row[column])]
    );
    return "updated";
  }
  await connection.query(
    `INSERT INTO ${q(plan.table)} (${writable.map(q).join(", ")}) VALUES (${writable.map(() => "?").join(", ")})`,
    writable.map((column) => plan.table === "published_snapshots" && column === "is_current" ? 0 : row[column])
  );
  return "inserted";
}

async function verifyPage(target: PoolConnection, plan: TablePlan, metadata: TableMetadata, rows: DbRow[]): Promise<string> {
  const writable = metadata.columns.filter((column) => !metadata.generatedColumns.includes(column));
  const comparable = plan.table === "published_snapshots" ? writable.filter((column) => column !== "is_current") : writable;
  const verified: DbRow[] = [];
  for (const sourceRow of rows) {
    const targetRow = await findExisting(target, plan.table, sourceRow, metadata, plan.naturalKeys ?? []);
    if (!targetRow || !sameRow(sourceRow, targetRow, comparable)) {
      throw new Error(`Target verification failed for ${plan.table} ${keyText(sourceRow, metadata.primaryKey)}`);
    }
    verified.push(targetRow);
  }
  return checksumRows(verified, comparable);
}

function initialState(plan: TablePlan, options: SyncOptions, passId: string, cursor: CompositeCursor | null, upper: CompositeCursor | null): SyncState {
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
    error: null,
    touchedKeys: [],
  };
}

export async function syncTable(source: Pool, target: Pool, store: FileStateStore, plan: TablePlan, options: SyncOptions): Promise<TableReport> {
  const sourceMeta = await readMetadata(source, plan.table);
  const targetMeta = await readMetadata(target, plan.table);
  assertSchemaCompatible(sourceMeta, targetMeta, plan.table);
  const previous = await store.read(plan.table);
  if (previous && (previous.sourceIdentity !== options.sourceIdentity || previous.targetIdentity !== options.targetIdentity)) throw new Error(`Durable state identity mismatch for ${plan.table}`);

  const resume = previous?.status === "running" || previous?.status === "failed";
  const passId = options.passId ?? (resume ? previous!.passId : randomUUID());
  const isTimeCursor = Boolean(plan.cursorColumn);
  const overlap = resume ? previous!.overlapStart : startWithOverlap(previous?.cursor ?? null, options.overlapSeconds, isTimeCursor);
  const upper = resume ? previous!.upperWatermark : await upperWatermark(source, plan, sourceMeta);
  let state = resume ? { ...previous!, status: "running" as const, error: null } : initialState(plan, options, passId, overlap, upper);
  await store.write(plan.table, state);

  let inserted = 0, updated = 0, matched = 0, deleted = 0, sourceRows = 0;
  if (!upper) {
    state = { ...state, status: "completed", completedAt: new Date().toISOString() };
    await store.write(plan.table, state);
    return { passId, family: plan.family, table: plan.table, mode: options.apply ? "apply" : "dry-run", status: "completed", pages: 0, sourceRows: 0, inserted: 0, updated: 0, matched: 0, deleted: 0, lagSeconds: 0, reconciliation: await reconcileTable(source, target, plan, sourceMeta) };
  }

  let cursor = state.cursor;
  const parentState = plan.parent ? await store.read(plan.parent.table) : null;
  try {
    // Ephemeral active-lock uniqueness can otherwise block insertion of the
    // authoritative source lock. This pre-delete is opt-in and allowlisted to
    // workflow_locks only; it occurs in bounded target transactions.
    if (plan.deleteTargetOnly && options.apply && options.allowReconcileDelete) {
      deleted = await reconcileDeletes(source, target, plan, sourceMeta, options.pageSize);
    }
    for (;;) {
      const pageStarted = Date.now();
      const rows = await readPage(source, plan, sourceMeta, cursor, upper, options.pageSize, parentState);
      if (rows.length === 0) break;
      const next = await nextCursorFromSource(source, plan, sourceMeta, rows[rows.length - 1]);
      let retry = 0;
      let pageResult = { inserted: 0, updated: 0, matched: 0, targetChecksum: "" };
      for (;;) {
        const connection = await target.getConnection();
        try {
          await connection.beginTransaction();
          if (options.apply) {
            for (const row of rows) {
              const result = await applyRow(connection, plan, targetMeta, row);
              pageResult[result] += 1;
            }
            pageResult.targetChecksum = await verifyPage(connection, plan, targetMeta, rows);
          } else {
            for (const row of rows) {
              const existing = await findExisting(connection, plan.table, row, targetMeta, plan.naturalKeys ?? []);
              if (!existing) pageResult.inserted += 1;
              else if (sameRow(row, existing, targetMeta.columns.filter((column) => !targetMeta.generatedColumns.includes(column)))) pageResult.matched += 1;
              else if (plan.mode === "immutable") throw new DivergenceError({ table: plan.table, key: keyText(row, targetMeta.primaryKey), sourceChecksum: checksumRow(row, targetMeta.columns), targetChecksum: checksumRow(existing, targetMeta.columns), context: { dryRun: true } });
              else pageResult.updated += 1;
            }
            pageResult.targetChecksum = checksumRows(rows, targetMeta.columns.filter((column) => !targetMeta.generatedColumns.includes(column)));
          }
          await connection.commit();
          break;
        } catch (error) {
          await connection.rollback().catch(() => undefined);
          if (error instanceof DivergenceError || retry >= options.maxRetries) {
            const writable = sourceMeta.columns.filter((column) => !sourceMeta.generatedColumns.includes(column));
            await store.writeManifest({
              passId, family: plan.family, table: plan.table, pageNumber: state.pageNumber + 1,
              lowerCursor: cursor, upperWatermark: upper,
              firstKey: keyText(rows[0], sourceMeta.primaryKey), lastKey: keyText(rows[rows.length - 1], sourceMeta.primaryKey),
              sourceRowCount: rows.length, insertedCount: 0, updatedCount: 0, matchedCount: 0, deletedCount: 0,
              sourceChecksum: checksumRows(rows, writable), targetVerificationChecksum: "",
              durationMs: Date.now() - pageStarted, retryCount: retry, status: "failed",
              error: redactSecrets(error instanceof Error ? error.message : "unknown_error"),
            });
            throw error;
          }
          retry += 1;
        } finally {
          connection.release();
        }
      }

      const writable = sourceMeta.columns.filter((column) => !sourceMeta.generatedColumns.includes(column));
      const manifest: PageManifest = {
        passId, family: plan.family, table: plan.table, pageNumber: state.pageNumber + 1,
        lowerCursor: cursor, upperWatermark: upper,
        firstKey: keyText(rows[0], sourceMeta.primaryKey), lastKey: keyText(rows[rows.length - 1], sourceMeta.primaryKey),
        sourceRowCount: rows.length, insertedCount: pageResult.inserted, updatedCount: pageResult.updated,
        matchedCount: pageResult.matched, deletedCount: 0,
        sourceChecksum: checksumRows(rows, writable), targetVerificationChecksum: pageResult.targetChecksum,
        durationMs: Date.now() - pageStarted, retryCount: retry, status: "completed",
      };
      await store.writeManifest(manifest);
      cursor = next;
      sourceRows += rows.length; inserted += pageResult.inserted; updated += pageResult.updated; matched += pageResult.matched;
      state = {
        ...state, cursor, pageNumber: manifest.pageNumber,
        pageCounts: { completed: state.pageCounts.completed + 1, failed: state.pageCounts.failed, rows: state.pageCounts.rows + rows.length },
        latestManifestChecksum: checksumRow(manifest as unknown as DbRow, Object.keys(manifest)),
        touchedKeys: PARENT_TABLES.has(plan.table)
          ? [...new Set([...(state.touchedKeys ?? []), ...rows.map((row) => String(row[sourceMeta.primaryKey[0]]))])]
          : state.touchedKeys,
      };
      // Cursor advances only after the target transaction, target verification,
      // and durable page manifest have all completed.
      await store.write(plan.table, state);
    }

    const runStatuses = RUN_NONTERMINAL_STATUSES[plan.table];
    if (runStatuses) {
      const rescanned = await rescanRunRows(source, target, plan, targetMeta, runStatuses, options);
      inserted += rescanned.inserted; updated += rescanned.updated; matched += rescanned.matched; sourceRows += rescanned.rows;
      state = { ...state, touchedKeys: [...new Set([...(state.touchedKeys ?? []), ...rescanned.ids])] };
    }
    const reconciliation = await reconcileTable(source, target, plan, sourceMeta);
    state = { ...state, status: "completed", cursor: upper, upperWatermark: null, completedAt: new Date().toISOString(), error: null };
    await store.write(plan.table, state);
    const lagSeconds = plan.cursorColumn ? Math.max(0, (Date.now() - new Date(upper.timestamp).getTime()) / 1000) : null;
    return { passId, family: plan.family, table: plan.table, mode: options.apply ? "apply" : "dry-run", status: "completed", pages: state.pageNumber, sourceRows, inserted, updated, matched, deleted, lagSeconds, reconciliation };
  } catch (error) {
    state = { ...state, status: "failed", error: redactSecrets(error instanceof Error ? error.message : "unknown_error"), pageCounts: { ...state.pageCounts, failed: state.pageCounts.failed + 1 } };
    await store.write(plan.table, state);
    throw error;
  }
}

async function rescanRunRows(source: Pool, target: Pool, plan: TablePlan, metadata: TableMetadata, statuses: string[], options: SyncOptions): Promise<{ rows: number; inserted: number; updated: number; matched: number; ids: string[] }> {
  const placeholders = statuses.map(() => "?").join(",");
  const [[sourceIds], [targetIds]] = await Promise.all([
    source.query<RowDataPacket[]>(`SELECT id FROM ${q(plan.table)} WHERE status IN (${placeholders})`, statuses),
    target.query<RowDataPacket[]>(`SELECT id FROM ${q(plan.table)} WHERE status IN (${placeholders})`, statuses),
  ]);
  const ids = [...new Set([...sourceIds, ...targetIds].map((row) => String(row.id)))];
  let inserted = 0, updated = 0, matched = 0, rowsSeen = 0;
  for (let offset = 0; offset < ids.length; offset += options.pageSize) {
    const pageIds = ids.slice(offset, offset + options.pageSize);
    const [rows] = await source.query<RowDataPacket[]>(`SELECT * FROM ${q(plan.table)} WHERE id IN (${pageIds.map(() => "?").join(",")}) ORDER BY created_at,id`, pageIds);
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

async function reconcileDeletes(source: Pool, target: Pool, plan: TablePlan, metadata: TableMetadata, pageSize: number): Promise<number> {
  if (plan.table !== "workflow_locks") throw new Error(`Delete reconciliation is not allowlisted for ${plan.table}`);
  const primary = metadata.primaryKey[0];
  const sourceIds = new Set<string>();
  const expression = hashExpression(primary);
  let sourceAfterHash = "", sourceAfterId = "";
  for (;;) {
    const [sourceRows] = await source.query<RowDataPacket[]>(
      `SELECT ${q(primary)} AS id, ${expression} AS h FROM ${q(plan.table)}
        WHERE (${expression} > ? OR (${expression} = ? AND ${q(primary)} > ?))
        ORDER BY h, ${q(primary)} LIMIT ?`,
      [sourceAfterHash, sourceAfterHash, sourceAfterId, pageSize]
    );
    if (!sourceRows.length) break;
    for (const row of sourceRows) sourceIds.add(String(row.id));
    sourceAfterHash = String(sourceRows.at(-1)!.h); sourceAfterId = String(sourceRows.at(-1)!.id);
  }
  let deleted = 0;
  let afterHash = "", afterId = "";
  for (;;) {
    const [targetRows] = await target.query<RowDataPacket[]>(
      `SELECT ${q(primary)} AS id, ${expression} AS h FROM ${q(plan.table)}
        WHERE (${expression} > ? OR (${expression} = ? AND ${q(primary)} > ?))
        ORDER BY h, ${q(primary)} LIMIT ?`,
      [afterHash, afterHash, afterId, pageSize]
    );
    if (!targetRows.length) break;
    const stale = targetRows.map((row) => String(row.id)).filter((id) => !sourceIds.has(id));
    if (stale.length) {
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
    afterHash = String(targetRows[targetRows.length - 1].h);
    afterId = String(targetRows[targetRows.length - 1].id);
  }
  return deleted;
}

export async function reconcileTable(source: Pool, target: Pool, plan: TablePlan, metadata?: TableMetadata): Promise<ReconciliationReport> {
  const meta = metadata ?? await readMetadata(source, plan.table);
  const primary = meta.primaryKey[0];
  const cursor = plan.cursorColumn;
  const aggregate = cursor ? `COUNT(*) AS c, MIN(${q(cursor)}) AS min_v, MAX(${q(cursor)}) AS max_v` : `COUNT(*) AS c, MIN(${q(primary)}) AS min_v, MAX(${q(primary)}) AS max_v`;
  const [[sourceRows], [targetRows]] = await Promise.all([
    source.query<RowDataPacket[]>(`SELECT ${aggregate} FROM ${q(plan.table)}`),
    target.query<RowDataPacket[]>(`SELECT ${aggregate} FROM ${q(plan.table)}`),
  ]);
  const sourceCount = Number(sourceRows[0].c), targetCount = Number(targetRows[0].c);
  let hourlyBucketsMatch: boolean | null = null;
  if (cursor) {
    const sql = `SELECT DATE_FORMAT(${q(cursor)}, '%Y-%m-%d %H:00:00') AS bucket, COUNT(*) AS c, MIN(${q(cursor)}) AS min_v, MAX(${q(cursor)}) AS max_v FROM ${q(plan.table)} GROUP BY bucket ORDER BY bucket`;
    const [[a], [b]] = await Promise.all([source.query<RowDataPacket[]>(sql), target.query<RowDataPacket[]>(sql)]);
    hourlyBucketsMatch = canonicalRow({ rows: a }, ["rows"]) === canonicalRow({ rows: b }, ["rows"]);
  }
  const checks = [sourceCount === targetCount ? "count_match" : "count_mismatch"];
  if (hourlyBucketsMatch !== null) checks.push(hourlyBucketsMatch ? "hourly_buckets_match" : "hourly_buckets_mismatch");
  if (targetCount > sourceCount) checks.push("possible_target_only_keys");
  return {
    sourceCount, targetCount,
    sourceMin: sourceRows[0].min_v == null ? null : formatCursor(sourceRows[0].min_v),
    sourceMax: sourceRows[0].max_v == null ? null : formatCursor(sourceRows[0].max_v),
    targetMin: targetRows[0].min_v == null ? null : formatCursor(targetRows[0].min_v),
    targetMax: targetRows[0].max_v == null ? null : formatCursor(targetRows[0].max_v),
    hourlyBucketsMatch, sourceOnlyKeys: sourceCount === targetCount ? 0 : null,
    targetOnlyKeys: targetCount > sourceCount ? targetCount - sourceCount : 0,
    orphanCount: 0, checks,
    passed: sourceCount === targetCount && hourlyBucketsMatch !== false,
  };
}
