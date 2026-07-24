/**
 * DATASET Phase 14 — raw_api_snapshots payload lifecycle (payload nulling after
 * a verified external archive + grace + re-verification).
 *
 * DB-free unit tests: a stateful fake pool models raw_api_snapshots +
 * raw_snapshot_archives and mutates on UPDATE, and an InMemoryObjectStorage
 * holds real gzip'd archive objects so the pre-removal re-verification runs for
 * real. These prove the exact safety contract WITHOUT MySQL:
 *   - dry-run performs no mutations,
 *   - a missing / unverified / within-grace archive blocks removal,
 *   - a verified archive past the grace allows payload=NULL (metadata kept),
 *   - a re-verification mismatch blocks removal (and does not touch others),
 *   - batch limits are respected and re-running is idempotent/resumable,
 *   - the concurrent-sweep lock blocks a second sweep,
 *   - a destructive sweep requires the explicit flag,
 *   - every sweep writes a complete manifest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { gzipPayload, sha256Hex } from "@/lib/archive/codec";
import { InMemoryObjectStorage } from "@/lib/archive/provider";
import { runRawPayloadSweep, planRawPayloadRemoval, RAW_PAYLOAD_GRACE_DAYS } from "@/lib/retention/rawPayload";

const BUCKET = "test-bucket";
const DAY = 24 * 60 * 60 * 1000;

interface Snap {
  id: string;
  payload: string | null;
  checksum: string;
  createdAt: Date;
  archive: null | {
    status: string;
    verifiedAt: Date | null;
    objectChecksum: string | null;
    originalChecksum: string;
    bucket: string;
    key: string;
    payloadRemovedAt: Date | null;
  };
}

interface Manifest {
  id: string;
  dryRun: number;
  candidates: number;
  removed: number;
  skipped: number;
  failed: number;
  reclaimedBytes: number;
  details: string | null;
  finalized: boolean;
}

interface FakeState {
  snaps: Snap[];
  manifests: Manifest[];
  lockHeld: boolean;
}

/** Build a snapshot + a real archived object in `store`, returning the Snap. */
function makeSnap(
  store: InMemoryObjectStorage,
  id: string,
  opts: { verifiedDaysAgo?: number | null; status?: string; withArchive?: boolean; removed?: boolean; corruptObject?: boolean; payloadNull?: boolean } = {}
): Snap {
  const payload = JSON.stringify({ id, data: `payload-${id}`.repeat(3) });
  const gz = gzipPayload(payload);
  const key = `raw/v1/${id}.json.gz`;
  const withArchive = opts.withArchive ?? true;
  if (withArchive) {
    store.putObject({ bucket: BUCKET, key, body: opts.corruptObject ? Buffer.from("corrupt-bytes") : gz.compressed });
  }
  return {
    id,
    payload: opts.payloadNull ? null : payload,
    checksum: gz.originalChecksum,
    createdAt: new Date(Date.now() - 30 * DAY),
    archive: withArchive
      ? {
          status: opts.status ?? "verified",
          verifiedAt: opts.verifiedDaysAgo === null || opts.verifiedDaysAgo === undefined ? new Date(Date.now() - 30 * DAY) : new Date(Date.now() - opts.verifiedDaysAgo * DAY),
          objectChecksum: gz.objectChecksum,
          originalChecksum: gz.originalChecksum,
          bucket: BUCKET,
          key,
          payloadRemovedAt: opts.removed ? new Date() : null,
        }
      : null,
  };
}

