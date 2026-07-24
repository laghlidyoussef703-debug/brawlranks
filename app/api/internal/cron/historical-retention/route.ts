import { NextResponse } from "next/server";
import { verifyInternalCronBearer } from "@/lib/auth";
import { errorBody, logSafeError } from "@/lib/errors";
import { getWritePool } from "@/lib/mysql";
import { resolveS3Config, S3CompatibleObjectStorage } from "@/lib/archive/s3Provider";
import { runRetentionOperation, type RetentionAction } from "@/lib/retention/operations";
import { runRawPayloadSweep } from "@/lib/retention/rawPayload";

export const runtime = "nodejs";
const ACTIONS = new Set<RetentionAction>(["dry-run", "archive", "verify", "reimport", "delete"]);

export async function POST(request: Request) {
  const auth = verifyInternalCronBearer(request);
  if (!auth.authorized) return NextResponse.json(errorBody("UNAUTHORIZED", "Missing or invalid authorization."), { status: 401 });
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const requested = typeof body.action === "string" ? body.action : "dry-run";

  // DATASET Phase 14: raw_api_snapshots payload lifecycle (metadata forever;
  // payload nulled after a verified archive + grace + re-verification). Dry-run
  // by default; a real removal requires body.destructive === true AND the
  // RETENTION_DESTRUCTIVE_ENABLED env flag (enforced inside runRawPayloadSweep).
  if (requested === "raw-payload-dry-run" || requested === "raw-payload-remove") {
    const destructive = requested === "raw-payload-remove" && body.destructive === true;
    try {
      let provider = null;
      if (destructive) {
        const config = resolveS3Config();
        if (!config) return NextResponse.json(errorBody("SERVER_MISCONFIGURED", "Archive storage is not configured."), { status: 503 });
        provider = new S3CompatibleObjectStorage(config);
      }
      const report = await runRawPayloadSweep(getWritePool(), provider, {
        destructiveEnabled: destructive,
        batchSize: typeof body.batchSize === "number" ? body.batchSize : undefined,
        graceDays: typeof body.graceDays === "number" ? body.graceDays : undefined,
        scanLimit: typeof body.scanLimit === "number" ? body.scanLimit : undefined,
        triggeredBy: "cron",
      });
      const status = report.outcome === "lock_not_acquired" ? 409 : 200;
      return NextResponse.json({ ok: status === 200, kind: "raw_payload", ...report }, { status });
    } catch (error) {
      logSafeError("historical-retention", "RAW_PAYLOAD_SWEEP_FAILED", error);
      return NextResponse.json(errorBody("INTERNAL_ERROR", error instanceof Error ? error.message : "Raw payload sweep failed."), { status: 409 });
    }
  }

  const action: RetentionAction = ACTIONS.has(requested as RetentionAction) ? requested as RetentionAction : "dry-run";
  try {
    let provider = null;
    let bucket: string | undefined;
    if (action !== "dry-run") {
      const config = resolveS3Config();
      if (!config) return NextResponse.json(errorBody("SERVER_MISCONFIGURED", "Archive storage is not configured."), { status: 503 });
      provider = new S3CompatibleObjectStorage(config);
      bucket = config.bucket;
    }
    const report = await runRetentionOperation(getWritePool(), provider, {
      action, bucket,
      allowlist: Array.isArray(body.allowlist) && body.allowlist.every((v) => typeof v === "string") ? body.allowlist as string[] : undefined,
      destructive: body.destructive === true,
      batchSize: typeof body.batchSize === "number" ? body.batchSize : undefined,
      environmentId: process.env.RETENTION_ENVIRONMENT_ID,
      forceReimport: body.force === true,
    });
    return NextResponse.json(report);
  } catch (error) {
    logSafeError("historical-retention", "RETENTION_OPERATION_FAILED", error);
    return NextResponse.json(errorBody("INTERNAL_ERROR", error instanceof Error ? error.message : "Retention operation failed."), { status: 409 });
  }
}
