import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { CompositeCursor } from "./model";
import type { SkippedEphemeralStaleLockEvidence } from "./workflow-lock-normalization";

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
  normalizedTimestampCounts?: Record<string, number>;
  sourceTimeWatermark?: string;
  skippedEphemeralStaleLockCount?: number;
  skippedEphemeralStaleLockCountsBySlug?: Record<string, number>;
  skippedEphemeralStaleLocks?: SkippedEphemeralStaleLockEvidence[];
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
  sourceTimeWatermark?: string | null;
  error: string | null;
  /** Parent IDs inserted/rescanned in this pass, used by parent-driven families. */
  touchedKeys?: string[];
}

export interface MigrationStateStore {
  initialize(): Promise<void>;
  read(table: string): Promise<SyncState | null>;
  write(table: string, state: SyncState): Promise<void>;
  writeManifest(manifest: PageManifest): Promise<void>;
  writeReport(passId: string, report: unknown): Promise<void>;
  writeRunMetadata(passId: string, metadata: unknown): Promise<void>;
  writeDiagnostic(passId: string, diagnostic: unknown): Promise<void>;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export class FileStateStore implements MigrationStateStore {
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
    await mkdir(path.join(this.directory, "runs"), { recursive: true });
    await mkdir(path.join(this.directory, "diagnostics"), { recursive: true });
  }

  private scopeIdentityPath(): string {
    return path.join(this.directory, "scope.json");
  }

  /**
   * Binds this state directory to a single scope identity. The first bind
   * records it; later binds must match exactly. Resuming or reusing a directory
   * created for a different scope or table manifest fails closed, so Tier-1
   * cursors can never be silently reused for a full-history pass (or vice versa).
   */
  async bindScope(identity: { scope: string; version: number; manifestHash: string }): Promise<{ created: boolean }> {
    const file = this.scopeIdentityPath();
    type StoredScopeIdentity = { scope?: string; version?: number; manifestHash?: string };
    let existing: StoredScopeIdentity | null = null;
    try {
      existing = JSON.parse(await readFile(file, "utf8")) as StoredScopeIdentity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      if (existing.scope !== identity.scope || existing.version !== identity.version || existing.manifestHash !== identity.manifestHash) {
        const shown = (value: unknown): string => String(value ?? "").slice(0, 12);
        throw new Error(
          `Migration state directory ${this.directory} is bound to scope '${existing.scope}' ` +
          `(v${existing.version}, manifest ${shown(existing.manifestHash)}...); refusing to reuse it for scope ` +
          `'${identity.scope}' (v${identity.version}, manifest ${shown(identity.manifestHash)}...). ` +
          `Use a fresh --state-dir for each scope.`
        );
      }
      return { created: false };
    }
    await this.atomicJson(file, { ...identity, boundAt: new Date().toISOString() });
    return { created: true };
  }

  async readScopeIdentity(): Promise<{ scope: string; version: number; manifestHash: string; boundAt?: string } | null> {
    try {
      return JSON.parse(await readFile(this.scopeIdentityPath(), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
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

  async writeRunMetadata(passId: string, metadata: unknown): Promise<void> {
    await this.atomicJson(path.join(this.directory, "runs", `${safeName(passId)}.json`), metadata);
  }

  async writeDiagnostic(passId: string, diagnostic: unknown): Promise<void> {
    await this.atomicJson(path.join(this.directory, "diagnostics", `${safeName(passId)}.json`), diagnostic);
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

/** Buffers a dry-run pass so a failure cannot modify durable cursor state or manifests. */
export class BufferedStateStore implements MigrationStateStore {
  private readonly states = new Map<string, SyncState>();
  private readonly manifests: PageManifest[] = [];
  private readonly reports: Array<{ passId: string; report: unknown }> = [];

  constructor(private readonly durable: FileStateStore) {}

  initialize(): Promise<void> { return this.durable.initialize(); }
  async read(table: string): Promise<SyncState | null> { return this.states.get(table) ?? this.durable.read(table); }
  async write(table: string, state: SyncState): Promise<void> { this.states.set(table, structuredClone(state)); }
  async writeManifest(manifest: PageManifest): Promise<void> { this.manifests.push(structuredClone(manifest)); }
  async writeReport(passId: string, report: unknown): Promise<void> { this.reports.push({ passId, report: structuredClone(report) }); }
  writeRunMetadata(passId: string, metadata: unknown): Promise<void> { return this.durable.writeRunMetadata(passId, metadata); }
  writeDiagnostic(passId: string, diagnostic: unknown): Promise<void> { return this.durable.writeDiagnostic(passId, diagnostic); }

  async commit(): Promise<void> {
    for (const manifest of this.manifests) await this.durable.writeManifest(manifest);
    for (const [table, state] of this.states) await this.durable.write(table, state);
    for (const { passId, report } of this.reports) await this.durable.writeReport(passId, report);
  }
}
