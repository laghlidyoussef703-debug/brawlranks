/**
 * Parameterized SQL access for every Phase 2 table
 * (BRAWLRANKS_WEBSITE_SPEC.md Section 25.2). Every statement uses `?`
 * placeholders — never string interpolation, never `CAST(? AS JSON)` (not
 * supported by this MariaDB version; JSON payloads are stored as LONGTEXT
 * and parsed/serialized in the application layer).
 *
 * Every function takes an explicit connection (Pool or PoolConnection) so
 * callers control transaction boundaries — this module never opens its own
 * connection or transaction.
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

type Queryable = Pool | PoolConnection;

// ---------------------------------------------------------------------------
// data_sources / source_endpoints
// ---------------------------------------------------------------------------

export interface DataSourceRow {
  id: string;
  name: string;
  isEnabled: boolean;
}

export async function getDataSourceByName(
  db: Queryable,
  name: string
): Promise<DataSourceRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, name, is_enabled FROM data_sources WHERE name = ?",
    [name]
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, name: rows[0].name, isEnabled: Boolean(rows[0].is_enabled) };
}

export interface SourceEndpointRow {
  id: string;
  path: string;
  isEnabled: boolean;
}

export async function getSourceEndpoint(
  db: Queryable,
  dataSourceId: string,
  endpointCategory: string
): Promise<SourceEndpointRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, path, is_enabled FROM source_endpoints WHERE data_source_id = ? AND endpoint_category = ?",
    [dataSourceId, endpointCategory]
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, path: rows[0].path, isEnabled: Boolean(rows[0].is_enabled) };
}

// ---------------------------------------------------------------------------
// data_fetch_runs
// ---------------------------------------------------------------------------

export type FetchRunStatus = "pending" | "running" | "success" | "partial" | "failed" | "timeout";

export async function createFetchRun(
  db: Queryable,
  params: {
    dataSourceId: string;
    sourceEndpointId: string;
    workflowRunId: string | null;
    triggerType: "manual" | "cron" | "api";
  }
): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO data_fetch_runs
       (id, data_source_id, source_endpoint_id, workflow_run_id, trigger_type, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', NOW(3))`,
    [id, params.dataSourceId, params.sourceEndpointId, params.workflowRunId, params.triggerType]
  );
  return id;
}

export async function completeFetchRun(
  db: Queryable,
  runId: string,
  params: {
    status: FetchRunStatus;
    httpStatus?: number | null;
    schemaVersion?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    recordsFetched?: number | null;
    changesDetectedCount: number;
    durationMs: number;
  }
): Promise<void> {
  await db.execute(
    `UPDATE data_fetch_runs
       SET status = ?, http_status = ?, fetched_at = NOW(3), received_at = NOW(3),
           completed_at = NOW(3), duration_ms = ?, schema_version = ?, error_code = ?,
           error_message = ?, records_fetched = ?, changes_detected_count = ?
     WHERE id = ?`,
    [
      params.status,
      params.httpStatus ?? null,
      params.durationMs,
      params.schemaVersion ?? null,
      params.errorCode ?? null,
      params.errorMessage ?? null,
      params.recordsFetched ?? null,
      params.changesDetectedCount,
      runId,
    ]
  );
}

// ---------------------------------------------------------------------------
// raw_api_snapshots (append-only)
// ---------------------------------------------------------------------------

export async function insertRawSnapshot(
  db: Queryable,
  params: {
    dataFetchRunId: string;
    endpointCategory: string;
    payload: string;
    checksum: string;
    httpStatus: number | null;
    sourceReportedAt: Date | null;
  }
): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO raw_api_snapshots
       (id, data_fetch_run_id, endpoint_category, payload, checksum, http_status, source_reported_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))`,
    [
      id,
      params.dataFetchRunId,
      params.endpointCategory,
      params.payload,
      params.checksum,
      params.httpStatus,
      params.sourceReportedAt,
    ]
  );
  return id;
}

// ---------------------------------------------------------------------------
// normalized_snapshots
// ---------------------------------------------------------------------------

export interface AcceptedNormalizedRow {
  id: string;
  normalizedPayloadJson: string;
  payloadChecksum: string;
}

export async function getLastAccepted(
  db: Queryable,
  entityType: string,
  entityId: string
): Promise<AcceptedNormalizedRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT id, normalized_payload, payload_checksum
       FROM normalized_snapshots
      WHERE entity_type = ? AND entity_id = ? AND is_accepted = 1
      LIMIT 1`,
    [entityType, entityId]
  );
  if (rows.length === 0) return null;
  return {
    id: rows[0].id,
    normalizedPayloadJson: rows[0].normalized_payload,
    payloadChecksum: rows[0].payload_checksum,
  };
}

export async function getAllAcceptedEntityIds(
  db: Queryable,
  entityType: string
): Promise<string[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT entity_id FROM normalized_snapshots WHERE entity_type = ? AND is_accepted = 1",
    [entityType]
  );
  return rows.map((row) => row.entity_id as string);
}

/**
 * Inserts a new normalized snapshot. When `accept` is true, the previously
 * accepted row for this entity (if any) is flipped to is_accepted = 0
 * FIRST, inside the caller's transaction — this ordering, combined with the
 * accepted_flag generated-column UNIQUE constraint, guarantees at most one
 * accepted row per entity even under concurrent writers.
 */
