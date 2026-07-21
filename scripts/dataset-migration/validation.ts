import type { Pool, RowDataPacket } from "mysql2/promise";
import { canonicalRow } from "./canonical";
import { createHash } from "node:crypto";
import { TABLE_PLANS } from "./model";

const q = (identifier: string): string => `\`${identifier.replace(/`/g, "``")}\``;

export interface KeyDiff {
  sourceOnly: number;
  targetOnly: number;
  samples: { sourceOnly: string[]; targetOnly: string[] };
}

async function keyPage(pool: Pool, table: string, key: string, after: string, limit: number): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${q(key)} AS k FROM ${q(table)} WHERE ${q(key)} > ? ORDER BY ${q(key)} LIMIT ?`,
    [after, limit]
  );
  return rows.map((row) => String(row.k));
}

/** Exact merge anti-join using bounded ordered key pages; it never loads a whole table. */
export async function antiJoinKeys(source: Pool, target: Pool, table: string, key: string, pageSize = 1000): Promise<KeyDiff> {
  let sourceAfter = "", targetAfter = "";
  let sourcePage: string[] = [], targetPage: string[] = [];
  let si = 0, ti = 0, sourceDone = false, targetDone = false;
  const result: KeyDiff = { sourceOnly: 0, targetOnly: 0, samples: { sourceOnly: [], targetOnly: [] } };
  for (;;) {
    if (si >= sourcePage.length && !sourceDone) {
      sourcePage = await keyPage(source, table, key, sourceAfter, pageSize); si = 0;
      if (!sourcePage.length) sourceDone = true; else sourceAfter = sourcePage[sourcePage.length - 1];
    }
    if (ti >= targetPage.length && !targetDone) {
      targetPage = await keyPage(target, table, key, targetAfter, pageSize); ti = 0;
      if (!targetPage.length) targetDone = true; else targetAfter = targetPage[targetPage.length - 1];
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

async function scalar(pool: Pool, sql: string): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(sql);
  return Number(rows[0]?.c ?? 0);
}

export async function globalReconciliation(source: Pool, target: Pool, pageSize = 1000): Promise<Record<string, unknown>> {
  const antiJoins: Record<string, KeyDiff> = {};
  for (const [label, table, key] of [
    ["battle_key", "normalized_battles", "battle_key"],
    ["player_tag", "normalized_players", "player_tag"],
    ["raw_snapshot_id", "raw_api_snapshots", "id"],
    ["workflow_run_id", "workflow_runs", "id"],
    ["fetch_run_id", "data_fetch_runs", "id"],
    ["aggregation_run_id", "aggregation_runs", "id"],
    ["ranking_run_id", "ranking_runs", "id"],
  ] as const) antiJoins[label] = await antiJoinKeys(source, target, table, key, pageSize);

  const allTableKeyDiffs: Record<string, KeyDiff> = {};
  for (const table of [...new Set(TABLE_PLANS.map((plan) => plan.table))]) {
    const [pkRows] = await source.query<RowDataPacket[]>(
      "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION",
      [table]
    );
    if (pkRows.length === 1) allTableKeyDiffs[table] = await antiJoinKeys(source, target, table, String(pkRows[0].COLUMN_NAME), pageSize);
  }

  const orphanQueries = {
    battleTeams: "SELECT COUNT(*) c FROM battle_teams x LEFT JOIN normalized_battles p ON p.id=x.battle_id WHERE p.id IS NULL",
    participantsBattle: "SELECT COUNT(*) c FROM battle_participants x LEFT JOIN normalized_battles p ON p.id=x.battle_id WHERE p.id IS NULL",
    participantsPlayer: "SELECT COUNT(*) c FROM battle_participants x LEFT JOIN normalized_players p ON p.id=x.player_id WHERE p.id IS NULL",
    observationsBattle: "SELECT COUNT(*) c FROM battle_observations x LEFT JOIN normalized_battles p ON p.id=x.battle_id WHERE p.id IS NULL",
    observationsFetch: "SELECT COUNT(*) c FROM battle_observations x LEFT JOIN data_fetch_runs p ON p.id=x.data_fetch_run_id WHERE p.id IS NULL",
    publishedItems: "SELECT COUNT(*) c FROM published_snapshot_items x LEFT JOIN published_snapshots p ON p.id=x.published_snapshot_id WHERE p.id IS NULL",
  };
  const orphans: Record<string, number> = {};
  for (const [name, sql] of Object.entries(orphanQueries)) orphans[name] = await scalar(target, sql);

  const currentSql = `SELECT ps.id, ps.ranking_run_id, ps.is_current,
    (SELECT COUNT(*) FROM published_snapshot_items i WHERE i.published_snapshot_id=ps.id) item_count,
    (SELECT COUNT(*) FROM published_matchup_items i WHERE i.published_snapshot_id=ps.id) matchup_count
    FROM published_snapshots ps WHERE ps.is_current=1`;
  const [[sourceCurrent], [targetCurrent]] = await Promise.all([
    source.query<RowDataPacket[]>(currentSql), target.query<RowDataPacket[]>(currentSql),
  ]);
  const publishedPointerMatch = canonicalRow({ rows: sourceCurrent }, ["rows"]) === canonicalRow({ rows: targetCurrent }, ["rows"]);

  const childGraphs: Record<string, { match: boolean; sourceParents: number; targetParents: number; mismatchSamples: string[] }> = {};
  for (const [table, parent] of [["battle_teams", "battle_id"], ["battle_participants", "battle_id"], ["battle_observations", "battle_id"]] as const) {
    const [a, b] = await Promise.all([parentDigests(source, table, parent, pageSize), parentDigests(target, table, parent, pageSize)]);
    const mismatches = [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key));
    childGraphs[table] = { match: mismatches.length === 0, sourceParents: a.size, targetParents: b.size, mismatchSamples: mismatches.slice(0, 10) };
  }
  const rawChecksums = await compareKeyValues(source, target, "raw_api_snapshots", "id", "checksum", pageSize);
  const publishedItemDigests = {
    items: await compareParentDigests(source, target, "published_snapshot_items", "published_snapshot_id", pageSize),
    matchups: await compareParentDigests(source, target, "published_matchup_items", "published_snapshot_id", pageSize),
  };

  const rawMismatch = await scalar(target,
    "SELECT COUNT(*) c FROM raw_api_snapshots WHERE checksum <> SHA2(payload,256)"
  );
  const flags: Record<string, { source: number; target: number; match: boolean }> = {};
  for (const [name, sql] of [
    ["current_published", "SELECT COUNT(*) c FROM published_snapshots WHERE is_current=1"],
    ["active_patch", "SELECT COUNT(*) c FROM patches WHERE status='active'"],
    ["active_rules", "SELECT COUNT(*) c FROM ranking_rule_sets WHERE is_active=1"],
    ["accepted_snapshots", "SELECT COUNT(*) c FROM normalized_snapshots WHERE is_accepted=1"],
  ] as const) {
    const [a, b] = await Promise.all([scalar(source, sql), scalar(target, sql)]);
    flags[name] = { source: a, target: b, match: a === b };
  }

  const passed = Object.values(antiJoins).every((diff) => diff.sourceOnly === 0 && diff.targetOnly === 0)
    && Object.values(allTableKeyDiffs).every((diff) => diff.sourceOnly === 0 && diff.targetOnly === 0)
    && Object.values(childGraphs).every((graph) => graph.match)
    && rawChecksums.mismatches === 0
    && publishedItemDigests.items.match && publishedItemDigests.matchups.match
    && Object.values(orphans).every((count) => count === 0)
    && publishedPointerMatch && rawMismatch === 0 && Object.values(flags).every((flag) => flag.match);
  return { passed, antiJoins, allTableKeyDiffs, childGraphs, rawChecksums, publishedItemDigests, orphans, rawTargetPayloadChecksumMismatches: rawMismatch, publishedPointerMatch, flags };
}

async function parentDigests(pool: Pool, table: string, parent: string, pageSize: number): Promise<Map<string, string>> {
  const output = new Map<string, string>();
  let afterParent = "", afterId = "", currentParent: string | null = null;
  let hash = createHash("sha256"), count = 0;
  const flush = (): void => {
    if (currentParent !== null) output.set(currentParent, `${count}:${hash.digest("hex")}`);
    hash = createHash("sha256"); count = 0;
  };
  for (;;) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM ${q(table)} WHERE (${q(parent)} > ? OR (${q(parent)} = ? AND id > ?)) ORDER BY ${q(parent)}, id LIMIT ?`,
      [afterParent, afterParent, afterId, pageSize]
    );
    if (!rows.length) break;
    for (const row of rows) {
      const value = String(row[parent]);
      if (currentParent !== value) { if (currentParent !== null) flush(); currentParent = value; }
      hash.update(canonicalRow(row, Object.keys(row))).update("\n"); count += 1;
    }
    afterParent = String(rows.at(-1)![parent]); afterId = String(rows.at(-1)!.id);
  }
  if (currentParent !== null) flush();
  return output;
}

