/**
 * DATASET Phase 14 — archive-gated lifecycle for multi-table "graph" families.
 *
 * One generalized engine (archive -> verify -> staging re-import proof ->
 * FK-ordered, allowlisted, bounded deletion) drives every family that archives
 * SEVERAL tables atomically per batch:
 *
 *   - battle_graph        : normalized_battles + battle_participants +
 *                           battle_teams + battle_observations, at 365 days.
 *   - battle_observations : battle_observations at 180 days, for battles that
 *                           are still hot (not yet graph-eligible).
 *   - workflow_audit      : workflow_runs (+ workflow_steps), 365 days standard,
 *                           24 months for failed/held.
 *   - fetch_audit         : data_fetch_runs, 365 days.
 *
 * Hard safety model (identical to the run-scoped retention, generalized):
 *   - dry-run/plan is the default and writes nothing;
 *   - destructive actions require the explicit RETENTION_DESTRUCTIVE_ENABLED
 *     flag AND a production-environment guard (RETENTION_ENVIRONMENT must mark an
 *     isolated/disposable DB) AND, for reimport/delete, a DB isolated-staging
 *     attestation;
 *   - no row is deleted before its batch archive is double-verified AND a
 *     staging re-import (restore + FK/replay) proof has passed;
 *   - deletion uses EXPLICIT allowlisted anchor ids (never a broad date-only
 *     DELETE), FK-safe order, bounded batches, checkpoints (resumable),
 *     re-checks eligibility under a lock, and reconciles counts;
 *   - a workflow lock serializes sweeps; each family is isolated so one
 *     family's failure never affects another;
 *   - every archive and deletion batch emits a manifest with checksums, counts,
 *     timings, and (for skips) precise reasons.
 */

import { randomUUID, createHash } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { gzipPayload, gunzipToString, sha256Hex } from "@/lib/archive/codec";
import type { ObjectStorageProvider } from "@/lib/archive/provider";
import { canonicalJson } from "./archive";
import { hasIsolatedStagingAttestation } from "./repository";
import {
  ensureWorkflowDefinition,
  acquireWorkflowLock,
  releaseWorkflowLock,
} from "@/lib/workflow";

type Queryable = Pool | PoolConnection;

export const GRAPH_ARCHIVE_FORMAT = "brawlranks-graph-archive/v1";
export const GRAPH_ARCHIVE_SCHEMA_VERSION = "1";
export const DEFAULT_ANCHOR_BATCH = 50;
export const MAX_ANCHOR_BATCH = 500;
export const DEFAULT_DELETE_BATCH = 500;
export const MAX_DELETE_BATCH = 2000;
export const DEFAULT_SCAN_LIMIT = 1000;
const EXPORT_PAGE = 2000;
const LOCK_SLUG = "retention-graph";
const LOCK_TTL_MS = 30 * 60_000;
const DAY = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every table any graph family may read/archive/delete — the ONLY identifiers allowed in dynamic SQL here. */
const GRAPH_TABLES = new Set<string>([
  "normalized_battles", "battle_participants", "battle_teams", "battle_observations",
  "workflow_runs", "workflow_steps", "data_fetch_runs",
]);
function assertGraphTable(table: string): void {
  if (!GRAPH_TABLES.has(table)) throw new Error(`refusing unknown graph table: ${table}`);
}
function assertColumn(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`refusing unsafe column: ${name}`);
}

// ---------------------------------------------------------------------------
// Family configuration
// ---------------------------------------------------------------------------

export interface GraphChildSpec { table: string; fkColumn: string }
export interface GraphFamily {
  family: string;
  anchorTable: string;
  timeColumn: string;
  hotDays: number;
  /** failed/held-style extended retention (workflow_audit). */
  extended?: { statuses: string[]; days: number };
  naturalKeyColumns: string[];
  children: GraphChildSpec[];
  /** FK-safe DELETE order (children first, anchor last). */
  deleteOrder: string[];
  sourceRefs: { table: string; column: string }[];
}

export const BATTLE_GRAPH: GraphFamily = {
  family: "battle_graph",
  anchorTable: "normalized_battles",
  timeColumn: "occurred_at",
  hotDays: 365,
  naturalKeyColumns: ["battle_key"],
  children: [
    { table: "battle_participants", fkColumn: "battle_id" },
    { table: "battle_teams", fkColumn: "battle_id" },
    { table: "battle_observations", fkColumn: "battle_id" },
  ],
  // battle_participants -> battle_teams (FK battle_team_id) so participants first.
  deleteOrder: ["battle_participants", "battle_teams", "battle_observations", "normalized_battles"],
  sourceRefs: [
    { table: "normalized_battles", column: "first_observed_fetch_run_id" },
    { table: "battle_observations", column: "data_fetch_run_id" },
  ],
};

export const BATTLE_OBSERVATIONS: GraphFamily = {
  family: "battle_observations",
  anchorTable: "battle_observations",
  timeColumn: "observed_at",
  hotDays: 180,
  naturalKeyColumns: ["battle_id", "data_fetch_run_id"],
  children: [],
  deleteOrder: ["battle_observations"],
  sourceRefs: [{ table: "battle_observations", column: "data_fetch_run_id" }],
};

export const WORKFLOW_AUDIT: GraphFamily = {
  family: "workflow_audit",
  anchorTable: "workflow_runs",
  timeColumn: "started_at",
  hotDays: 365,
  extended: { statuses: ["failed", "held"], days: 730 },
  naturalKeyColumns: ["id"],
  children: [{ table: "workflow_steps", fkColumn: "workflow_run_id" }],
  deleteOrder: ["workflow_steps", "workflow_runs"],
  sourceRefs: [],
};

export const FETCH_AUDIT: GraphFamily = {
  family: "fetch_audit",
  anchorTable: "data_fetch_runs",
  timeColumn: "started_at",
  hotDays: 365,
  naturalKeyColumns: ["id"],
  children: [],
  deleteOrder: ["data_fetch_runs"],
  sourceRefs: [{ table: "data_fetch_runs", column: "workflow_run_id" }],
};

