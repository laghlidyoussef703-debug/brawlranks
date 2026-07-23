import type { Pool, RowDataPacket } from "mysql2/promise";
import { canonicalRow } from "./canonical";
import { createHash } from "node:crypto";
import { TABLE_PLANS } from "./model";
import type { SourceReader } from "./source-reader";
import { readMetadata, type TableMetadata } from "./engine";
import { normalizeTimestamp, normalizeTimestampRow, timestampForTarget } from "./timestamp";
import type { DbRow } from "./canonical";
import { classifyWorkflowLockRow, isMariaDbZeroDate } from "./workflow-lock-normalization";
import { assertTupleProgress } from "./progress";

const q = (identifier: string): string => `\`${identifier.replace(/`/g, "``")}\``;

export interface KeyDiff {
  sourceOnly: number;
  targetOnly: number;
  samples: { sourceOnly: string[]; targetOnly: string[] };
}

async function keyPage(pool: Pick<Pool, "query">, table: string, key: string, after: string, limit: number): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${q(key)} AS k FROM ${q(table)} WHERE ${q(key)} > ? ORDER BY ${q(key)} LIMIT ?`,
    [after, limit]
  );
  return rows.map((row) => String(row.k));
}

/** Exact merge anti-join using bounded ordered key pages; it never loads a whole table. */
export async function antiJoinKeys(source: SourceReader, target: Pool, table: string, key: string, pageSize = 1000): Promise<KeyDiff> {
  let sourceAfter = "", targetAfter = "";
  let sourcePage: string[] = [], targetPage: string[] = [];
  let si = 0, ti = 0, sourceDone = false, targetDone = false;
  const result: KeyDiff = { sourceOnly: 0, targetOnly: 0, samples: { sourceOnly: [], targetOnly: [] } };
  for (;;) {
    if (si >= sourcePage.length && !sourceDone) {
      const previous = sourceAfter;
      sourcePage = await keyPage(source, table, key, sourceAfter, pageSize); si = 0;
      if (!sourcePage.length) sourceDone = true; else {
        sourceAfter = sourcePage[sourcePage.length - 1];
        assertTupleProgress(`${table} source anti-join`, [previous], [sourceAfter], sourcePage.length);
      }
    }
    if (ti >= targetPage.length && !targetDone) {
      const previous = targetAfter;
      targetPage = await keyPage(target, table, key, targetAfter, pageSize); ti = 0;
      if (!targetPage.length) targetDone = true; else {
        targetAfter = targetPage[targetPage.length - 1];
        assertTupleProgress(`${table} target anti-join`, [previous], [targetAfter], targetPage.length);
      }
    }
    const a = si < sourcePage.length ? sourcePage[si] : null;
    const b = ti < targetPage.length ? targetPage[ti] : null;
    if (a === null && b === null && sourceDone && targetDone) break;
    if (a !== null && b !== null && a === b) { si += 1; ti += 1; continue; }
    if (b === null || (a !== null && a < b)) {
      result.sourceOnly += 1; if (result.samples.sourceOnly.length < 10) result.samples.sourceOnly.push(a!); si += 1;
    } else {
      result.targetOnly += 1; if (result.samples.targetOnly.length < 10) result.samples.targetOnly.push(b); ti += 1;
    }
  }
  return result;
}

async function antiJoinWorkflowLocks(source: SourceReader, target: Pool, pageSize: number, watermark: string): Promise<KeyDiff> {
  type OrderedKey = { id: string; hash: string };
  let sourceAfterHash = "", sourceAfterId = "", targetAfterHash = "", targetAfterId = "";
  let sourcePage: OrderedKey[] = [], targetPage: OrderedKey[] = [];
  let si = 0, ti = 0, sourceDone = false, targetDone = false;
  const result: KeyDiff = { sourceOnly: 0, targetOnly: 0, samples: { sourceOnly: [], targetOnly: [] } };
  for (;;) {
    if (si >= sourcePage.length && !sourceDone) {
      const page = await readEligibleWorkflowLockKeyPage(source, sourceAfterHash, sourceAfterId, pageSize, watermark, "source");
      sourcePage = page.keys; si = 0; sourceDone = page.done;
      sourceAfterHash = page.afterHash; sourceAfterId = page.afterId;
    }
    if (ti >= targetPage.length && !targetDone) {
      const page = await readEligibleWorkflowLockKeyPage(target, targetAfterHash, targetAfterId, pageSize, watermark, "target");
      targetPage = page.keys; ti = 0; targetDone = page.done;
      targetAfterHash = page.afterHash; targetAfterId = page.afterId;
    }
    const a = si < sourcePage.length ? sourcePage[si] : null;
    const b = ti < targetPage.length ? targetPage[ti] : null;
    if (a === null && b === null && sourceDone && targetDone) break;
    const aOrder = a ? `${a.hash}:${a.id}` : null, bOrder = b ? `${b.hash}:${b.id}` : null;
    if (a !== null && b !== null && aOrder === bOrder) { si += 1; ti += 1; continue; }
    if (b === null || (a !== null && aOrder! < bOrder!)) { result.sourceOnly += 1; if (result.samples.sourceOnly.length < 10) result.samples.sourceOnly.push(a!.id); si += 1; }
    else { result.targetOnly += 1; if (result.samples.targetOnly.length < 10) result.samples.targetOnly.push(b!.id); ti += 1; }
  }
  return result;
}

export async function readEligibleWorkflowLockKeyPage(
  database: Pick<Pool, "query">,
  initialAfterHash: string,
  initialAfterId: string,
  pageSize: number,
  watermark: string,
  side: "source" | "target"
): Promise<{ keys: Array<{ id: string; hash: string }>; afterHash: string; afterId: string; done: boolean }> {
  let afterHash = initialAfterHash, afterId = initialAfterId;
  for (;;) {
    const previous = [afterHash, afterId] as const;
    const [rows] = await database.query<RowDataPacket[]>(
      `SELECT wl.id k, wl.workflow_definition_id,
              CAST(wl.locked_at AS CHAR) locked_at,
              CAST(wl.expires_at AS CHAR) expires_at,
              CAST(wl.released_at AS CHAR) released_at,
              wd.slug workflow_slug,
              SHA2(COALESCE(CAST(wl.id AS CHAR),''),256) h
         FROM workflow_locks wl LEFT JOIN workflow_definitions wd ON wd.id=wl.workflow_definition_id
        WHERE (SHA2(COALESCE(CAST(wl.id AS CHAR),''),256)>? OR (SHA2(COALESCE(CAST(wl.id AS CHAR),''),256)=? AND wl.id>?))
        ORDER BY h,wl.id LIMIT ?`,
      [afterHash, afterHash, afterId, pageSize]
    );
    if (!rows.length) return { keys: [], afterHash, afterId, done: true };
    afterHash = String(rows.at(-1)!.h); afterId = String(rows.at(-1)!.k);
    assertTupleProgress(`workflow_locks ${side} eligible-key page`, previous, [afterHash, afterId], rows.length);
    const keys = rows.flatMap((row) => {
      if (!isMariaDbZeroDate(row.locked_at)) return [{ id: String(row.k), hash: String(row.h) }];
      const slug = row.workflow_slug == null ? null : String(row.workflow_slug);
      if (!slug) throw new Error(`Cannot inspect ${side} workflow_locks zero-date lock ${String(row.k)}: missing workflow definition mapping`);
      return classifyWorkflowLockRow({ ...row, id: row.k } as DbRow, slug, watermark).action === "skip" ? [] : [{ id: String(row.k), hash: String(row.h) }];
    });
    if (keys.length) return { keys, afterHash, afterId, done: false };
  }
}

async function reconciliationWorkflowLockWatermark(source: SourceReader, provided?: string): Promise<string> {
  if (provided) return normalizeTimestamp(provided, { family: "workflow-children", table: "workflow_locks", column: "source_time_watermark", operation: "gap detection", nullable: false })!;
  const [rows] = await source.query<RowDataPacket[]>("SELECT UTC_TIMESTAMP(3) source_time_watermark");
  return normalizeTimestamp(rows[0]?.source_time_watermark, { family: "workflow-children", table: "workflow_locks", column: "source_time_watermark", operation: "reconciliation-only fixed watermark", nullable: false })!;
}

async function scalar(pool: Pick<Pool, "query">, sql: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(sql);
  return Number(rows[0]?.c ?? 0);
}

export async function globalReconciliation(source: SourceReader, target: Pool, pageSize = 1000, options?: { workflowLockSourceTimeWatermark?: string; includedTables?: ReadonlySet<string> }): Promise<Record<string, unknown>> {
  // Scope gate: when includedTables is provided, a check runs only if the table
  // it concerns is in scope. Undefined preserves the original full-sync behavior.
  const includes = (table: string): boolean => !options?.includedTables || options.includedTables.has(table);
  const evaluated: string[] = [];
  const workflowLockWatermark = await reconciliationWorkflowLockWatermark(source, options?.workflowLockSourceTimeWatermark);
  const antiJoins: Record<string, KeyDiff> = {};
  for (const [label, table, key] of [
    ["battle_key", "normalized_battles", "battle_key"],
    ["player_tag", "normalized_players", "player_tag"],
    ["raw_snapshot_id", "raw_api_snapshots", "id"],
    ["workflow_run_id", "workflow_runs", "id"],
    ["fetch_run_id", "data_fetch_runs", "id"],
    ["aggregation_run_id", "aggregation_runs", "id"],
    ["ranking_run_id", "ranking_runs", "id"],
  ] as const) {
    if (!includes(table)) continue;
    antiJoins[label] = await antiJoinKeys(source, target, table, key, pageSize);
    evaluated.push(`anti-join:${label}`);
  }

  const allTableKeyDiffs: Record<string, KeyDiff> = {};
  for (const table of [...new Set(TABLE_PLANS.map((plan) => plan.table))]) {
    if (options?.includedTables && !options.includedTables.has(table)) continue;
    const [pkRows] = await source.query<RowDataPacket[]>(
      "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION",
      [table]
    );
    if (pkRows.length === 1) allTableKeyDiffs[table] = table === "workflow_locks"
      ? await antiJoinWorkflowLocks(source, target, pageSize, workflowLockWatermark)
      : await antiJoinKeys(source, target, table, String(pkRows[0].COLUMN_NAME), pageSize);
  }

  const orphanQueries: Array<[string, string, string]> = [
    ["battleTeams", "battle_teams", "SELECT COUNT(*) c FROM battle_teams x LEFT JOIN normalized_battles p ON p.id=x.battle_id WHERE p.id IS NULL"],
    ["participantsBattle", "battle_participants", "SELECT COUNT(*) c FROM battle_participants x LEFT JOIN normalized_battles p ON p.id=x.battle_id WHERE p.id IS NULL"],
    ["participantsPlayer", "battle_participants", "SELECT COUNT(*) c FROM battle_participants x LEFT JOIN normalized_players p ON p.id=x.player_id WHERE p.id IS NULL"],
    ["observationsBattle", "battle_observations", "SELECT COUNT(*) c FROM battle_observations x LEFT JOIN normalized_battles p ON p.id=x.battle_id WHERE p.id IS NULL"],
    ["observationsFetch", "battle_observations", "SELECT COUNT(*) c FROM battle_observations x LEFT JOIN data_fetch_runs p ON p.id=x.data_fetch_run_id WHERE p.id IS NULL"],
    ["publishedItems", "published_snapshot_items", "SELECT COUNT(*) c FROM published_snapshot_items x LEFT JOIN published_snapshots p ON p.id=x.published_snapshot_id WHERE p.id IS NULL"],
  ];
  const orphans: Record<string, number> = {};
  for (const [name, table, sql] of orphanQueries) if (includes(table)) orphans[name] = await scalar(target, sql);

  // The published pointer/items are validated here only when published tables are
  // in scope; Tier-1 validates the current pointer via reconcileCurrentPublication.
  const publishedInScope = includes("published_snapshots") && includes("published_snapshot_items");
  let publishedPointerMatch = true;
  const publishedItemDigests = {
    items: { match: true, mismatchSamples: [] as string[] },
    matchups: { match: true, mismatchSamples: [] as string[] },
  };
  if (publishedInScope) {
    const currentSql = `SELECT ps.id, ps.ranking_run_id, ps.is_current,
      (SELECT COUNT(*) FROM published_snapshot_items i WHERE i.published_snapshot_id=ps.id) item_count,
      (SELECT COUNT(*) FROM published_matchup_items i WHERE i.published_snapshot_id=ps.id) matchup_count
      FROM published_snapshots ps WHERE ps.is_current=1`;
    const [[sourceCurrent], [targetCurrent]] = await Promise.all([
      source.query<RowDataPacket[]>(currentSql), target.query<RowDataPacket[]>(currentSql),
    ]);
    publishedPointerMatch = canonicalRow({ rows: sourceCurrent }, ["rows"]) === canonicalRow({ rows: targetCurrent }, ["rows"]);
    publishedItemDigests.items = await compareParentDigests(source, target, "published_snapshot_items", "published_snapshot_id", pageSize);
    publishedItemDigests.matchups = await compareParentDigests(source, target, "published_matchup_items", "published_snapshot_id", pageSize);
    evaluated.push("published-pointer", "published-item-digests");
  }

  const childGraphs: Record<string, { match: boolean; sourceParents: number; targetParents: number; mismatchSamples: string[] }> = {};
  for (const [table, parent] of [["battle_teams", "battle_id"], ["battle_participants", "battle_id"], ["battle_observations", "battle_id"]] as const) {
    if (!includes(table)) continue;
    const [a, b] = await Promise.all([parentDigests(source, table, parent, pageSize, "source"), parentDigests(target, table, parent, pageSize, "target")]);
    const mismatches = [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key));
    childGraphs[table] = { match: mismatches.length === 0, sourceParents: a.size, targetParents: b.size, mismatchSamples: mismatches.slice(0, 10) };
    evaluated.push(`child-graph:${table}`);
  }

  const rawInScope = includes("raw_api_snapshots");
  const rawChecksums = rawInScope
    ? await compareKeyValues(source, target, "raw_api_snapshots", "id", "checksum", pageSize)
    : { mismatches: 0, samples: [] as string[] };
  const rawMismatch = rawInScope
    ? await scalar(target, "SELECT COUNT(*) c FROM raw_api_snapshots WHERE checksum <> SHA2(payload,256)")
    : 0;
  if (rawInScope) evaluated.push("raw-checksums");

  const flags: Record<string, { source: number; target: number; match: boolean }> = {};
  for (const [name, table, sql] of [
    ["current_published", "published_snapshots", "SELECT COUNT(*) c FROM published_snapshots WHERE is_current=1"],
    ["active_patch", "patches", "SELECT COUNT(*) c FROM patches WHERE status='active'"],
    ["active_rules", "ranking_rule_sets", "SELECT COUNT(*) c FROM ranking_rule_sets WHERE is_active=1"],
    ["accepted_snapshots", "normalized_snapshots", "SELECT COUNT(*) c FROM normalized_snapshots WHERE is_accepted=1"],
  ] as const) {
    if (!includes(table)) continue;
    const [a, b] = await Promise.all([scalar(source, sql), scalar(target, sql)]);
    flags[name] = { source: a, target: b, match: a === b };
    evaluated.push(`flag:${name}`);
  }

  const passed = Object.values(antiJoins).every((diff) => diff.sourceOnly === 0 && diff.targetOnly === 0)
    && Object.values(allTableKeyDiffs).every((diff) => diff.sourceOnly === 0 && diff.targetOnly === 0)
    && Object.values(childGraphs).every((graph) => graph.match)
    && rawChecksums.mismatches === 0
    && publishedItemDigests.items.match && publishedItemDigests.matchups.match
    && Object.values(orphans).every((count) => count === 0)
    && publishedPointerMatch && rawMismatch === 0 && Object.values(flags).every((flag) => flag.match);
  return { passed, scoped: Boolean(options?.includedTables), evaluated, antiJoins, allTableKeyDiffs, childGraphs, rawChecksums, publishedItemDigests, orphans, rawTargetPayloadChecksumMismatches: rawMismatch, publishedPointerMatch, flags };
}

async function parentDigests(pool: Pick<Pool, "query">, table: string, parent: string, pageSize: number, side: "source" | "target"): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  const plan = TABLE_PLANS.find((item) => item.table === table);
  if (!plan) throw new Error(`Missing migration plan for ${table}`);
  const metadata = await readMetadata(pool, table);
  let afterParent = "", afterId = "", currentParent: string | null = null;
  let hash = createHash("sha256"), count = 0;
  const flush = (): void => {
    if (currentParent !== null) output.set(currentParent, `${count}:${hash.digest("hex")}`);
    hash = createHash("sha256"); count = 0;
  };
  for (;;) {
    const previous = [afterParent, afterId] as const;
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM ${q(table)} WHERE (${q(parent)} > ? OR (${q(parent)} = ? AND id > ?)) ORDER BY ${q(parent)}, id LIMIT ?`,
      [afterParent, afterParent, afterId, pageSize]
    );
    if (!rows.length) break;
    for (const rawRow of rows) {
      const row = normalizeTimestampRow(rawRow as DbRow, metadata, plan, `${side} reconciliation digest normalization`);
      const value = String(row[parent]);
      if (currentParent !== value) { if (currentParent !== null) flush(); currentParent = value; }
      hash.update(canonicalRow(row, Object.keys(row))).update("\n"); count += 1;
    }
    afterParent = String(rows.at(-1)![parent]); afterId = String(rows.at(-1)!.id);
    assertTupleProgress(`${table} ${side} parent digest`, previous, [afterParent, afterId], rows.length);
  }
  if (currentParent !== null) flush();
  return output;
}

