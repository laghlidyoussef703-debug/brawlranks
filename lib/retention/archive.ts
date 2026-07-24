/** DATASET Phase 5 portable gzip+canonical-JSON archive and proof pipeline. */
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { gzipPayload, gunzipToString, sha256Hex } from "@/lib/archive/codec";
import type { ObjectStorageProvider } from "@/lib/archive/provider";
import {
  selectChildRowsAfter, insertArchivedRunManifest, setManifestVerification,
  setManifestReimport, getArchivedRunManifest, getArchiveColumns,
  recordVerificationEvidence, type ArchiveColumn, type ChildRow,
} from "./repository";
import type { RunKind } from "./eligibility";

type Queryable = Pool | PoolConnection;
export const RETENTION_ARCHIVE_SCHEMA_VERSION = "1";
export const RETENTION_ARCHIVE_FORMAT = "brawlranks-retention-archive/v1";
const EXPORT_PAGE = 2000;
const TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  brawler_mode_aggregates: ["id","aggregation_run_id","brawler_id","game_mode_id","patch_id","matches","wins","losses","draws","win_rate","latest_battle_at","pick_rate","rank_bracket_breakdown","region_breakdown","data_maturity_stage","created_at"],
  brawler_overall_aggregates: ["id","aggregation_run_id","brawler_id","patch_id","matches","wins","losses","draws","win_rate","latest_battle_at","mode_coverage_count","created_at"],
  matchup_aggregates: ["id","aggregation_run_id","brawler_id","opponent_brawler_id","game_mode_id","patch_id","matches","wins","losses","win_rate","latest_battle_at","confidence_level","created_at"],
  ranking_results: ["id","ranking_run_id","brawler_id","game_mode_id","matches","win_rate","pick_rate","high_rank_win_rate","matchup_coverage","meta_score","tier","confidence","meets_floor","created_at"],
  matchup_results: ["id","ranking_run_id","brawler_id","opponent_brawler_id","game_mode_id","matches","win_rate","relationship","confidence_level","meets_floor","created_at"],
});

export function buildRetentionKey(runKind: RunKind, runId: string, sourceTable: string): string {
  if (!/^[a-z_]+$/.test(sourceTable)) throw new Error(`unsafe source table: ${sourceTable}`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    throw new Error(`unsafe run id: ${runId}`);
  }
  return `retention/v1/${runKind}/${runId}/${sourceTable}.json.gz`;
}

function normalized(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { $binaryBase64: value.toString("base64") };
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalized(v)]));
  }
  return value;
}