export const GRAPH_FAMILIES: Record<string, GraphFamily> = {
  battle_graph: BATTLE_GRAPH,
  battle_observations: BATTLE_OBSERVATIONS,
  workflow_audit: WORKFLOW_AUDIT,
  fetch_audit: FETCH_AUDIT,
};

export function getFamily(name: string): GraphFamily {
  const f = GRAPH_FAMILIES[name];
  if (!f) throw new Error(`unknown retention family: ${name}`);
  return f;
}

// ---------------------------------------------------------------------------
// Planning (read-only eligibility with precise skip reasons)
// ---------------------------------------------------------------------------

export interface AnchorCandidate { anchorId: string; naturalKey: Record<string, unknown>; ts: Date | null }
export interface AnchorSkip { anchorId: string; reason: string }
export interface GraphPlan {
  family: string;
  generatedAt: string;
  hotDays: number;
  scanLimit: number;
  candidates: AnchorCandidate[];
  skipped: AnchorSkip[];
  skippedByReason: Record<string, number>;
  totals: { scanned: number; eligible: number; skipped: number };
}

function makePlan(family: string, scanLimit: number, now: Date, candidates: AnchorCandidate[], skipped: AnchorSkip[], hotDays: number): GraphPlan {
  const skippedByReason: Record<string, number> = {};
  for (const s of skipped) skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;
  return {
    family, generatedAt: now.toISOString(), hotDays, scanLimit,
    candidates, skipped, skippedByReason,
    totals: { scanned: candidates.length + skipped.length, eligible: candidates.length, skipped: skipped.length },
  };
}

export async function planFamily(db: Queryable, family: GraphFamily, opts: { scanLimit?: number; now?: Date } = {}): Promise<GraphPlan> {
  const now = opts.now ?? new Date();
  const scanLimit = Math.min(Math.max(1, opts.scanLimit ?? DEFAULT_SCAN_LIMIT), 50_000);
  switch (family.family) {
    case "battle_graph": return planBattleGraph(db, now, scanLimit);
    case "battle_observations": return planBattleObservations(db, now, scanLimit);
    case "workflow_audit": return planWorkflowAudit(db, now, scanLimit);
    case "fetch_audit": return planFetchAudit(db, now, scanLimit);
    default: throw new Error(`no planner for family ${family.family}`);
  }
}

async function planBattleGraph(db: Queryable, now: Date, scanLimit: number): Promise<GraphPlan> {
  const cutoff = new Date(now.getTime() - BATTLE_GRAPH.hotDays * DAY);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id AS anchorId, battle_key AS battleKey, occurred_at AS ts
       FROM normalized_battles WHERE occurred_at < ? ORDER BY id ASC LIMIT ?`,
    [cutoff, scanLimit]
  );
  const candidates = rows.map((r) => ({ anchorId: r.anchorId as string, naturalKey: { battle_key: r.battleKey }, ts: r.ts ? new Date(r.ts) : null }));
  return makePlan("battle_graph", scanLimit, now, candidates, [], BATTLE_GRAPH.hotDays);
}

async function planBattleObservations(db: Queryable, now: Date, scanLimit: number): Promise<GraphPlan> {
  const obsCutoff = new Date(now.getTime() - BATTLE_OBSERVATIONS.hotDays * DAY);
  const battleHotCutoff = new Date(now.getTime() - BATTLE_GRAPH.hotDays * DAY);
  // Only observations of STILL-HOT battles (battle graph handles the rest atomically).
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT o.id AS anchorId, o.battle_id AS battleId, o.data_fetch_run_id AS fetchId, o.observed_at AS ts
       FROM battle_observations o
       JOIN normalized_battles b ON b.id = o.battle_id
      WHERE o.observed_at < ? AND b.occurred_at >= ?
      ORDER BY o.id ASC LIMIT ?`,
    [obsCutoff, battleHotCutoff, scanLimit]
  );
  const candidates = rows.map((r) => ({ anchorId: r.anchorId as string, naturalKey: { battle_id: r.battleId, data_fetch_run_id: r.fetchId }, ts: r.ts ? new Date(r.ts) : null }));
  return makePlan("battle_observations", scanLimit, now, candidates, [], BATTLE_OBSERVATIONS.hotDays);
}

const WF_ACTIVE = new Set(["running", "queued", "retrying"]);
const WF_EXTENDED = new Set(["failed", "held"]);

