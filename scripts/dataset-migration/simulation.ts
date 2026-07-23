import { createHash } from "node:crypto";
import { compareCursor, type CompositeCursor } from "./model";
import { normalizeTimestamp } from "./timestamp";
import type { DbRow } from "./canonical";
import { classifyWorkflowLockRow, isMariaDbZeroDate } from "./workflow-lock-normalization";

export interface SimRow { id: string; timestamp: string; key: string; content: string; mutable?: boolean; status?: string }

export function fixedWatermark(rows: SimRow[]): CompositeCursor | null {
  return rows.map((row) => ({ timestamp: row.timestamp, id: row.id })).sort(compareCursor).at(-1) ?? null;
}

export function compositePage(rows: SimRow[], lower: CompositeCursor | null, upper: CompositeCursor, limit: number): SimRow[] {
  return rows
    .filter((row) => {
      const cursor = { timestamp: row.timestamp, id: row.id };
      return (!lower || compareCursor(cursor, lower) > 0) && compareCursor(cursor, upper) <= 0;
    })
    .sort((a, b) => compareCursor({ timestamp: a.timestamp, id: a.id }, { timestamp: b.timestamp, id: b.id }))
    .slice(0, limit);
}

export function overlapStart(cursor: CompositeCursor, seconds: number): CompositeCursor {
  const normalized = normalizeTimestamp(cursor.timestamp, { family: "simulation", table: "simulated_rows", column: "timestamp", operation: "overlap start calculation", nullable: false })!;
  return { timestamp: new Date(new Date(normalized).getTime() - seconds * 1000).toISOString(), id: "" };
}

export function canonicalChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function applySimulated(source: SimRow, target: Map<string, SimRow>, immutable: boolean): "inserted" | "updated" | "matched" {
  const existing = target.get(source.key);
  if (!existing) { target.set(source.key, { ...source }); return "inserted"; }
  if (existing.content === source.content && existing.id === source.id) return "matched";
  if (immutable) throw new Error(`fatal divergence source=${canonicalChecksum(source.content)} target=${canonicalChecksum(existing.content)}`);
  target.set(source.key, { ...source }); return "updated";
}

export class PageCursorSimulation {
  cursor: CompositeCursor | null = null;
  attempts = 0;
  apply(page: SimRow[], fail: boolean): void {
    this.attempts += 1;
    if (fail) throw new Error("page failed");
    const last = page.at(-1);
    if (last) this.cursor = { timestamp: last.timestamp, id: last.id };
  }
}

export function reconcileEphemeral(sourceIds: string[], targetIds: string[]): { stale: string[] } {
  const source = new Set(sourceIds);
  return { stale: targetIds.filter((id) => !source.has(id)) };
}

export function reconcileSimulatedTargetWorkflowLock(
  target: Map<string, DbRow>,
  id: string,
  slug: string,
  fixedWatermark: string,
  apply: boolean,
  allowReconcileDelete: boolean
): { plannedDeleted: number; deleted: number; deletionRequired: boolean } {
  const row = target.get(id);
  if (!row || !isMariaDbZeroDate(row.locked_at)) return { plannedDeleted: 0, deleted: 0, deletionRequired: false };
  const decision = classifyWorkflowLockRow(row, slug, fixedWatermark);
  if (decision.action !== "skip") return { plannedDeleted: 0, deleted: 0, deletionRequired: false };
  if (apply && allowReconcileDelete) {
    target.delete(id);
    return { plannedDeleted: 1, deleted: 1, deletionRequired: false };
  }
  return { plannedDeleted: 1, deleted: 0, deletionRequired: apply && !allowReconcileDelete };
}

export function childCountHash(rows: Array<{ parent: string; content: string }>): Map<string, { count: number; hash: string }> {
  const grouped = new Map<string, string[]>();
  for (const row of rows) grouped.set(row.parent, [...(grouped.get(row.parent) ?? []), row.content]);
  return new Map([...grouped].map(([parent, values]) => [parent, { count: values.length, hash: canonicalChecksum(values.sort().join("\n")) }]));
}

export function advanceReadiness(previous: number, successful: boolean, lagSeconds: number): number {
  return successful && lagSeconds < 60 ? previous + 1 : 0;
}
