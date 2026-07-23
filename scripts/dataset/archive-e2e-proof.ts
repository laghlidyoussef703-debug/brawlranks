#!/usr/bin/env -S tsx
/**
 * DATASET Phase 4 — local end-to-end archive proof.
 *
 * Against a DISPOSABLE database seeded with a real raw snapshot copied from the
 * restored production copy, this exercises the whole path with a local S3-style
 * (filesystem) provider:
 *   enqueue -> gzip + upload -> HEAD -> GET/decompress/verify -> mark verified
 *   -> replay (download, verify BOTH hashes, decompress, no-write validate)
 *   -> prove the source payload is byte-for-byte unchanged.
 *
 * It NEVER connects to or writes to production, and never removes/nulls a
 * payload. Fail-closed guards refuse any non-disposable / non-loopback target.
 *
 * Usage (env points at the disposable e2e DB; see the driver in the runbook):
 *   DB_HOST=127.0.0.1 DB_PORT=3307 DB_NAME=brawlranks_archive_e2e \
 *   DB_USER=root BRAWL_DB_SECRET_V1=<local> ARCHIVE_LOCAL_ROOT=<tmp> \
 *   E2E_SNAPSHOT_ID=<uuid> npx tsx scripts/dataset/archive-e2e-proof.ts
 */

import { getPool } from "../../lib/mysql";
import { LocalFilesystemObjectStorage } from "../../lib/archive/provider";
import { enqueuePendingArchives, getArchiveRow } from "../../lib/archive/repository";
import { archiveOne } from "../../lib/archive/service";
import { replayArchive } from "../../lib/archive/replay";
import { existingValidatorReplay, type ReplayValidationSummary } from "../../lib/archive/replayNormalizer";

const PRODUCTION_MARKERS = ["u350003894", "brawl2", "prod", "production", "live"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const BUCKET = "brawl-archive-e2e";

function refuse(msg: string): never {
  console.error(`REFUSED: ${msg}`);
  process.exit(2);
}

function guard(): void {
  const name = (process.env.DB_NAME ?? "").toLowerCase();
  if (!name) refuse("DB_NAME required.");
  for (const m of PRODUCTION_MARKERS) if (name.includes(m)) refuse(`DB_NAME has production marker "${m}".`);
  if (!LOOPBACK.has(process.env.DB_HOST ?? "")) refuse("DB_HOST must be loopback.");
  if ((process.env.APP_ENV ?? process.env.NODE_ENV ?? "").toLowerCase() === "production") refuse("env is production.");
}

async function main(): Promise<void> {
  guard();
  const root = process.env.ARCHIVE_LOCAL_ROOT;
  if (!root) refuse("ARCHIVE_LOCAL_ROOT (local object-store dir) required.");
  const snapshotId = process.env.E2E_SNAPSHOT_ID;
  if (!snapshotId) refuse("E2E_SNAPSHOT_ID (the seeded snapshot's id) required.");

  const pool = getPool();
  const provider = new LocalFilesystemObjectStorage(root);
  const steps: string[] = [];

  // Capture the source payload BEFORE archiving, to prove it is unchanged after.
  const [beforeRows] = await pool.query<import("mysql2/promise").RowDataPacket[]>(
    "SELECT payload, checksum, endpoint_category FROM raw_api_snapshots WHERE id = ?",
    [snapshotId]
  );
  if (beforeRows.length === 0) refuse(`snapshot ${snapshotId} not found in ${process.env.DB_NAME}`);
  const payloadBefore: string = beforeRows[0].payload;
  const checksumBefore: string = beforeRows[0].checksum;
  const endpointCategory: string = beforeRows[0].endpoint_category;
  steps.push(`source snapshot: ${snapshotId} (${endpointCategory}, ${Buffer.byteLength(payloadBefore, "utf8")} bytes, sha ${checksumBefore.slice(0, 12)}…)`);

  // 1. Enqueue (copy-only).
  const enqueued = await enqueuePendingArchives(pool, { bucket: BUCKET, provider: "local-fs", limit: 50 });
  steps.push(`enqueued ${enqueued} pending archive row(s)`);

  // 2. Archive (gzip -> upload -> HEAD -> GET/verify -> mark verified).
  let verified = false;
  for (let i = 0; i < 50; i++) {
    const outcome = await archiveOne(pool, provider, { bucket: BUCKET, leaseOwner: "e2e-proof" });
    if (outcome.status === "idle") break;
    if (outcome.rawSnapshotId === snapshotId) {
      if (outcome.status === "verified") { verified = true; steps.push(`archived+verified: object ${outcome.objectChecksum.slice(0, 12)}… (${outcome.objectSize} bytes)`); }
      else steps.push(`archive outcome: ${JSON.stringify(outcome)}`);
      break;
    }
  }
  if (!verified) { console.error("archive did not verify"); printReport(steps, false); process.exit(1); }

  const archive = await getArchiveRow(pool, snapshotId);
  steps.push(`archive row: status=${archive?.archiveStatus}, key=${archive?.objectKey}`);

  // 3. Prove the local object file exists on disk (real bytes).
  const head = await provider.headObject(BUCKET, archive!.objectKey);
  steps.push(`object on local store: ${head ? head.size + " bytes" : "MISSING"}`);

  // 4. Replay: download, verify BOTH hashes, decompress, and invoke the
  //    EXISTING ingestion validator in no-write mode (not a generic JSON check).
  let validation: ReplayValidationSummary | undefined;
  const report = await replayArchive(pool, provider, snapshotId, {
    validate: existingValidatorReplay(endpointCategory, (s) => { validation = s; }),
  });
  steps.push(`replay: objectHashOk=${report.objectChecksumOk} originalHashOk=${report.originalChecksumOk} jsonParsed=${report.jsonParsed} sourceUnchanged=${report.sourcePayloadUnchanged}`);
  steps.push(`replay validator (existing ${endpointCategory} validator, no-write): valid=${validation?.validCount} rejected=${validation?.rejectedCount}`);

  // 5. Prove the SOURCE payload is byte-for-byte unchanged.
  const [afterRows] = await pool.query<import("mysql2/promise").RowDataPacket[]>(
    "SELECT payload, checksum FROM raw_api_snapshots WHERE id = ?",
    [snapshotId]
  );
  const unchanged = afterRows[0].payload === payloadBefore && afterRows[0].checksum === checksumBefore;
  steps.push(`source payload unchanged: ${unchanged}`);
  steps.push(`payload_removed_at: ${archive?.payloadRemovedAt ?? "null (never removed)"}`);

  const ok = verified && report.ok && unchanged && archive?.payloadRemovedAt == null;
  printReport(steps, ok);
  await pool.end().catch(() => {});
  process.exit(ok ? 0 : 1);
}

function printReport(steps: string[], ok: boolean): void {
  console.log("DATASET Phase 4 — local end-to-end archive proof");
  console.log(`target: ${process.env.DB_NAME} @ ${process.env.DB_HOST}:${process.env.DB_PORT ?? "3306"}\n`);
  for (const s of steps) console.log(`  - ${s}`);
  console.log(`\n${ok ? "PROOF PASSED — archive + replay verified; source payload intact." : "PROOF FAILED"}`);
}

main().catch(async (err) => {
  console.error(`archive-e2e-proof error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