export async function insertNormalizedSnapshot(
  db: Queryable,
  params: {
    dataFetchRunId: string;
    entityType: string;
    entityId: string;
    normalizedPayloadJson: string;
    payloadChecksum: string;
    accept: boolean;
  }
): Promise<string> {
  if (params.accept) {
    await db.execute(
      `UPDATE normalized_snapshots
         SET is_accepted = 0
       WHERE entity_type = ? AND entity_id = ? AND is_accepted = 1`,
      [params.entityType, params.entityId]
    );
  }

  const id = randomUUID();
  await db.execute(
    `INSERT INTO normalized_snapshots
       (id, data_fetch_run_id, entity_type, entity_id, normalized_payload, payload_checksum, is_accepted)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.dataFetchRunId,
      params.entityType,
      params.entityId,
      params.normalizedPayloadJson,
      params.payloadChecksum,
      params.accept ? 1 : 0,
    ]
  );
  return id;
}

// ---------------------------------------------------------------------------
// canonical_brawlers / brawler_aliases / gadgets / star_powers
// ---------------------------------------------------------------------------

export interface CanonicalBrawlerRow {
  id: string;
  slug: string;
  name: string;
}

export async function getCanonicalBrawlerBySourceId(
  db: Queryable,
  sourceBrawlerId: string
): Promise<CanonicalBrawlerRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, slug, name FROM canonical_brawlers WHERE source_brawler_id = ?",
    [sourceBrawlerId]
  );
  if (rows.length === 0) return null;
  return { id: rows[0].id, slug: rows[0].slug, name: rows[0].name };
}

/**
 * Inserts a brand-new canonical Brawler. Callers must have already checked
 * (in the same transaction) that no row exists for this source_brawler_id —
 * the UNIQUE constraints on source_brawler_id and slug are the final
 * safety net, not the primary duplicate check.
 */
export async function insertCanonicalBrawler(
  db: Queryable,
  params: { sourceBrawlerId: string; slug: string; name: string; fetchRunId: string }
): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO canonical_brawlers
       (id, source_brawler_id, slug, name, is_active, first_seen_at, last_seen_at, last_fetch_run_id)
     VALUES (?, ?, ?, ?, 1, NOW(3), NOW(3), ?)`,
    [id, params.sourceBrawlerId, params.slug, params.name, params.fetchRunId]
  );
  return id;
}

/**
 * Updates an existing canonical Brawler's mutable fields and, if the name
 * changed, records the previous name as an alias row FIRST (Section 7.6:
 * a rename never produces a new canonical row or a slug change — it always
 * produces an alias). `alias` has a UNIQUE (brawler_id, alias) constraint,
 * so re-observing a name that is already a recorded alias is a silent
 * no-op via ON DUPLICATE KEY UPDATE.
 */
export async function updateCanonicalBrawler(
  db: Queryable,
  params: { brawlerId: string; previousName: string; newName: string; fetchRunId: string }
): Promise<void> {
  if (params.previousName !== params.newName) {
    const aliasId = randomUUID();
    await db.execute(
      `INSERT INTO brawler_aliases (id, brawler_id, alias, alias_type)
       VALUES (?, ?, ?, 'name_history')
       ON DUPLICATE KEY UPDATE alias_type = alias_type`,
      [aliasId, params.brawlerId, params.previousName]
    );
  }

  await db.execute(
    `UPDATE canonical_brawlers
       SET name = ?, is_active = 1, deactivated_at = NULL, last_seen_at = NOW(3), last_fetch_run_id = ?
     WHERE id = ?`,
    [params.newName, params.fetchRunId, params.brawlerId]
  );
}

export async function deactivateCanonicalBrawler(db: Queryable, sourceBrawlerId: string): Promise<void> {
  await db.execute(
    `UPDATE canonical_brawlers
       SET is_active = 0, deactivated_at = NOW(3)
     WHERE source_brawler_id = ? AND is_active = 1`,
    [sourceBrawlerId]
  );
}