async function planWorkflowAudit(db: Queryable, now: Date, scanLimit: number): Promise<GraphPlan> {
  const stdCutoff = new Date(now.getTime() - WORKFLOW_AUDIT.hotDays * DAY);
  const extCutoff = new Date(now.getTime() - (WORKFLOW_AUDIT.extended?.days ?? 730) * DAY);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT wr.id AS anchorId, wr.status AS status, wr.started_at AS ts,
            EXISTS(SELECT 1 FROM data_fetch_runs dfr WHERE dfr.workflow_run_id = wr.id) AS refFetch,
            EXISTS(SELECT 1 FROM workflow_locks wl WHERE wl.locked_by_run_id = wr.id
                     AND wl.released_at IS NULL AND wl.expires_at > UTC_TIMESTAMP(3)) AS refLock
       FROM workflow_runs wr
      WHERE wr.started_at < ?
      ORDER BY wr.id ASC LIMIT ?`,
    [stdCutoff, scanLimit]
  );
  const candidates: AnchorCandidate[] = [];
  const skipped: AnchorSkip[] = [];
  for (const r of rows) {
    const id = r.anchorId as string;
    const status = String(r.status);
    const ts = r.ts ? new Date(r.ts) : null;
    if (WF_ACTIVE.has(status)) { skipped.push({ anchorId: id, reason: "active_or_retryable" }); continue; }
    if (Number(r.refFetch) === 1) { skipped.push({ anchorId: id, reason: "referenced_by_fetch" }); continue; }
    if (Number(r.refLock) === 1) { skipped.push({ anchorId: id, reason: "referenced_by_active_lock" }); continue; }
    if (WF_EXTENDED.has(status) && ts && ts.getTime() >= extCutoff.getTime()) {
      skipped.push({ anchorId: id, reason: "within_extended_retention" });
      continue;
    }
    candidates.push({ anchorId: id, naturalKey: { id }, ts });
  }
  return makePlan("workflow_audit", scanLimit, now, candidates, skipped, WORKFLOW_AUDIT.hotDays);
}

async function planFetchAudit(db: Queryable, now: Date, scanLimit: number): Promise<GraphPlan> {
  const cutoff = new Date(now.getTime() - FETCH_AUDIT.hotDays * DAY);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT dfr.id AS anchorId, dfr.started_at AS ts,
            EXISTS(SELECT 1 FROM raw_api_snapshots x WHERE x.data_fetch_run_id = dfr.id) AS refRaw,
            EXISTS(SELECT 1 FROM battle_observations x WHERE x.data_fetch_run_id = dfr.id) AS refObs,
            EXISTS(SELECT 1 FROM normalized_battles x WHERE x.first_observed_fetch_run_id = dfr.id) AS refBattle,
            EXISTS(SELECT 1 FROM canonical_brawlers x WHERE x.last_fetch_run_id = dfr.id) AS refBrawler,
            EXISTS(SELECT 1 FROM normalized_players x WHERE x.last_fetch_run_id = dfr.id) AS refPlayer,
            EXISTS(SELECT 1 FROM normalized_clubs x WHERE x.last_fetch_run_id = dfr.id) AS refClub,
            EXISTS(SELECT 1 FROM data_incidents x WHERE x.related_fetch_run_id = dfr.id) AS refIncident,
            EXISTS(SELECT 1 FROM data_fetch_runs x WHERE x.retry_of_fetch_run_id = dfr.id) AS refRetry
       FROM data_fetch_runs dfr
      WHERE dfr.started_at < ?
      ORDER BY dfr.id ASC LIMIT ?`,
    [cutoff, scanLimit]
  );
  const refReason: Record<string, string> = {
    refRaw: "referenced_by_raw_snapshot", refObs: "referenced_by_battle_observation",
    refBattle: "referenced_by_normalized_battle", refBrawler: "referenced_by_canonical_brawler",
    refPlayer: "referenced_by_normalized_player", refClub: "referenced_by_normalized_club",
    refIncident: "referenced_by_data_incident", refRetry: "referenced_by_retry_chain",
  };
  const candidates: AnchorCandidate[] = [];
  const skipped: AnchorSkip[] = [];
  for (const r of rows) {
    const id = r.anchorId as string;
    const hit = Object.keys(refReason).find((k) => Number(r[k]) === 1);
    if (hit) skipped.push({ anchorId: id, reason: refReason[hit] });
    else candidates.push({ anchorId: id, naturalKey: { id }, ts: r.ts ? new Date(r.ts) : null });
  }
  return makePlan("fetch_audit", scanLimit, now, candidates, skipped, FETCH_AUDIT.hotDays);
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

interface ArchiveColumn { name: string; sqlType: string; nullable: boolean }
async function getColumns(db: Queryable, table: string): Promise<ArchiveColumn[]> {
  assertGraphTable(table);
  const [rows] = await db.query<RowDataPacket[]>(`SHOW COLUMNS FROM \`${table}\``);
  return rows.map((r) => ({ name: String(r.Field), sqlType: String(r.Type).toLowerCase(), nullable: String(r.Null).toUpperCase() === "YES" }));
}

function inClause(ids: string[]): { sql: string; params: string[] } {
  return { sql: ids.map(() => "?").join(","), params: ids };
}

async function selectAnchorRows(db: Queryable, table: string, ids: string[]): Promise<Record<string, unknown>[]> {
  assertGraphTable(table);
  if (ids.length === 0) return [];
  const { sql, params } = inClause(ids);
  const [rows] = await db.query<RowDataPacket[]>(`SELECT * FROM \`${table}\` WHERE id IN (${sql}) ORDER BY id ASC`, params);
  return rows as Record<string, unknown>[];
}

async function selectChildRows(db: Queryable, table: string, fkColumn: string, anchorIds: string[]): Promise<Record<string, unknown>[]> {
  assertGraphTable(table); assertColumn(fkColumn);
  if (anchorIds.length === 0) return [];
  const { sql, params } = inClause(anchorIds);
  const out: Record<string, unknown>[] = [];
  let after = "";
  for (;;) {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT * FROM \`${table}\` WHERE \`${fkColumn}\` IN (${sql}) AND id > ? ORDER BY id ASC LIMIT ?`,
      [...params, after, EXPORT_PAGE]
    );
    if (rows.length === 0) break;
    out.push(...(rows as Record<string, unknown>[]));
    after = String(rows[rows.length - 1].id);
    if (rows.length < EXPORT_PAGE) break;
  }
  return out;
}

export interface GraphArchiveDocument {
  format: string;
  schemaVersion: string;
  family: string;
  anchorTable: string;
  archiveKey: string;
  createdAt: string;
  anchorIds: string[];
  naturalKeys: Record<string, unknown>[];
  sourceRefs: string[];
  minTs: string | null;
  maxTs: string | null;
  rowCountsByTable: Record<string, number>;
  tables: { table: string; columns: ArchiveColumn[]; rows: Record<string, unknown>[] }[];
}

export function computeArchiveKey(family: string, anchorIds: string[]): string {
  const sorted = [...anchorIds].sort();
  return `${family}/${createHash("sha256").update(sorted.join(",")).digest("hex").slice(0, 32)}`;
}
function objectKeyForArchiveKey(archiveKey: string): string {
  return `retention/graph/v1/${archiveKey}.json.gz`;
}

export interface ArchiveResult {
  manifestId: string; family: string; archiveKey: string; objectKey: string;
  anchorCount: number; rowCountsByTable: Record<string, number>;
  originalSha256: string; archiveSha256: string; uncompressedBytes: number; archiveBytes: number; idempotent: boolean;
}