async function compareParentDigests(source: SourceReader, target: Pool, table: string, parent: string, pageSize: number): Promise<{ match: boolean; mismatchSamples: string[] }> {
  const [a, b] = await Promise.all([parentDigests(source, table, parent, pageSize, "source"), parentDigests(target, table, parent, pageSize, "target")]);
  const mismatches = [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key));
  return { match: mismatches.length === 0, mismatchSamples: mismatches.slice(0, 10) };
}

async function compareKeyValues(source: SourceReader, target: Pool, table: string, key: string, value: string, pageSize: number): Promise<{ mismatches: number; samples: string[] }> {
  let after = "", mismatches = 0; const samples: string[] = [];
  for (;;) {
    const previous = after;
    const [rows] = await source.query<RowDataPacket[]>(`SELECT ${q(key)} k, ${q(value)} v FROM ${q(table)} WHERE ${q(key)} > ? ORDER BY ${q(key)} LIMIT ?`, [after, pageSize]);
    if (!rows.length) break;
    const keys = rows.map((row) => String(row.k));
    const [targets] = await target.query<RowDataPacket[]>(`SELECT ${q(key)} k, ${q(value)} v FROM ${q(table)} WHERE ${q(key)} IN (${keys.map(() => "?").join(",")})`, keys);
    const targetMap = new Map(targets.map((row) => [String(row.k), String(row.v)]));
    for (const row of rows) if (targetMap.get(String(row.k)) !== String(row.v)) { mismatches += 1; if (samples.length < 10) samples.push(String(row.k)); }
    after = keys[keys.length - 1];
    assertTupleProgress(`${table} source value comparison`, [previous], [after], rows.length);
  }
  return { mismatches, samples };
}