export async function getAllActiveCanonicalBrawlers(
  db: Queryable
): Promise<Array<{ id: string; sourceBrawlerId: string; name: string }>> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, source_brawler_id, name FROM canonical_brawlers WHERE is_active = 1"
  );
  return rows.map((row) => ({
    id: row.id,
    sourceBrawlerId: row.source_brawler_id,
    name: row.name,
  }));
}

// table/column names below are interpolated from the fixed SubEntityTable
// union type only — never from request input — so this is not a SQL
// injection surface; every value (brawlerId, sourceItemId, name) still goes
// through parameterized `?` placeholders.
type SubEntityTable = "gadgets" | "star_powers";
const SUB_ENTITY_COLUMN: Record<SubEntityTable, string> = {
  gadgets: "source_gadget_id",
  star_powers: "source_star_power_id",
};

async function upsertSubEntity(
  db: Queryable,
  table: SubEntityTable,
  brawlerId: string,
  sourceItemId: string,
  name: string
): Promise<void> {
  const column = SUB_ENTITY_COLUMN[table];
  const id = randomUUID();
  await db.execute(
    `INSERT INTO ${table} (id, brawler_id, ${column}, name, is_active, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, 1, NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       is_active = 1,
       last_seen_at = NOW(3)`,
    [id, brawlerId, sourceItemId, name]
  );
}

export async function upsertGadget(
  db: Queryable,
  brawlerId: string,
  sourceGadgetId: string,
  name: string
): Promise<void> {
  await upsertSubEntity(db, "gadgets", brawlerId, sourceGadgetId, name);
}

export async function upsertStarPower(
  db: Queryable,
  brawlerId: string,
  sourceStarPowerId: string,
  name: string
): Promise<void> {
  await upsertSubEntity(db, "star_powers", brawlerId, sourceStarPowerId, name);
}

async function deactivateMissingSubEntities(
  db: Queryable,
  table: SubEntityTable,
  brawlerId: string,
  keepSourceIds: string[]
): Promise<void> {
  const column = SUB_ENTITY_COLUMN[table];
  if (keepSourceIds.length === 0) {
    await db.execute(
      `UPDATE ${table} SET is_active = 0 WHERE brawler_id = ? AND is_active = 1`,
      [brawlerId]
    );
    return;
  }
  const placeholders = keepSourceIds.map(() => "?").join(", ");
  await db.execute(
    `UPDATE ${table}
        SET is_active = 0
      WHERE brawler_id = ? AND is_active = 1 AND ${column} NOT IN (${placeholders})`,
    [brawlerId, ...keepSourceIds]
  );
}

export async function deactivateMissingGadgets(
  db: Queryable,
  brawlerId: string,
  keepSourceIds: string[]
): Promise<void> {
  await deactivateMissingSubEntities(db, "gadgets", brawlerId, keepSourceIds);
}

export async function deactivateMissingStarPowers(
  db: Queryable,
  brawlerId: string,
  keepSourceIds: string[]
): Promise<void> {
  await deactivateMissingSubEntities(db, "star_powers", brawlerId, keepSourceIds);
}

// ---------------------------------------------------------------------------
// detected_changes
// ---------------------------------------------------------------------------

export async function insertDetectedChange(
  db: Queryable,
  params: {
    dataFetchRunId: string;
    entityType: string;
    entityId: string;
    changeType: string;
    field?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
    severity: "info" | "warning" | "critical";
  }
): Promise<void> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO detected_changes
       (id, data_fetch_run_id, entity_type, entity_id, change_type, field, old_value, new_value, severity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.dataFetchRunId,
      params.entityType,
      params.entityId,
      params.changeType,
      params.field ?? null,
      params.oldValue ?? null,
      params.newValue ?? null,
      params.severity,
    ]
  );
}

// ---------------------------------------------------------------------------
// data_incidents
// ---------------------------------------------------------------------------

export async function createIncident(
  db: Queryable,
  params: {
    incidentType: string;
    relatedFetchRunId?: string | null;
    relatedEntityType?: string | null;
    relatedEntityId?: string | null;
    detail?: unknown;
  }
): Promise<string> {
  const id = randomUUID();
  await db.execute(
    `INSERT INTO data_incidents
       (id, incident_type, related_fetch_run_id, related_entity_type, related_entity_id, detail, status)
     VALUES (?, ?, ?, ?, ?, ?, 'open')`,
    [
      id,
      params.incidentType,
      params.relatedFetchRunId ?? null,
      params.relatedEntityType ?? null,
      params.relatedEntityId ?? null,
      params.detail !== undefined ? JSON.stringify(params.detail) : null,
    ]
  );
  return id;
}

export type { Pool, PoolConnection, ResultSetHeader };