function makeFakePool(state: FakeState): Pool {
  const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

  const handle = async (sqlRaw: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    const sql = norm(sqlRaw);

    // workflow definition + lock
    if (/^INSERT INTO workflow_definitions/i.test(sql)) return [{ affectedRows: 1 }, []];
    if (/^SELECT id FROM workflow_definitions/i.test(sql)) return [[{ id: "def-1" }], []];
    if (/^UPDATE workflow_locks SET released_at/i.test(sql) && /expires_at < /i.test(sql)) return [{ affectedRows: 0 }, []];
    if (/^INSERT INTO workflow_locks/i.test(sql)) {
      if (state.lockHeld) {
        const err = new Error("dup lock") as Error & { code?: string };
        err.code = "ER_DUP_ENTRY";
        throw err;
      }
      return [{ affectedRows: 1 }, []];
    }
    if (/^UPDATE workflow_locks SET released_at/i.test(sql)) return [{ affectedRows: 1 }, []];

    // manifest insert / finalize
    if (/^INSERT INTO raw_payload_removal_manifests/i.test(sql)) {
      state.manifests.push({ id: params[0] as string, dryRun: params[2] as number, candidates: 0, removed: 0, skipped: 0, failed: 0, reclaimedBytes: 0, details: null, finalized: false });
      return [{ affectedRows: 1 }, []];
    }
    if (/^UPDATE raw_payload_removal_manifests/i.test(sql)) {
      const id = params[6] as string;
      const m = state.manifests.find((x) => x.id === id);
      if (m) {
        m.candidates = params[0] as number;
        m.removed = params[1] as number;
        m.skipped = params[2] as number;
        m.failed = params[3] as number;
        m.reclaimedBytes = params[4] as number;
        m.details = params[5] as string;
        m.finalized = true;
      }
      return [{ affectedRows: 1 }, []];
    }

    // FOR UPDATE join (must be checked before the LEFT JOIN scan)
    if (/FROM raw_api_snapshots s JOIN raw_snapshot_archives a/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      const s = state.snaps.find((x) => x.id === params[0]);
      if (!s || !s.archive) return [[], []];
      return [[{
        payload: s.payload,
        archiveStatus: s.archive.status,
        verifiedAt: s.archive.verifiedAt,
        objectChecksum: s.archive.objectChecksum,
        originalChecksum: s.archive.originalChecksum,
        objectBucket: s.archive.bucket,
        objectKey: s.archive.key,
        payloadRemovedAt: s.archive.payloadRemovedAt,
      }], []];
    }

    // scan (LEFT JOIN)
    if (/FROM raw_api_snapshots s LEFT JOIN raw_snapshot_archives a/i.test(sql)) {
      const rows = state.snaps
        .filter((s) => s.payload !== null && (!s.archive || s.archive.payloadRemovedAt === null))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((s) => ({
          rawSnapshotId: s.id,
          archId: s.archive ? s.id : null,
          archiveStatus: s.archive?.status ?? null,
          verifiedAt: s.archive?.verifiedAt ?? null,
          objectChecksum: s.archive?.objectChecksum ?? null,
          originalChecksum: s.archive?.originalChecksum ?? null,
          objectBucket: s.archive?.bucket ?? null,
          objectKey: s.archive?.key ?? null,
          payloadRemovedAt: s.archive?.payloadRemovedAt ?? null,
          payloadBytes: s.payload ? Buffer.byteLength(s.payload, "utf8") : 0,
        }));
      return [rows, []];
    }

    // payload null
    if (/^UPDATE raw_api_snapshots SET payload = NULL/i.test(sql)) {
      const s = state.snaps.find((x) => x.id === params[0]);
      if (s && s.payload !== null) {
        s.payload = null;
        return [{ affectedRows: 1 } as ResultSetHeader, []];
      }
      return [{ affectedRows: 0 } as ResultSetHeader, []];
    }
    if (/^UPDATE raw_snapshot_archives SET payload_removed_at/i.test(sql)) {
      const s = state.snaps.find((x) => x.id === params[0]);
      if (s && s.archive && s.archive.payloadRemovedAt === null) s.archive.payloadRemovedAt = new Date();
      return [{ affectedRows: 1 }, []];
    }

    if (/^SELECT/i.test(sql)) return [[], []];
    return [{ affectedRows: 1 }, []];
  };

  const conn = {
    query: (sql: string, params?: unknown[]) => handle(sql, params),
    execute: (sql: string, params?: unknown[]) => handle(sql, params),
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  } as unknown as PoolConnection;

  return {
    query: (sql: string, params?: unknown[]) => handle(sql, params),
    execute: (sql: string, params?: unknown[]) => handle(sql, params),
    getConnection: async () => conn,
  } as unknown as Pool;
}

function freshState(snaps: Snap[], lockHeld = false): FakeState {
  return { snaps, manifests: [], lockHeld };
}

// ---------------------------------------------------------------------------