async function writableColumns(pool: Pick<Pool, "query">, table: string): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COLUMN_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION",
    [table]
  );
  return rows.filter((row) => !String(row.EXTRA).toUpperCase().includes("GENERATED")).map((row) => String(row.COLUMN_NAME));
}

/** Reconciles the current pointer and its complete immutable child sets in one target transaction. */
export async function reconcileCurrentPublication(source: SourceReader, target: Pool, apply: boolean): Promise<Record<string, unknown>> {
  const [snapshots] = await source.query<RowDataPacket[]>("SELECT * FROM published_snapshots WHERE is_current=1");
  if (snapshots.length > 1) throw new Error("Source has more than one current published snapshot");
  if (snapshots.length === 0) return { available: false, matched: true, applied: false };
  const snapshot = snapshots[0];
  const snapshotId = String(snapshot.id);
  const tables = ["published_snapshots", "published_snapshot_items", "published_matchup_items"];
  const columns = new Map<string, string[]>();
  const metadata = new Map<string, TableMetadata>();
  for (const table of tables) {
    columns.set(table, await writableColumns(target, table));
    metadata.set(table, await readMetadata(target, table));
  }
  const [items] = await source.query<RowDataPacket[]>("SELECT * FROM published_snapshot_items WHERE published_snapshot_id=? ORDER BY id", [snapshotId]);
  const [matchups] = await source.query<RowDataPacket[]>("SELECT * FROM published_matchup_items WHERE published_snapshot_id=? ORDER BY id", [snapshotId]);
  const connection = await target.getConnection();
  try {
    await connection.beginTransaction();
    const copyExact = async (table: string, rows: RowDataPacket[]): Promise<void> => {
      const cols = columns.get(table)!;
      const plan = TABLE_PLANS.find((item) => item.table === table)!;
      const tableMetadata = metadata.get(table)!;
      const compareColumns = table === "published_snapshots" ? cols.filter((column) => column !== "is_current") : cols;
      for (const rawRow of rows) {
        const row = normalizeTimestampRow(rawRow as DbRow, tableMetadata, plan, "source published-row normalization");
        const [rawExisting] = await connection.query<RowDataPacket[]>(`SELECT * FROM ${q(table)} WHERE id=?`, [row.id]);
        const existing = rawExisting.map((item) => normalizeTimestampRow(item as DbRow, tableMetadata, plan, "target published-row normalization"));
        if (existing.length) {
          if (canonicalRow(row, compareColumns) !== canonicalRow(existing[0], compareColumns)) throw new Error(`Immutable published divergence in ${table} id=${row.id}`);
          continue;
        }
        if (apply) await connection.execute(
          `INSERT INTO ${q(table)} (${cols.map(q).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
          cols.map((column) => table === "published_snapshots" && column === "is_current"
            ? 0
            : tableMetadata.timestampColumns.includes(column)
              ? timestampForTarget(row[column], { family: plan.family, table: plan.table, column, operation: "published target write binding", nullable: tableMetadata.nullableColumns.includes(column) })
              : row[column]) as never[]
        );
      }
    };
    await copyExact("published_snapshots", [snapshot]);
    await copyExact("published_snapshot_items", items);
    await copyExact("published_matchup_items", matchups);
    const [targetItems] = await connection.query<RowDataPacket[]>("SELECT id FROM published_snapshot_items WHERE published_snapshot_id=?", [snapshotId]);
    const [targetMatchups] = await connection.query<RowDataPacket[]>("SELECT id FROM published_matchup_items WHERE published_snapshot_id=?", [snapshotId]);
    const sourceItemIds = new Set(items.map((row) => String(row.id)));
    const sourceMatchupIds = new Set(matchups.map((row) => String(row.id)));
    const staleItems = targetItems.map((row) => String(row.id)).filter((id) => !sourceItemIds.has(id));
    const staleMatchups = targetMatchups.map((row) => String(row.id)).filter((id) => !sourceMatchupIds.has(id));
    if (apply) {
      if (staleItems.length) await connection.execute(`DELETE FROM published_snapshot_items WHERE id IN (${staleItems.map(() => "?").join(",")})`, staleItems);
      if (staleMatchups.length) await connection.execute(`DELETE FROM published_matchup_items WHERE id IN (${staleMatchups.map(() => "?").join(",")})`, staleMatchups);
      await connection.execute("UPDATE published_snapshots SET is_current=0 WHERE is_current=1 AND id<>?", [snapshotId]);
      await connection.execute("UPDATE published_snapshots SET is_current=1 WHERE id=?", [snapshotId]);
    }
    const matched = staleItems.length === 0 && staleMatchups.length === 0;
    if (apply) await connection.commit(); else await connection.rollback();
    return { available: true, snapshotId, sourceItemCount: items.length, sourceMatchupCount: matchups.length, staleItems: staleItems.length, staleMatchups: staleMatchups.length, matched: apply ? true : matched, applied: apply };
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally { connection.release(); }
}