/** Stable across object-key insertion order and Date/Buffer driver values. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalized(value));
}

export interface RetentionArchiveDocument {
  format: string;
  schemaVersion: string;
  runKind: RunKind;
  runId: string;
  sourceTable: string;
  columns: ArchiveColumn[];
  rowCount: number;
  createdAt: string;
  rows: Record<string, unknown>[];
}

export function serializeArchiveDocument(doc: RetentionArchiveDocument): string {
  return canonicalJson(doc);
}

async function readAllChildRows(db: Queryable, table: string, runId: string): Promise<ChildRow[]> {
  const all: ChildRow[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await selectChildRowsAfter(db, table, runId, after, EXPORT_PAGE);
    if (!page.length) break;
    all.push(...page);
    after = page.at(-1)!.id;
    if (page.length < EXPORT_PAGE) break;
  }
  return all;
}

export interface ExportContext {
  runKind: RunKind; runId: string; sourceTable: string; bucket: string;
  codeVersion?: string | null; ruleSetVersion?: string | null; patchContext?: string | null;
  createdAt?: Date;
}
export interface ExportResult {
  manifestId: string; objectKey: string; rowCount: number; originalSha256: string;
  archiveSha256: string; uncompressedBytes: number; archiveBytes: number; idempotent: boolean;
}

export async function exportRunToArchive(db: Queryable, provider: ObjectStorageProvider, ctx: ExportContext): Promise<ExportResult> {
  const existing = await getArchivedRunManifest(db, ctx.runKind, ctx.runId, ctx.sourceTable);
  if (existing) {
    const bytes = await provider.getObject(existing.object_bucket, existing.object_key);
    if (!verifyArchiveBytesAgainstManifest(bytes, existing, 1).passed) {
      throw new Error("existing_archive_manifest_mismatch");
    }
    return {
      manifestId: existing.id, objectKey: existing.object_key, rowCount: Number(existing.row_count),
      originalSha256: existing.original_sha256, archiveSha256: existing.archive_sha256,
      uncompressedBytes: Number(existing.uncompressed_bytes), archiveBytes: Number(existing.archive_bytes), idempotent: true,
    };
  }

  const rows = await readAllChildRows(db, ctx.sourceTable, ctx.runId);
  const columns = await getArchiveColumns(db, ctx.sourceTable);
  const document: RetentionArchiveDocument = {
    format: RETENTION_ARCHIVE_FORMAT, schemaVersion: RETENTION_ARCHIVE_SCHEMA_VERSION,
    runKind: ctx.runKind, runId: ctx.runId, sourceTable: ctx.sourceTable, columns,
    rowCount: rows.length, createdAt: (ctx.createdAt ?? new Date()).toISOString(), rows,
  };
  const json = serializeArchiveDocument(document);
  const gz = gzipPayload(json);
  const key = buildRetentionKey(ctx.runKind, ctx.runId, ctx.sourceTable);
  await provider.putObject({ bucket: ctx.bucket, key, body: gz.compressed, contentType: "application/gzip",
    metadata: { "run-kind": ctx.runKind, "run-id": ctx.runId, "source-table": ctx.sourceTable,
      "schema-version": RETENTION_ARCHIVE_SCHEMA_VERSION, "row-count": String(rows.length),
      "original-sha256": gz.originalChecksum, "object-sha256": gz.objectChecksum } });
  const head = await provider.headObject(ctx.bucket, key);
  if (!head || head.size !== gz.objectSize) throw new Error("retention_archive_head_mismatch");

  const times = rows.map((r) => r.created_at ? new Date(String(r.created_at)) : null)
    .filter((d): d is Date => Boolean(d && !Number.isNaN(d.getTime())));
  const manifestId = await insertArchivedRunManifest(db, {
    runKind: ctx.runKind, runId: ctx.runId, sourceTable: ctx.sourceTable,
    schemaVersion: RETENTION_ARCHIVE_SCHEMA_VERSION, rowCount: rows.length,
    minId: rows[0]?.id ?? null, maxId: rows.at(-1)?.id ?? null,
    minCreatedAt: times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null,
    maxCreatedAt: times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null,
    uncompressedBytes: gz.originalSize, archiveBytes: gz.objectSize,
    originalSha256: gz.originalChecksum, archiveSha256: gz.objectChecksum,
    codeVersion: ctx.codeVersion ?? null, ruleSetVersion: ctx.ruleSetVersion ?? null,
    patchContext: ctx.patchContext ?? null, objectProvider: provider.name, objectBucket: ctx.bucket, objectKey: key,
  });
  return { manifestId, objectKey: key, rowCount: rows.length, originalSha256: gz.originalChecksum,
    archiveSha256: gz.objectChecksum, uncompressedBytes: gz.originalSize, archiveBytes: gz.objectSize, idempotent: false };
}

export type VerificationFailure = "object_missing" | "object_size_mismatch" | "archive_checksum_mismatch" |
  "corrupt_gzip" | "invalid_json" | "unsupported_archive_version" | "manifest_mismatch" |
  "unexpected_schema" | "row_count_mismatch" | "duplicate_row_identity" | "content_checksum_mismatch";
export interface VerificationPassResult {
  passNumber: 1 | 2; passed: boolean; failureReason: VerificationFailure | null;
  objectSize: number | null; archiveSha256: string | null; originalSha256: string | null; rowCount: number | null;
}

export function verifyArchiveBytesAgainstManifest(bytes: Buffer, m: RowDataPacket, passNumber: 1 | 2): VerificationPassResult {
  const base = { passNumber, objectSize: bytes.byteLength, archiveSha256: sha256Hex(bytes), originalSha256: null, rowCount: null };
  if (bytes.byteLength !== Number(m.archive_bytes)) return { ...base, passed: false, failureReason: "object_size_mismatch" };
  if (base.archiveSha256 !== m.archive_sha256) return { ...base, passed: false, failureReason: "archive_checksum_mismatch" };
  let json: string;
  try { json = gunzipToString(bytes); } catch { return { ...base, passed: false, failureReason: "corrupt_gzip" }; }
  const originalSha256 = sha256Hex(Buffer.from(json, "utf8"));
  if (originalSha256 !== m.original_sha256) return { ...base, originalSha256, passed: false, failureReason: "content_checksum_mismatch" };
  let doc: RetentionArchiveDocument;
  try { doc = JSON.parse(json) as RetentionArchiveDocument; } catch { return { ...base, originalSha256, passed: false, failureReason: "invalid_json" }; }
  if (doc.format !== RETENTION_ARCHIVE_FORMAT || doc.schemaVersion !== RETENTION_ARCHIVE_SCHEMA_VERSION) {
    return { ...base, originalSha256, passed: false, failureReason: "unsupported_archive_version" };
  }
  if (doc.schemaVersion !== String(m.schema_version) || doc.runKind !== m.run_kind || doc.runId !== m.run_id ||
      doc.sourceTable !== m.source_table) return { ...base, originalSha256, passed: false, failureReason: "manifest_mismatch" };
  if (!Array.isArray(doc.columns) || !doc.columns.length || new Set(doc.columns.map((c) => c.name)).size !== doc.columns.length ||
      !doc.columns.some((c) => c.name === "id")) return { ...base, originalSha256, passed: false, failureReason: "unexpected_schema" };
  if (!Array.isArray(doc.rows) || doc.rowCount !== doc.rows.length || doc.rowCount !== Number(m.row_count)) {
    return { ...base, originalSha256, rowCount: Array.isArray(doc.rows) ? doc.rows.length : null, passed: false, failureReason: "row_count_mismatch" };
  }
  const names = doc.columns.map((c) => c.name).sort();
  const expected = TABLE_COLUMNS[doc.sourceTable];
  if (!expected || names.join("\0") !== [...expected].sort().join("\0")) {
    return { ...base, originalSha256, rowCount: doc.rows.length, passed: false, failureReason: "unexpected_schema" };
  }
  const ids = new Set<string>();
  const fk = doc.runKind === "aggregation_run" ? "aggregation_run_id" : "ranking_run_id";
  let priorId = "";
  for (const row of doc.rows) {
    if (!row || typeof row !== "object" || Object.keys(row).sort().join("\0") !== names.join("\0")) {
      return { ...base, originalSha256, rowCount: doc.rows.length, passed: false, failureReason: "unexpected_schema" };
    }
    if (typeof row.id !== "string" || ids.has(row.id)) return { ...base, originalSha256, rowCount: doc.rows.length, passed: false, failureReason: "duplicate_row_identity" };
    if (row[fk] !== doc.runId || row.id.localeCompare(priorId) <= 0) {
      return { ...base, originalSha256, rowCount: doc.rows.length, passed: false, failureReason: "manifest_mismatch" };
    }
    ids.add(row.id);
    priorId = row.id;
  }
  const sortedIds = [...ids].sort();
  if ((sortedIds[0] ?? null) !== (m.min_id ?? null) || (sortedIds.at(-1) ?? null) !== (m.max_id ?? null)) {
    return { ...base, originalSha256, rowCount: doc.rows.length, passed: false, failureReason: "manifest_mismatch" };
  }
  return { ...base, originalSha256, rowCount: doc.rows.length, passed: true, failureReason: null };
}

export async function verifyArchiveObjectPass(provider: ObjectStorageProvider, m: RowDataPacket, passNumber: 1 | 2): Promise<VerificationPassResult> {
  try {
    const head = await provider.headObject(m.object_bucket, m.object_key);
    if (!head) return { passNumber, passed: false, failureReason: "object_missing", objectSize: null, archiveSha256: null, originalSha256: null, rowCount: null };
    // Each call performs its own GET. Pass 2 never receives pass 1 bytes/results.
    const bytes = await provider.getObject(m.object_bucket, m.object_key);
    return verifyArchiveBytesAgainstManifest(bytes, m, passNumber);
  } catch {
    return { passNumber, passed: false, failureReason: "object_missing", objectSize: null, archiveSha256: null, originalSha256: null, rowCount: null };
  }
}

export interface VerifyResult { verified: boolean; passes: [VerificationPassResult, VerificationPassResult] }
export async function verifyArchivedRun(db: Queryable, provider: ObjectStorageProvider, runKind: RunKind, runId: string, sourceTable: string): Promise<VerifyResult> {
  const m = await getArchivedRunManifest(db, runKind, runId, sourceTable);
  if (!m) throw new Error("no_archive_manifest");
  const first = await verifyArchiveObjectPass(provider, m, 1);
  await recordVerificationEvidence(db, { manifestId: m.id, passNumber: 1, objectSize: first.objectSize,
    archiveSha256: first.archiveSha256, originalSha256: first.originalSha256, rowCount: first.rowCount,
    result: first.passed ? "passed" : "failed", failureReason: first.failureReason });
  const second = await verifyArchiveObjectPass(provider, m, 2);
  await recordVerificationEvidence(db, { manifestId: m.id, passNumber: 2, objectSize: second.objectSize,
    archiveSha256: second.archiveSha256, originalSha256: second.originalSha256, rowCount: second.rowCount,
    result: second.passed ? "passed" : "failed", failureReason: second.failureReason });
  const passes: [VerificationPassResult, VerificationPassResult] = [first, second];
  const verified = passes.every((p) => p.passed);
  await setManifestVerification(db, m.id, verified ? "verified" : "failed", passes.filter((p) => p.passed).length, passes);
  return { verified, passes };
}

export interface ReimportResult {
  ok: boolean; rowCountMatch: boolean; schemaMatch: boolean; keyUnique: boolean;
  contentChecksumMatch: boolean; semanticSamplesMatch: boolean; cleanup: boolean; reimportedRows: number; idempotent: boolean;
}
function valueForSql(column: ArchiveColumn, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (/^(datetime|timestamp)/i.test(column.sqlType) && typeof value === "string") return new Date(value);
  if (value && typeof value === "object" && "$binaryBase64" in (value as Record<string, unknown>)) {
    return Buffer.from(String((value as Record<string, unknown>).$binaryBase64), "base64");
  }
  return value;
}
export async function reimportArchivedRunToStaging(
  db: Queryable, provider: ObjectStorageProvider, runKind: RunKind, runId: string, sourceTable: string, forceProof = false
): Promise<ReimportResult> {
  const m = await getArchivedRunManifest(db, runKind, runId, sourceTable);
  if (!m) throw new Error("no_archive_manifest");
  if (m.verification_status !== "verified" || Number(m.verification_count) < 2) throw new Error("archive_not_double_verified");
  if (m.staging_reimport_status === "passed" && !forceProof) {
    const saved = typeof m.staging_reimport_result === "string" ? JSON.parse(m.staging_reimport_result) : m.staging_reimport_result;
    return { ...saved, idempotent: true } as ReimportResult;
  }
  const bytes = await provider.getObject(m.object_bucket, m.object_key);
  const validation = verifyArchiveBytesAgainstManifest(bytes, m, 1);
  if (!validation.passed) throw new Error(`archive_validation_failed:${validation.failureReason}`);
  const doc = JSON.parse(gunzipToString(bytes)) as RetentionArchiveDocument;
  const staging = `_p5_${sourceTable.slice(0, 30)}_${Math.random().toString(36).slice(2, 10)}`;
  let cleanup = false;
  let inserted = 0;
  let result: ReimportResult = { ok: false, rowCountMatch: false, schemaMatch: false, keyUnique: false,
    contentChecksumMatch: false, semanticSamplesMatch: false, cleanup: false, reimportedRows: 0, idempotent: false };
  try {
    await db.query(`CREATE TEMPORARY TABLE \`${staging}\` LIKE \`${sourceTable}\``);
    const currentColumns = await getArchiveColumns(db, sourceTable);
    const schemaMatch = canonicalJson(currentColumns) === canonicalJson(doc.columns);
    if (schemaMatch && doc.rows.length) {
      const names = doc.columns.map((c) => c.name);
      for (let i = 0; i < doc.rows.length; i += 250) {
        const chunk = doc.rows.slice(i, i + 250);
        const placeholders = chunk.map(() => `(${names.map(() => "?").join(",")})`).join(",");
        const byName = new Map(doc.columns.map((column) => [column.name, column]));
        const params = chunk.flatMap((row) => names.map((name) => valueForSql(byName.get(name)!, row[name])));
        const [write] = await db.query(`INSERT INTO \`${staging}\` (${names.map((n) => `\`${n}\``).join(",")}) VALUES ${placeholders}`, params);
        inserted += (write as { affectedRows: number }).affectedRows;
      }
    }
    const [[counts]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) n, COUNT(DISTINCT id) unique_n FROM \`${staging}\``);
    const rowCountMatch = Number(counts.n) === doc.rowCount && inserted === doc.rowCount;
    const keyUnique = Number(counts.unique_n) === doc.rowCount;
    const [restored] = await db.query<RowDataPacket[]>(`SELECT * FROM \`${staging}\` ORDER BY id ASC`);
    const archivedRows = [...doc.rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const contentChecksumMatch = sha256Hex(canonicalJson(restored)) === sha256Hex(canonicalJson(archivedRows));
    const indexes = doc.rows.length ? [...new Set([0, Math.floor(doc.rows.length / 2), doc.rows.length - 1])] : [];
    const semanticSamplesMatch = indexes.every((i) => canonicalJson(restored[i]) === canonicalJson(archivedRows[i]));
    result = { ok: schemaMatch && rowCountMatch && keyUnique && contentChecksumMatch && semanticSamplesMatch,
      schemaMatch, rowCountMatch, keyUnique, contentChecksumMatch, semanticSamplesMatch,
      cleanup: false, reimportedRows: inserted, idempotent: false };
  } finally {
    await db.query(`DROP TEMPORARY TABLE IF EXISTS \`${staging}\``);
    cleanup = true;
  }
  result.cleanup = cleanup;
  result.ok = result.ok && cleanup;
  await setManifestReimport(db, m.id, result.ok ? "passed" : "failed", result);
  return result;
}