/** Archive a bounded, explicit set of anchor ids + their complete child graph into ONE immutable object + manifest. */
export async function archiveGraphBatch(
  db: Queryable, provider: ObjectStorageProvider, family: GraphFamily,
  anchorIds: string[], opts: { bucket: string; now?: Date }
): Promise<ArchiveResult> {
  if (anchorIds.length === 0) throw new Error("archive_empty_anchor_set");
  if (anchorIds.some((id) => !UUID_RE.test(id))) throw new Error("archive_invalid_anchor_id");
  const sortedIds = [...new Set(anchorIds)].sort();
  const archiveKey = computeArchiveKey(family.family, sortedIds);
  const objectKey = objectKeyForArchiveKey(archiveKey);

  const existing = await getGraphManifestByKey(db, family.family, archiveKey);
  if (existing) {
    const bytes = await provider.getObject(existing.object_bucket, existing.object_key);
    const check = verifyGraphBytesAgainstManifest(bytes, existing);
    if (!check.passed) throw new Error(`existing_graph_manifest_mismatch:${check.failureReason}`);
    return {
      manifestId: existing.id, family: family.family, archiveKey, objectKey: existing.object_key,
      anchorCount: Number(existing.anchor_count), rowCountsByTable: JSON.parse(existing.row_counts),
      originalSha256: existing.original_sha256, archiveSha256: existing.archive_sha256,
      uncompressedBytes: Number(existing.uncompressed_bytes), archiveBytes: Number(existing.archive_bytes), idempotent: true,
    };
  }

  // Anchor rows + every child row for those anchors.
  const anchorRows = await selectAnchorRows(db, family.anchorTable, sortedIds);
  if (anchorRows.length !== sortedIds.length) throw new Error("archive_anchor_row_count_mismatch");
  const anchorColumns = await getColumns(db, family.anchorTable);
  const tables: GraphArchiveDocument["tables"] = [{ table: family.anchorTable, columns: anchorColumns, rows: anchorRows }];
  const rowCountsByTable: Record<string, number> = { [family.anchorTable]: anchorRows.length };
  for (const child of family.children) {
    const rows = await selectChildRows(db, child.table, child.fkColumn, sortedIds);
    const columns = await getColumns(db, child.table);
    tables.push({ table: child.table, columns, rows });
    rowCountsByTable[child.table] = rows.length;
  }

  // Natural keys, source refs, timestamp range.
  const naturalKeys = anchorRows.map((r) => Object.fromEntries(family.naturalKeyColumns.map((c) => [c, r[c]])));
  const sourceRefs = new Set<string>();
  for (const ref of family.sourceRefs) {
    const t = tables.find((x) => x.table === ref.table);
    if (!t) continue;
    for (const row of t.rows) { const v = row[ref.column]; if (v != null) sourceRefs.add(String(v)); }
  }
  const times = anchorRows.map((r) => (r[family.timeColumn] ? new Date(String(r[family.timeColumn])) : null)).filter((d): d is Date => Boolean(d && !Number.isNaN(d.getTime())));
  const minTs = times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null;
  const maxTs = times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;

  const document: GraphArchiveDocument = {
    format: GRAPH_ARCHIVE_FORMAT, schemaVersion: GRAPH_ARCHIVE_SCHEMA_VERSION,
    family: family.family, anchorTable: family.anchorTable, archiveKey,
    createdAt: (opts.now ?? new Date()).toISOString(),
    anchorIds: sortedIds, naturalKeys, sourceRefs: [...sourceRefs].sort(),
    minTs: minTs?.toISOString() ?? null, maxTs: maxTs?.toISOString() ?? null,
    rowCountsByTable, tables,
  };
  const json = canonicalJson(document);
  const originalSha256 = sha256Hex(Buffer.from(json, "utf8"));
  const gz = gzipPayload(json);

  await provider.putObject({
    bucket: opts.bucket, key: objectKey, body: gz.compressed, contentType: "application/gzip",
    metadata: { family: family.family, "archive-key": archiveKey, "schema-version": GRAPH_ARCHIVE_SCHEMA_VERSION,
      "anchor-count": String(sortedIds.length), "original-sha256": originalSha256, "object-sha256": gz.objectChecksum },
  });
  const head = await provider.headObject(opts.bucket, objectKey);
  if (!head || head.size !== gz.objectSize) throw new Error("graph_archive_head_mismatch");

  const manifestId = await insertGraphManifest(db, {
    family: family.family, archiveKey, formatVersion: GRAPH_ARCHIVE_FORMAT, schemaVersion: GRAPH_ARCHIVE_SCHEMA_VERSION,
    anchorTable: family.anchorTable, anchorCount: sortedIds.length, rowCounts: rowCountsByTable,
    naturalKeys, sourceRefs: [...sourceRefs].sort(), minTs, maxTs,
    uncompressedBytes: gz.originalSize, archiveBytes: gz.objectSize, originalSha256, archiveSha256: gz.objectChecksum,
    objectProvider: provider.name, objectBucket: opts.bucket, objectKey,
  });
  return {
    manifestId, family: family.family, archiveKey, objectKey, anchorCount: sortedIds.length, rowCountsByTable,
    originalSha256, archiveSha256: gz.objectChecksum, uncompressedBytes: gz.originalSize, archiveBytes: gz.objectSize, idempotent: false,
  };
}

// ---------------------------------------------------------------------------
// Verify (>=2 independent passes)
// ---------------------------------------------------------------------------

export type GraphVerificationFailure =
  | "object_missing" | "object_size_mismatch" | "archive_checksum_mismatch" | "corrupt_gzip"
  | "content_checksum_mismatch" | "invalid_json" | "unsupported_version" | "manifest_mismatch"
  | "row_count_mismatch" | "fk_closure_violation" | "anchor_set_mismatch" | "missing_child_table";

export interface GraphVerificationPass {
  passNumber: number; passed: boolean; failureReason: GraphVerificationFailure | null;
  objectSize: number | null; archiveSha256: string | null; originalSha256: string | null; rowCount: number | null;
}

