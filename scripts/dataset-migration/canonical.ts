import { createHash } from "node:crypto";
import { normalizeTimestamp } from "./timestamp";

export type DbRow = Record<string, unknown>;

function normalized(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return normalizeTimestamp(value, { family: "internal", table: "canonical_row", column: "unknown", operation: "JSON canonicalization", nullable: false });
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

export function canonicalRow(row: DbRow, columns: string[]): string {
  return JSON.stringify(columns.map((column) => [column, normalized(row[column])]));
}

export function checksumRows(rows: DbRow[], columns: string[]): string {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(canonicalRow(row, columns)).update("\n");
  return hash.digest("hex");
}

export function checksumRow(row: DbRow, columns: string[]): string {
  return createHash("sha256").update(canonicalRow(row, columns)).digest("hex");
}

export class DivergenceError extends Error {
  constructor(readonly detail: { table: string; key: string; sourceChecksum: string; targetChecksum: string; context: Record<string, unknown> }) {
    super(`Fatal immutable divergence in ${detail.table} at ${detail.key}`);
    this.name = "DivergenceError";
  }
}