test("planRawPayloadRemoval classifies every skip reason and never writes", async () => {
  const store = new InMemoryObjectStorage();
  const state = freshState([
    makeSnap(store, "eligible-1", { verifiedDaysAgo: 10 }),
    makeSnap(store, "no-archive", { withArchive: false }),
    makeSnap(store, "unverified", { status: "pending", verifiedDaysAgo: 10 }),
    makeSnap(store, "in-grace", { verifiedDaysAgo: 2 }),
  ]);
  const pool = makeFakePool(state);

  const plan = await planRawPayloadRemoval(pool, {});
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].rawSnapshotId, "eligible-1");
  assert.equal(plan.skippedByReason.no_archive, 1);
  assert.equal(plan.skippedByReason.archive_not_verified, 1);
  assert.equal(plan.skippedByReason.within_grace_period, 1);
  assert.equal(plan.graceDays, RAW_PAYLOAD_GRACE_DAYS);
  // Nothing mutated.
  assert.ok(state.snaps.every((s) => s.payload !== null));
});

test("dry-run performs no mutations and writes a manifest", async () => {
  const store = new InMemoryObjectStorage();
  const state = freshState([makeSnap(store, "eligible-1", { verifiedDaysAgo: 10 })]);
  const pool = makeFakePool(state);

  const result = await runRawPayloadSweep(pool, store, { destructiveEnabled: false });

  assert.equal(result.outcome, "dry_run");
  assert.equal(result.dryRun, true);
  assert.equal(result.candidates, 1);
  assert.equal(result.removed, 0);
  assert.equal(state.snaps[0].payload !== null, true, "dry-run never nulls a payload");
  assert.equal(state.manifests.length, 1);
  assert.equal(state.manifests[0].finalized, true, "a manifest is written even for a dry-run");
});

test("verified archive past the grace allows payload NULL; metadata row is preserved", async () => {
  const store = new InMemoryObjectStorage();
  const state = freshState([makeSnap(store, "eligible-1", { verifiedDaysAgo: 10 })]);
  const pool = makeFakePool(state);

  const result = await runRawPayloadSweep(pool, store, { destructiveEnabled: true });

  assert.equal(result.outcome, "completed");
  assert.equal(result.removed, 1);
  assert.ok(result.reclaimedBytes > 0);
  assert.equal(state.snaps[0].payload, null, "payload was nulled");
  assert.ok(state.snaps[0].id === "eligible-1", "the metadata row is preserved (never deleted)");
  assert.equal(state.snaps[0].archive?.payloadRemovedAt !== null, true, "payload_removed_at was stamped");
  assert.equal(state.manifests[0].removed, 1);
});

test("missing archive blocks removal", async () => {
  const store = new InMemoryObjectStorage();
  const state = freshState([makeSnap(store, "no-archive", { withArchive: false })]);
  const pool = makeFakePool(state);
  const result = await runRawPayloadSweep(pool, store, { destructiveEnabled: true });
  assert.equal(result.removed, 0);
  assert.equal(result.skippedByReason.no_archive, 1);
  assert.equal(state.snaps[0].payload !== null, true);
});

test("unverified archive blocks removal", async () => {
  const store = new InMemoryObjectStorage();
  const state = freshState([makeSnap(store, "unverified", { status: "failed", verifiedDaysAgo: 10 })]);
  const pool = makeFakePool(state);
  const result = await runRawPayloadSweep(pool, store, { destructiveEnabled: true });
  assert.equal(result.removed, 0);
  assert.equal(result.skippedByReason.archive_not_verified, 1);
  assert.equal(state.snaps[0].payload !== null, true);
});

test("verified archive still within the grace period blocks removal", async () => {
  const store = new InMemoryObjectStorage();
  const state = freshState([makeSnap(store, "in-grace", { verifiedDaysAgo: 3 })]);
  const pool = makeFakePool(state);
  const result = await runRawPayloadSweep(pool, store, { destructiveEnabled: true });
  assert.equal(result.removed, 0);
  assert.equal(result.skippedByReason.within_grace_period, 1);
  assert.equal(state.snaps[0].payload !== null, true);
});

test("a grace shorter than the 7-day floor is clamped up (a 0-day request still respects 7 days)", async () => {
  const store = new InMemoryObjectStorage();
  const state = freshState([makeSnap(store, "day5", { verifiedDaysAgo: 5 })]);
  const pool = makeFakePool(state);
  const result = await runRawPayloadSweep(pool, store, { destructiveEnabled: true, graceDays: 0 });
  assert.equal(result.graceDays, RAW_PAYLOAD_GRACE_DAYS);
  assert.equal(result.removed, 0, "5 days < 7-day floor, so still within grace");
  assert.equal(result.skippedByReason.within_grace_period, 1);
});

