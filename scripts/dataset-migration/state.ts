import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { CompositeCursor } from "./model";

export interface PageManifest {
  passId: string;
  family: string;
  table: string;
  pageNumber: number;
  lowerCursor: CompositeCursor | null;
  upperWatermark: CompositeCursor | null;
  firstKey: string | null;
  lastKey: string | null;
  sourceRowCount: number;
  insertedCount: number;
  updatedCount: number;
  matchedCount: number;
  deletedCount: number;
  sourceChecksum: string;
  targetVerificationChecksum: string;
  durationMs: number;
  retryCount: number;
  status: "completed" | "failed";
  error?: string;
}

export interface SyncState {
  version: 1;
  sourceIdentity: string;
  targetIdentity: string;
  family: string;
  table: string;
  cursor: CompositeCursor | null;
  upperWatermark: CompositeCursor | null;
  overlapStart: CompositeCursor | null;
  passId: string;
  pageNumber: number;
  status: "initialized" | "running" | "completed" | "failed";
  pageCounts: { completed: number; failed: number; rows: number };
  latestManifestChecksum: string | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  /** Parent IDs inserted/rescanned in this pass, used by parent-driven families. */
  touchedKeys?: string[];
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export class FileStateStore {
  constructor(readonly directory: string) {}

  private statePath(table: string): string {
    return path.join(this.directory, "state", `${safeName(table)}.json`);
  }

  private manifestPath(passId: string, table: string, page: number): string {
    return path.join(this.directory, "manifests", safeName(passId), `${safeName(table)}-${String(page).padStart(8, "0")}.json`);
  }

  async initialize(): Promise<void> {
    await mkdir(path.join(this.directory, "state"), { recursive: true });
    await mkdir(path.join(this.directory, "manifests"), { recursive: true });
    await mkdir(path.join(this.directory, "reports"), { recursive: true });
  }

  async read(table: string): Promise<SyncState | null> {
    try {
      return JSON.parse(await readFile(this.statePath(table), "utf8")) as SyncState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async write(table: string, state: SyncState): Promise<void> {
    await this.atomicJson(this.statePath(table), state);
  }

  async writeManifest(manifest: PageManifest): Promise<void> {
    await mkdir(path.dirname(this.manifestPath(manifest.passId, manifest.table, manifest.pageNumber)), { recursive: true });
    await this.atomicJson(this.manifestPath(manifest.passId, manifest.table, manifest.pageNumber), manifest);
  }

  async writeReport(passId: string, report: unknown): Promise<void> {
    await this.atomicJson(path.join(this.directory, "reports", `${safeName(passId)}.json`), report);
  }

  private async atomicJson(filename: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, filename);
    const directoryHandle = await open(path.dirname(filename), "r").catch(() => null);
    if (directoryHandle) {
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close();
    }
  }
}