export function verifyGraphBytesAgainstManifest(bytes: Buffer, m: RowDataPacket, passNumber = 1): GraphVerificationPass {
  const base = { passNumber, objectSize: bytes.byteLength, archiveSha256: sha256Hex(bytes), originalSha256: null as string | null, rowCount: null as number | null };
  if (bytes.byteLength !== Number(m.archive_bytes)) return { ...base, passed: false, failureReason: "object_size_mismatch" };
  if (base.archiveSha256 !== m.archive_sha256) return { ...base, passed: false, failureReason: "archive_checksum_mismatch" };
  let json: string;
  try { json = gunzipToString(bytes); } catch { return { ...base, passed: false, failureReason: "corrupt_gzip" }; }
  const originalSha256 = sha256Hex(Buffer.from(json, "utf8"));
  if (originalSha256 !== m.original_sha256) return { ...base, originalSha256, passed: false, failureReason: "content_checksum_mismatch" };
  let doc: GraphArchiveDocument;
  try { doc = JSON.parse(json) as GraphArchiveDocument; } catch { return { ...base, originalSha256, passed: false, failureReason: "invalid_json" }; }
  if (doc.format !== GRAPH_ARCHIVE_FORMAT || doc.schemaVersion !== GRAPH_ARCHIVE_SCHEMA_VERSION) return { ...base, originalSha256, passed: false, failureReason: "unsupported_version" };
  if (doc.family !== m.family || doc.archiveKey !== m.archive_key || doc.anchorTable !== m.anchor_table) return { ...base, originalSha256, passed: false, failureReason: "manifest_mismatch" };

  const anchorSet = new Set(doc.anchorIds);
  if (anchorSet.size !== doc.anchorIds.length || doc.anchorIds.length !== Number(m.anchor_count)) return { ...base, originalSha256, passed: false, failureReason: "anchor_set_mismatch" };

  const manifestCounts: Record<string, number> = JSON.parse(m.row_counts);
  let totalRows = 0;
  const anchorTableSpec = doc.tables.find((t) => t.table === doc.anchorTable);
  if (!anchorTableSpec) return { ...base, originalSha256, passed: false, failureReason: "missing_child_table" };
  for (const [table, expected] of Object.entries(manifestCounts)) {
    const t = doc.tables.find((x) => x.table === table);
    if (!t) return { ...base, originalSha256, rowCount: totalRows, passed: false, failureReason: "missing_child_table" };
    if (t.rows.length !== expected) return { ...base, originalSha256, rowCount: t.rows.length, passed: false, failureReason: "row_count_mismatch" };
    totalRows += t.rows.length;
  }
  // Anchor row identity set must equal the archived anchor id set.
  const anchorRowIds = new Set(anchorTableSpec.rows.map((r) => String(r.id)));
  if (anchorRowIds.size !== anchorSet.size || [...anchorSet].some((id) => !anchorRowIds.has(id))) {
    return { ...base, originalSha256, rowCount: totalRows, passed: false, failureReason: "anchor_set_mismatch" };
  }
  // FK closure: every child row's fk points at an archived anchor (no missing child / orphan).
  const fam = GRAPH_FAMILIES[doc.family];
  if (fam) {
    for (const child of fam.children) {
      const t = doc.tables.find((x) => x.table === child.table);
      if (!t) return { ...base, originalSha256, rowCount: totalRows, passed: false, failureReason: "missing_child_table" };
      for (const row of t.rows) {
        if (!anchorSet.has(String(row[child.fkColumn]))) return { ...base, originalSha256, rowCount: totalRows, passed: false, failureReason: "fk_closure_violation" };
      }
    }
  }
  return { ...base, originalSha256, rowCount: totalRows, passed: true, failureReason: null };
}

export interface GraphVerifyResult { verified: boolean; passes: GraphVerificationPass[] }
export async function verifyGraphArchive(db: Queryable, provider: ObjectStorageProvider, family: string, archiveKey: string): Promise<GraphVerifyResult> {
  const m = await getGraphManifestByKey(db, family, archiveKey);
  if (!m) throw new Error("no_graph_manifest");
  const passes: GraphVerificationPass[] = [];
  for (const passNumber of [1, 2]) {
    let pass: GraphVerificationPass;
    try {
      const bytes = await provider.getObject(m.object_bucket, m.object_key);
      pass = verifyGraphBytesAgainstManifest(bytes, m, passNumber);
    } catch {
      pass = { passNumber, passed: false, failureReason: "object_missing", objectSize: null, archiveSha256: null, originalSha256: null, rowCount: null };
    }
    await recordGraphVerificationEvidence(db, m.id, pass);
    passes.push(pass);
  }
  const verified = passes.every((p) => p.passed);
  await setGraphManifestVerification(db, m.id, verified ? "verified" : "failed", passes.filter((p) => p.passed).length, passes);
  return { verified, passes };
}

// ---------------------------------------------------------------------------
// Staging re-import proof (restore + FK/replay). Requires a real DB (temp tables).
// ---------------------------------------------------------------------------

function valueForSql(column: ArchiveColumn, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (/^(datetime|timestamp)/i.test(column.sqlType) && typeof value === "string") return new Date(value);
  if (value && typeof value === "object" && "$binaryBase64" in (value as Record<string, unknown>)) {
    return Buffer.from(String((value as Record<string, unknown>).$binaryBase64), "base64");
  }
  return value;
}

export interface GraphReimportResult {
  ok: boolean; perTable: Record<string, { rowCountMatch: boolean; contentChecksumMatch: boolean; fkClosure: boolean; rows: number }>;
  idempotent: boolean;
}