async function compareParentDigests(source: Pool, target: Pool, table: string, parent: string, pageSize: number): Promise<{ match: boolean; mismatchSamples: string[] }> {
  const [a, b] = await Promise.all([parentDigests(source, table, parent, pageSize), parentDigests(target, table, parent, pageSize)]);
  const mismatches = [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key));
  return { match: mismatches.length === 0, mismatchSamples: mismatches.slice(0, 10) };
}

async function compareKeyValues(source: Pool, target: Pool, table: string, key: string, value: string, pageSize: number): Promise<{ mismatches: number; samples: string[] }> {
  let after = "", mismatches = 0; const samples: string[] = [];
  for (;;) {
    const [rows] = await source.query<RowDataPacket[]>(`SELECT ${q(key)} k, ${q(value)} v FROM ${q(table)} WHERE ${q(key)} > ? ORDER BY ${q(key)} LIMIT ?`, [after, pageSize]);
    if (!rows.length) break;
    const keys = rows.map((row) => String(row.k));
    const [targets] = await target.query<RowDataPacket[]>(`SELECT ${q(key)} k, ${q(value)} v FROM ${q(table)} WHERE ${q(key)} IN (${keys.map(() => "?").join(",")})`, keys);
    const targetMap = new Map(targets.map((row) => [String(row.k), String(row.v)]));
    for (const row of rows) if (targetMap.get(String(row.k)) !== String(row.v)) { mismatches += 1; if (samples.length < 10) samples.push(String(row.k)); }
    after = keys[keys.length - 1];
  }
  return { mismatches, samples };
}

