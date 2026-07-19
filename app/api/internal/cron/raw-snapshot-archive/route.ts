import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { getWritePool } from "@/lib/mysql";
import { resolveS3Config, S3CompatibleObjectStorage } from "@/lib/archive/s3Provider";
import { enqueuePendingArchives } from "@/lib/archive/repository";
import {
  runArchiveBatch,
  DEFAULT_ARCHIVE_BATCH_SIZE,
  MAX_ARCHIVE_BATCH_SIZE,
} from "@/lib/archive/service";

/**
 * DATASET Phase 4 — protected raw-snapshot archive worker (copy-only).
 *
 * Advances a BOUNDED batch of the archive state machine per call: optionally
 * enqueues the oldest un-archived snapshots (copy-only backfill), then
 * gzip-uploads and verifies up to `batchSize` rows. It NEVER removes or nulls a
 * payload — that is a separate, later, separately-approved work package.
 *
 * Like the aggregation/ranking routes, it does one bounded slice per request so
 * it stays well under the request timeout; a scheduler calls it repeatedly. The
 * DigitalOcean scheduler/timers are NOT touched here, and enabling any timer for
 * this route is an explicit owner action.
 *
 * Requires object storage to be configured (ARCHIVE_S3_*). If it is not, the
 * route returns 503 rather than silently doing nothing — there is no production
 * fallback to local disk.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) {
    logSafeError("raw-snapshot-archive", "UNAUTHORIZED", auth.reason);
    return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  }

  let s3;
  try {
    s3 = resolveS3Config();
  } catch (error) {
    logSafeError("raw-snapshot-archive", "SERVER_MISCONFIGURED", error);
    return NextResponse.json(
      errorBody("SERVER_MISCONFIGURED", "Archive object storage is misconfigured."),
      { status: 503 }
    );
  }
  if (!s3) {
    return NextResponse.json(
      errorBody("SERVER_MISCONFIGURED", "Archive object storage (ARCHIVE_S3_*) is not configured."),
      { status: 503 }
    );
  }

  const body = await request.json().catch(() => null);
  let batchSize = DEFAULT_ARCHIVE_BATCH_SIZE;
  if (body && typeof body.batchSize === "number" && Number.isInteger(body.batchSize) && body.batchSize > 0) {
    batchSize = Math.min(body.batchSize, MAX_ARCHIVE_BATCH_SIZE);
  }
  // Enqueue defaults ON (copy-only). Callers may pass { enqueue: false } to only
  // drain the existing queue.
  const enqueue = !(body && body.enqueue === false);
  const enqueueLimit = Math.min(
    body && typeof body.enqueueLimit === "number" && body.enqueueLimit > 0 ? body.enqueueLimit : batchSize,
    MAX_ARCHIVE_BATCH_SIZE
  );

  try {
    // Writes go through the write-role pool (falls back to the legacy pool when
    // WRITE_DB_* is not configured), matching the operational-write path.
    const pool = getWritePool();
    const provider = new S3CompatibleObjectStorage(s3);

    let enqueued = 0;
    if (enqueue) {
      enqueued = await enqueuePendingArchives(pool, {
        bucket: s3.bucket,
        provider: provider.name,
        limit: enqueueLimit,
      });
    }

    const leaseOwner = `cron-${Date.now().toString(36)}`;
    const summary = await runArchiveBatch(pool, provider, { bucket: s3.bucket, batchSize, leaseOwner });

    return NextResponse.json({ ok: true, enqueued, ...summary }, { status: 200 });
  } catch (error) {
    logSafeError("raw-snapshot-archive", "INTERNAL_ERROR", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", "Archive batch failed unexpectedly."), { status: 500 });
  }
}