export async function reimportGraphArchive(db: Queryable, provider: ObjectStorageProvider, family: string, archiveKey: string, forceProof = false): Promise<GraphReimportResult> {
  const m = await getGraphManifestByKey(db, family, archiveKey);
  if (!m) throw new Error("no_graph_manifest");
  if (m.verification_status !== "verified" || Number(m.verification_count) < 2) throw new Error("archive_not_double_verified");
  if (m.staging_reimport_status === "passed" && !forceProof) {
    const saved = typeof m.staging_reimport_result === "string" ? JSON.parse(m.staging_reimport_result) : m.staging_reimport_result;
    return { ...(saved as GraphReimportResult), idempotent: true };
  }
  const bytes = await provider.getObject(m.object_bucket, m.object_key);
  const validation = verifyGraphBytesAgainstManifest(bytes, m, 1);
  if (!validation.passed) throw new Error(`archive_validation_failed:${validation.failureReason}`);
  const doc = JSON.parse(gunzipToString(bytes)) as GraphArchiveDocument;
  const anchorSet = new Set(doc.anchorIds);
  const fam = GRAPH_FAMILIES[doc.family];

  const perTable: GraphReimportResult["perTable"] = {};
  const staging: string[] = [];
  try {
    for (const t of doc.tables) {
      assertGraphTable(t.table);
      const stage = `_p14_${t.table.slice(0, 24)}_${Math.random().toString(36).slice(2, 10)}`;
      staging.push(stage);
      await db.query(`CREATE TEMPORARY TABLE \`${stage}\` LIKE \`${t.table}\``);
      const names = t.columns.map((c) => c.name);
      const byName = new Map(t.columns.map((c) => [c.name, c]));
      let inserted = 0;
      for (let i = 0; i < t.rows.length; i += 250) {
        const chunk = t.rows.slice(i, i + 250);
        if (chunk.length === 0) break;
        const placeholders = chunk.map(() => `(${names.map(() => "?").join(",")})`).join(",");
        const params = chunk.flatMap((row) => names.map((n) => valueForSql(byName.get(n)!, row[n])));
        const [w] = await db.query<ResultSetHeader>(`INSERT INTO \`${stage}\` (${names.map((n) => `\`${n}\``).join(",")}) VALUES ${placeholders}`, params);
        inserted += w.affectedRows;
      }
      const [[counts]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) n FROM \`${stage}\``);
      const [restored] = await db.query<RowDataPacket[]>(`SELECT * FROM \`${stage}\` ORDER BY id ASC`);
      const archivedSorted = [...t.rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const contentChecksumMatch = sha256Hex(canonicalJson(restored)) === sha256Hex(canonicalJson(archivedSorted));
      let fkClosure = true;
      const childSpec = fam?.children.find((c) => c.table === t.table);
      if (childSpec) fkClosure = (restored as RowDataPacket[]).every((r) => anchorSet.has(String(r[childSpec.fkColumn])));
      perTable[t.table] = { rowCountMatch: Number(counts.n) === t.rows.length && inserted === t.rows.length, contentChecksumMatch, fkClosure, rows: inserted };
    }
  } finally {
    for (const stage of staging) await db.query(`DROP TEMPORARY TABLE IF EXISTS \`${stage}\``).catch(() => {});
  }
  const ok = Object.values(perTable).every((t) => t.rowCountMatch && t.contentChecksumMatch && t.fkClosure);
  const result: GraphReimportResult = { ok, perTable, idempotent: false };
  await setGraphManifestReimport(db, m.id, ok ? "passed" : "failed", result);
  return result;
}

// ---------------------------------------------------------------------------
// Deletion (archive-gated, allowlisted, FK-ordered, bounded, resumable)
// ---------------------------------------------------------------------------

export type GraphDeletionBlock =
  | "not_verified" | "verification_evidence_missing" | "reimport_not_passed"
  | "allowlist_mismatch" | "eligibility_changed";

export interface GraphDeleteResult {
  family: string; archiveKey: string; manifestId: string; dryRun: boolean; proceeded: boolean;
  blockedReason?: GraphDeletionBlock; deletedByTable: Record<string, number>; batches: number;
}

export function validateAnchorAllowlist(values: string[]): string[] {
  if (!Array.isArray(values) || values.length === 0) throw new Error("missing_allowlist");
  if (values.some((v) => v === "*" || v.toLowerCase() === "all" || !UUID_RE.test(v))) throw new Error("invalid_allowlist");
  return [...new Set(values)].sort();
}

async function anchorsStillEligible(db: Queryable, family: GraphFamily, anchorIds: string[], now: Date): Promise<boolean> {
  // Re-run the family plan (bounded to these ids) and require ALL are still eligible candidates.
  const plan = await planFamily(db, family, { now, scanLimit: 50_000 });
  const eligible = new Set(plan.candidates.map((c) => c.anchorId));
  return anchorIds.every((id) => eligible.has(id));
}

/**
 * Deletes ONE archived batch's rows, FK-safe order, bounded per-table batches,
 * gated on a double-verified + reimport-passed manifest, with an EXPLICIT
 * allowlist that must equal the archived anchor set. Re-checks eligibility under
 * the parent lock; records a per-table/per-batch deletion manifest (resumable).
 */
