import type { Pool } from "mysql2/promise";

const sourceReaderBrand: unique symbol = Symbol("datasetMigrationSourceReader");

export interface SourceReader {
  readonly [sourceReaderBrand]: true;
  query: Pool["query"];
  end: Pool["end"];
}

const FORBIDDEN_SOURCE_SQL = /\b(?:INSERT|UPDATE|DELETE|REPLACE|MERGE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|SET|USE|CALL|EXECUTE|PREPARE|DEALLOCATE|HANDLER|LOAD|DO|LOCK|UNLOCK|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|INTO)\b|\bSTART\s+TRANSACTION\b|\bRELEASE\s+SAVEPOINT\b|\bFOR\s+UPDATE\b|\bLOCK\s+IN\s+SHARE\s+MODE\b|\b(?:GET_LOCK|RELEASE_LOCK)\s*\(/i;

/** Runtime boundary for every source-side statement used by Phase 8. */
export function assertSourceSqlReadOnly(sql: string): void {
  const statement = sql.trim();
  if (!/^(?:SELECT|SHOW)\b/i.test(statement)) {
    throw new Error("Source SQL invariant rejected a non-read statement; only SELECT and SHOW are allowed");
  }
  if (statement.includes(";") || /(?:--|#|\/\*)/.test(statement)) {
    throw new Error("Source SQL invariant rejected comments or multiple statements");
  }
  if (FORBIDDEN_SOURCE_SQL.test(statement)) {
    throw new Error("Source SQL invariant rejected a mutating, locking, or executable statement");
  }
}

export function createSourceReader(pool: Pick<Pool, "query" | "end">): SourceReader {
  const query = (async (sql: unknown, values?: unknown[]) => {
    if (typeof sql !== "string") throw new Error("Source SQL invariant requires a static SQL string");
    assertSourceSqlReadOnly(sql);
    return pool.query(sql, values);
  }) as Pool["query"];
  return { [sourceReaderBrand]: true, query, end: () => pool.end() };
}

export interface SourceGrantAssessment {
  selectAvailable: boolean;
  elevatedPrivilegesDetected: boolean;
  warning: string | null;
}

export function assessSourceGrants(grants: string): SourceGrantAssessment {
  const normalized = grants.toUpperCase();
  const allPrivileges = /\bALL PRIVILEGES\b/.test(normalized);
  const selectAvailable = allPrivileges || /\bSELECT\b/.test(normalized);
  const elevatedPrivilegesDetected = allPrivileges || /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|TRIGGER|EVENT|EXECUTE|GRANT OPTION|SUPER|FILE|PROCESS|RELOAD|SHUTDOWN)\b/.test(normalized);
  return {
    selectAvailable,
    elevatedPrivilegesDetected,
    warning: elevatedPrivilegesDetected
      ? "Source identity has write or administrative grants. DATASET.md requires read-only migration behavior, which is enforced by the source SQL invariant; a SELECT-only identity remains an optional least-privilege recommendation."
      : null,
  };
}
