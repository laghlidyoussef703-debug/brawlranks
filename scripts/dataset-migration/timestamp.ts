import type { CompositeCursor, TablePlan } from "./model";

export interface TimestampContext {
  family: string;
  table: string;
  column: string;
  operation: string;
  nullable: boolean;
}

export interface TimestampMetadata {
  timestampColumns: string[];
  nullableColumns: string[];
}

function rawType(value: unknown): string {
  if (value instanceof Date) return "Date";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sanitizedRaw(value: unknown): string {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "Invalid Date";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.slice(0, 120).replace(/[\r\n\t]/g, " ");
  if (value === null || value === undefined) return String(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `[${rawType(value)}]`;
}

function invalidTimestamp(context: TimestampContext, value: unknown, reason: string): never {
  const requirement = context.nullable ? "timestamp" : "required timestamp";
  throw new Error(
    `Invalid ${requirement} [family=${context.family} table=${context.table} column=${context.column} operation=${context.operation} rawType=${rawType(value)} rawValue=${JSON.stringify(sanitizedRaw(value))}]: ${reason}`
  );
}

function validateCalendar(year: number, month: number, day: number, hour: number, minute: number, second: number, context: TimestampContext, value: unknown): void {
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) invalidTimestamp(context, value, "calendar component is out of range");
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > days) invalidTimestamp(context, value, "calendar day is out of range");
}

/** Normalize one database timestamp to canonical UTC ISO-8601 milliseconds. */
export function normalizeTimestamp(value: unknown, context: TimestampContext): string | null {
  if (value === null) return context.nullable ? null : invalidTimestamp(context, value, "required value is null");
  if (value === undefined) return context.nullable ? null : invalidTimestamp(context, value, "value is missing");

  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return invalidTimestamp(context, value, "Date object is invalid (commonly a MariaDB zero date)");
    return value.toISOString();
  }

  if (typeof value === "number" || typeof value === "bigint") {
    const milliseconds = typeof value === "bigint" ? Number(value) : value;
    if (!Number.isSafeInteger(milliseconds)) return invalidTimestamp(context, value, "numeric timestamp must be a safe integer Unix epoch value in milliseconds");
    const date = new Date(milliseconds);
    if (!Number.isFinite(date.getTime())) return invalidTimestamp(context, value, "numeric timestamp is outside the supported Date range");
    return date.toISOString();
  }

  if (typeof value !== "string") return invalidTimestamp(context, value, "unsupported timestamp value type");
  const raw = value.trim();
  if (/^0{4}-0{2}-0{2}(?:[ T]0{2}:0{2}:0{2}(?:\.0+)?)?$/.test(raw)) return invalidTimestamp(context, value, "zero dates are not valid required migration timestamps");

  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(raw);
  if (!match) return invalidTimestamp(context, value, "expected a MariaDB/MySQL datetime or ISO-8601 timestamp");
  const [, yearText, monthText, dayText, hourText = "00", minuteText = "00", secondText = "00", fraction = "", zone] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText), hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  validateCalendar(year, month, day, hour, minute, second, context, value);
  const milliseconds = fraction.padEnd(3, "0").slice(0, 3);
  const isoInput = `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}.${milliseconds}${zone ?? "Z"}`;
  const date = new Date(isoInput);
  if (!Number.isFinite(date.getTime())) return invalidTimestamp(context, value, "timestamp cannot be represented as a JavaScript Date");
  return date.toISOString();
}

export function normalizeTimestampRow<T extends Record<string, unknown>>(
  row: T,
  metadata: TimestampMetadata,
  plan: Pick<TablePlan, "family" | "table">,
  operation: string
): T {
  const normalized = { ...row };
  for (const column of metadata.timestampColumns) {
    if (!Object.prototype.hasOwnProperty.call(row, column)) continue;
    normalized[column as keyof T] = normalizeTimestamp(row[column], {
      family: plan.family,
      table: plan.table,
      column,
      operation,
      nullable: metadata.nullableColumns.includes(column),
    }) as T[keyof T];
  }
  return normalized;
}

export function normalizeTimeCursor(cursor: CompositeCursor | null, plan: TablePlan, column: string, operation: string): CompositeCursor | null {
  if (!cursor) return null;
  return {
    timestamp: normalizeTimestamp(cursor.timestamp, { family: plan.family, table: plan.table, column, operation, nullable: false })!,
    id: String(cursor.id),
  };
}

/** Convert a canonical timestamp back to mysql2's Date binding without changing its UTC instant. */
export function timestampForTarget(value: unknown, context: TimestampContext): Date | null {
  const normalized = normalizeTimestamp(value, context);
  return normalized === null ? null : new Date(normalized);
}