async function writableColumns(pool: Pool, table: string): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COLUMN_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION",
    [table]
  );
  return rows.filter((row) => !String(row.EXTRA).toUpperCase().includes("GENERATED")).map((row) => String(row.COLUMN_NAME));
}

/** Reconciles the current pointer and its complete immutable child sets in one target transaction. */
export async function reconcileCurrentPublication(source: Pool, target: Pool, apply: boolean): Promise<Record<string, unknown>> {
  const [snapshots] = await source.query<RowDataPacket[]>("SELECT * FROM published_snapshots WHERE is_current=1");
  if (snapshots.length > 1) throw new Error("Source has more than one current published snapshot");
  if (snapshots.length === 0) return { available: false, matched: true, applied: false };
  const snapshot = snapshots[0];
  const snapshotId = String(snapshot.id);
  const tables = ["published_snapshots", "published_snapshot_items", "published_matchup_items"];
  const columns = new Map<string, string[]>();
  for (const table of tables) columns.set(table, await writableColumns(target, table));
  const [items] = await source.query<RowDataPacket[]>("SELECT * FROM published_snapshot_items WHERE published_snapshot_id=? ORDER BY id", [snapshotId]);
  const [matchups] = await source.query<RowDataPacket[]>("SELECT * FROM published_matchup_items WHERE published_snapshot_id=? ORDER BY id", [snapshotId]);
  const connection = await target.getConnection();
  try {
    await connection.beginTransaction();
    const copyExact = async (table: string, rows: RowDataPacket[]): Promise<void> => {
      const cols = columns.get(table)!;
      const compareColumns = table === "published_snapshots" ? cols.filter((column) => column !== "is_current") : cols;
      for (const row of rows) {
        const [existing] = await connection.query<RowDataPacket[]>(`SELECT * FROM ${q(table)} WHERE id=?`, [row.id]);
        if (existing.length) {
          if (canonicalRow(row, compareColumns) !== canonicalRow(existing[0], compareColumns)) throw new Error(`Immutable published divergence in ${table} id=${row.id}`);
          continue;
        }
        if (apply) await connection.execute(
          `INSERT INTO ${q(table)} (${cols.map(q).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
          cols.map((column) => table === "published_snapshots" && column === "is_current" ? 0 : row[column])
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