export async function deleteGraphBatch(
  db: Pool, family: GraphFamily, archiveKey: string,
  opts: { allowlist: string[]; dryRun?: boolean; deleteBatchSize?: number; now?: Date }
): Promise<GraphDeleteResult> {
  const dryRun = opts.dryRun ?? true;
  const now = opts.now ?? new Date();
  const m = await getGraphManifestByKey(db, family.family, archiveKey);
  if (!m) throw new Error("no_graph_manifest");
  const base: GraphDeleteResult = { family: family.family, archiveKey, manifestId: m.id, dryRun, proceeded: false, deletedByTable: {}, batches: 0 };

  const allowlist = validateAnchorAllowlist(opts.allowlist);
  // The archive_key is sha256(sorted anchor ids); a matching key (and count)
  // proves the allowlist IS exactly the archived anchor set — tamper-evident,
  // no need to trust a mutable id column.
  if (computeArchiveKey(family.family, allowlist) !== m.archive_key || allowlist.length !== Number(m.anchor_count)) {
    return { ...base, blockedReason: "allowlist_mismatch" };
  }
  if (m.verification_status !== "verified" || Number(m.verification_count) < 2) return { ...base, blockedReason: "not_verified" };
  if (await countPassedGraphEvidence(db, m.id) < 2) return { ...base, blockedReason: "verification_evidence_missing" };
  if (m.staging_reimport_status !== "passed") return { ...base, blockedReason: "reimport_not_passed" };
  if (!(await anchorsStillEligible(db, family, allowlist, now))) return { ...base, blockedReason: "eligibility_changed" };

  if (dryRun) return { ...base, proceeded: true };

  const batchSize = Math.min(Math.max(1, opts.deleteBatchSize ?? DEFAULT_DELETE_BATCH), MAX_DELETE_BATCH);
  const deletedByTable: Record<string, number> = {};
  let batches = 0;
  // FK-safe order: children first, anchor last. Each table drained in bounded batches.
  for (const table of family.deleteOrder) {
    assertGraphTable(table);
    const isAnchor = table === family.anchorTable;
    const fkColumn = isAnchor ? "id" : (family.children.find((c) => c.table === table)?.fkColumn ?? "id");
    let cursor: string | null = null;
    let tableDeleted = 0;
    for (;;) {
      const conn = await db.getConnection();
      let deleted = 0;
      try {
        await conn.beginTransaction();
        // Re-check eligibility for the whole set under the lock on the first batch of the first table.
        const batch = await deleteScopedBatch(conn, table, fkColumn, allowlist, batchSize, cursor);
        deleted = batch.deleted;
        if (deleted > 0) {
          batches += 1;
          cursor = batch.maxPk;
          await recordGraphDeletionBatch(conn, { family: family.family, manifestId: m.id, tableName: table,
            batchNumber: batches, batchCursor: cursor, attemptedRows: deleted, rowsDeleted: deleted,
            minPk: batch.minPk, maxPk: batch.maxPk, dryRun: false, status: "completed" });
        }
        await conn.commit();
      } catch (error) {
        await conn.rollback().catch(() => {});
        await recordGraphDeletionBatch(db, { family: family.family, manifestId: m.id, tableName: table,
          batchNumber: batches + 1, batchCursor: cursor, attemptedRows: 0, rowsDeleted: 0, minPk: null, maxPk: null,
          dryRun: false, status: "failed", failureReason: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
        throw error;
      } finally { conn.release(); }
      tableDeleted += deleted;
      if (deleted < batchSize) break;
    }
    deletedByTable[table] = tableDeleted;
  }
  return { ...base, proceeded: true, deletedByTable, batches };
}

async function deleteScopedBatch(
  db: Queryable, table: string, fkColumn: string, anchorIds: string[], batchSize: number, afterPk: string | null
): Promise<{ deleted: number; minPk: string | null; maxPk: string | null }> {
  assertGraphTable(table); assertColumn(fkColumn);
  const { sql, params } = inClause(anchorIds);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id FROM \`${table}\` WHERE \`${fkColumn}\` IN (${sql}) AND id > ? ORDER BY id ASC LIMIT ?`,
    [...params, afterPk ?? "", batchSize]
  );
  if (rows.length === 0) return { deleted: 0, minPk: null, maxPk: null };
  const ids = rows.map((r) => String(r.id));
  const del = inClause(ids);
  const [res] = await db.execute<ResultSetHeader>(`DELETE FROM \`${table}\` WHERE id IN (${del.sql})`, del.params);
  return { deleted: res.affectedRows, minPk: ids[0], maxPk: ids[ids.length - 1] };
}

// ---------------------------------------------------------------------------
// Manifest data access
// ---------------------------------------------------------------------------

interface InsertGraphManifestInput {
  family: string; archiveKey: string; formatVersion: string; schemaVersion: string; anchorTable: string;
  anchorCount: number; rowCounts: Record<string, number>; naturalKeys: unknown; sourceRefs: unknown;
  minTs: Date | null; maxTs: Date | null; uncompressedBytes: number; archiveBytes: number;
  originalSha256: string; archiveSha256: string; objectProvider: string; objectBucket: string; objectKey: string;
}
async function insertGraphManifest(db: Queryable, m: InsertGraphManifestInput): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO retention_graph_manifests
       (id, family, archive_key, format_version, schema_version, anchor_table, anchor_count, row_counts,
        natural_keys, source_refs, min_ts, max_ts, uncompressed_bytes, archive_bytes, original_sha256, archive_sha256,
        object_provider, object_bucket, object_key, verification_status, verification_count, staging_reimport_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending', 0, 'pending')`,
    [id, m.family, m.archiveKey, m.formatVersion, m.schemaVersion, m.anchorTable, m.anchorCount, JSON.stringify(m.rowCounts),
     JSON.stringify(m.naturalKeys), JSON.stringify(m.sourceRefs), m.minTs, m.maxTs, m.uncompressedBytes, m.archiveBytes,
     m.originalSha256, m.archiveSha256, m.objectProvider, m.objectBucket, m.objectKey]
  );
  return id;
}
export async function getGraphManifestByKey(db: Queryable, family: string, archiveKey: string): Promise<RowDataPacket | null> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT * FROM retention_graph_manifests WHERE family = ? AND archive_key = ?", [family, archiveKey]);
  return rows[0] ?? null;
}
async function setGraphManifestVerification(db: Queryable, id: string, status: string, count: number, results: unknown): Promise<void> {
  await db.execute(
    "UPDATE retention_graph_manifests SET verification_status = ?, verification_count = ?, verification_results = ?, verified_at = IF(? = 'verified', UTC_TIMESTAMP(3), verified_at) WHERE id = ?",
    [status, count, results === null ? null : JSON.stringify(results), status, id]
  );
}
async function setGraphManifestReimport(db: Queryable, id: string, status: string, result: unknown): Promise<void> {
  await db.execute("UPDATE retention_graph_manifests SET staging_reimport_status = ?, staging_reimport_result = ? WHERE id = ?",
    [status, result === null ? null : JSON.stringify(result), id]);
}
async function recordGraphVerificationEvidence(db: Queryable, manifestId: string, p: GraphVerificationPass): Promise<void> {
  await db.execute(
    `INSERT INTO retention_graph_verification_evidence
       (id, manifest_id, pass_number, object_size, archive_sha256, original_sha256, row_count, result, failure_reason)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [randomUUID(), manifestId, p.passNumber, p.objectSize, p.archiveSha256, p.originalSha256, p.rowCount, p.passed ? "passed" : "failed", p.failureReason]
  );
}
export async function countPassedGraphEvidence(db: Queryable, manifestId: string): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT COUNT(DISTINCT pass_number) n FROM retention_graph_verification_evidence WHERE manifest_id = ? AND result = 'passed'", [manifestId]);
  return Number(rows[0].n);
}
interface GraphDeletionBatchInput {
  family: string; manifestId: string | null; tableName: string; batchNumber: number; batchCursor: string | null;
  attemptedRows: number; rowsDeleted: number; minPk: string | null; maxPk: string | null; dryRun: boolean;
  status: "planned" | "completed" | "failed"; failureReason?: string | null;
}
async function recordGraphDeletionBatch(db: Queryable, b: GraphDeletionBatchInput): Promise<void> {
  await db.execute(
    `INSERT INTO retention_graph_deletion_manifests
       (id, family, manifest_id, table_name, batch_number, batch_cursor, attempted_rows, rows_deleted, min_pk, max_pk, dry_run, status, completed_at, failure_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, IF(? = 'completed', UTC_TIMESTAMP(3), NULL), ?)
     ON DUPLICATE KEY UPDATE batch_cursor=VALUES(batch_cursor), attempted_rows=VALUES(attempted_rows),
       rows_deleted=VALUES(rows_deleted), min_pk=VALUES(min_pk), max_pk=VALUES(max_pk), status=VALUES(status),
       completed_at=VALUES(completed_at), failure_reason=VALUES(failure_reason)`,
    [randomUUID(), b.family, b.manifestId, b.tableName, b.batchNumber, b.batchCursor, b.attemptedRows, b.rowsDeleted,
     b.minPk, b.maxPk, b.dryRun ? 1 : 0, b.status, b.status, b.failureReason ?? null]
  );
}

// ---------------------------------------------------------------------------
// Safety gates + orchestrator
// ---------------------------------------------------------------------------

export function isDestructiveEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.RETENTION_DESTRUCTIVE_ENABLED === "true";
}
/** Production-environment guard: destructive graph retention only runs where the env is explicitly marked isolated/disposable. */
export function assertDestructiveAllowed(env: Record<string, string | undefined> = process.env): void {
  if (!isDestructiveEnabled(env)) throw new Error("destructive_flag_required");
  if (env.RETENTION_ENVIRONMENT !== "isolated_staging") throw new Error("production_guard_block");
}

export type GraphAction = "plan" | "archive" | "verify" | "reimport" | "delete";
export interface GraphOperationOptions {
  family: string;
  action?: GraphAction;
  allowlist?: string[];
  bucket?: string;
  environmentId?: string;
  anchorBatchSize?: number;
  deleteBatchSize?: number;
  scanLimit?: number;
  now?: Date;
  env?: Record<string, string | undefined>;
}

/**
 * The single entry point. `plan` is read-only and always allowed. archive/verify/
 * reimport/delete acquire the graph lock and, for the destructive ones, enforce
 * the flag + production guard + isolated-staging attestation. archive processes
 * ONE bounded anchor batch (the plan's first N eligible ids) so the caller drives
 * batches; delete/reimport act on a specific archived batch (archiveKey).
 */
export async function runGraphRetention(db: Pool, provider: ObjectStorageProvider | null, opts: GraphOperationOptions) {
  const family = getFamily(opts.family);
  const action = opts.action ?? "plan";
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();

  if (action === "plan") {
    const plan = await planFamily(db, family, { scanLimit: opts.scanLimit, now });
    return { ok: true, family: family.family, action, dryRun: true, writes: 0, plan };
  }

  const workflowDefinitionId = await ensureWorkflowDefinition(db, LOCK_SLUG, "scheduled_sync");
  const lockRunId = randomUUID();
  const lock = await acquireWorkflowLock(db, workflowDefinitionId, lockRunId, LOCK_TTL_MS);
  if (!lock.acquired) return { ok: false, family: family.family, action, outcome: "lock_not_acquired" };

  try {
    if (action === "archive") {
      if (!provider || !opts.bucket) throw new Error("archive_storage_required");
      const plan = await planFamily(db, family, { scanLimit: opts.scanLimit, now });
      const batch = plan.candidates.slice(0, Math.min(Math.max(1, opts.anchorBatchSize ?? DEFAULT_ANCHOR_BATCH), MAX_ANCHOR_BATCH)).map((c) => c.anchorId);
      if (batch.length === 0) return { ok: true, family: family.family, action, archived: null, note: "no_eligible_anchors" };
      const result = await archiveGraphBatch(db, provider, family, batch, { bucket: opts.bucket, now });
      return { ok: true, family: family.family, action, archived: result };
    }
    if (action === "verify") {
      if (!provider) throw new Error("archive_storage_required");
      if (!opts.allowlist) throw new Error("archive_key_or_allowlist_required");
      const archiveKey = computeArchiveKey(family.family, validateAnchorAllowlist(opts.allowlist));
      return { ok: true, family: family.family, action, verify: await verifyGraphArchive(db, provider, family.family, archiveKey) };
    }
    if (action === "reimport") {
      if (!provider) throw new Error("archive_storage_required");
      assertDestructiveAllowed(env); // staging writes (temp tables) — gate like a destructive op
      if (!(await hasIsolatedStagingAttestation(db, opts.environmentId))) throw new Error("isolated_staging_attestation_required");
      if (!opts.allowlist) throw new Error("allowlist_required");
      const archiveKey = computeArchiveKey(family.family, validateAnchorAllowlist(opts.allowlist));
      return { ok: true, family: family.family, action, reimport: await reimportGraphArchive(db, provider, family.family, archiveKey) };
    }
    // delete
    assertDestructiveAllowed(env);
    if (!(await hasIsolatedStagingAttestation(db, opts.environmentId))) throw new Error("isolated_staging_attestation_required");
    if (!opts.allowlist) throw new Error("allowlist_required");
    const archiveKey = computeArchiveKey(family.family, validateAnchorAllowlist(opts.allowlist));
    const result = await deleteGraphBatch(db, family, archiveKey, { allowlist: opts.allowlist, dryRun: false, deleteBatchSize: opts.deleteBatchSize, now });
    return { ok: true, family: family.family, action, delete: result };
  } finally {
    await releaseWorkflowLock(db, workflowDefinitionId, lockRunId);
  }
}