test("a re-verification mismatch (corrupt object) blocks removal and does not touch a healthy sibling", async () => {
  const store = new InMemoryObjectStorage();
  const state = freshState([
    makeSnap(store, "corrupt", { verifiedDaysAgo: 10, corruptObject: true }),
    makeSnap(store, "healthy", { verifiedDaysAgo: 10 }),
  ]);
  const pool = makeFakePool(state);

  const result = await runRawPayloadSweep(pool, store, { destructiveEnabled: true });

  assert.equal(result.removed, 1, "only the healthy snapshot is removed");
  assert.equal(result.skippedByReason.reverify_object_checksum_mismatch, 1);
  assert.equal(state.snaps.find((s) => s.id === "corrupt")!.payload !== null, true, "corrupt archive's payload is preserved");
  assert.equal(state.snaps.find((s) => s.id === "healthy")!.payload, null);
});

test("batch limits are respected and a second run resumes the remainder (idempotent)", async () => {
  const store = new InMemoryObjectStorage();
  const state = freshState([
    makeSnap(store, "e1", { verifiedDaysAgo: 10 }),
    makeSnap(store, "e2", { verifiedDaysAgo: 10 }),
    makeSnap(store, "e3", { verifiedDaysAgo: 10 }),
  ]);
  const pool = makeFakePool(state);

  const first = await runRawPayloadSweep(pool, store, { destructiveEnabled: true, batchSize: 2 });
  assert.equal(first.removed, 2, "batch limit of 2 respected");
  assert.equal(state.snaps.filter((s) => s.payload === null).length, 2);

  const second = await runRawPayloadSweep(pool, store, { destructiveEnabled: true, batchSize: 2 });
  assert.equal(second.removed, 1, "the second sweep resumes the remaining one");
  assert.equal(state.snaps.filter((s) => s.payload === null).length, 3);

  const third = await runRawPayloadSweep(pool, store, { destructiveEnabled: true, batchSize: 2 });
  assert.equal(third.removed, 0, "a third sweep is a no-op (idempotent)");
  assert.equal(third.candidates, 0);
});

test("the concurrent-sweep lock blocks a second sweep (no mutation)", async () => {
  const store = new InMemoryObjectStorage();
  const state = freshState([makeSnap(store, "eligible-1", { verifiedDaysAgo: 10 })], /* lockHeld */ true);
  const pool = makeFakePool(state);

  const result = await runRawPayloadSweep(pool, store, { destructiveEnabled: true });

  assert.equal(result.outcome, "lock_not_acquired");
  assert.equal(result.removed, 0);
  assert.equal(state.snaps[0].payload !== null, true, "a locked-out sweep mutates nothing");
});

test("a destructive sweep requires the explicit flag (default is a dry-run no-op)", async () => {
  const store = new InMemoryObjectStorage();
  const state = freshState([makeSnap(store, "eligible-1", { verifiedDaysAgo: 10 })]);
  const pool = makeFakePool(state);

  // No destructiveEnabled and no env flag -> dry-run, nothing nulled.
  const result = await runRawPayloadSweep(pool, store, { env: {} });
  assert.equal(result.dryRun, true);
  assert.equal(result.outcome, "dry_run");
  assert.equal(state.snaps[0].payload !== null, true);
});

test("the manifest is complete: candidates, removed, skipped, and reason breakdown", async () => {
  const store = new InMemoryObjectStorage();
  const state = freshState([
    makeSnap(store, "eligible-1", { verifiedDaysAgo: 10 }),
    makeSnap(store, "in-grace", { verifiedDaysAgo: 2 }),
  ]);
  const pool = makeFakePool(state);

  await runRawPayloadSweep(pool, store, { destructiveEnabled: true });

  assert.equal(state.manifests.length, 1);
  const m = state.manifests[0];
  assert.equal(m.finalized, true);
  assert.equal(m.candidates, 1);
  assert.equal(m.removed, 1);
  assert.equal(m.skipped, 1);
  const details = JSON.parse(m.details as string);
  assert.equal(details.skippedByReason.within_grace_period, 1);
});
