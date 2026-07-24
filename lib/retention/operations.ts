import type { Pool, RowDataPacket } from "mysql2/promise";
import type { ObjectStorageProvider } from "@/lib/archive/provider";
import { planRetention } from "./planner";
import { exportRunToArchive, verifyArchivedRun, reimportArchivedRunToStaging } from "./archive";
import { deleteRunChildRows, validateExactRunAllowlist } from "./deletion";
import { hasIsolatedStagingAttestation } from "./repository";

export type RetentionAction = "dry-run" | "archive" | "verify" | "reimport" | "delete";
export interface OperationOptions {
  action?: RetentionAction; allowlist?: string[]; bucket?: string; environmentId?: string;
  destructive?: boolean; batchSize?: number; codeVersion?: string | null;
  forceReimport?: boolean;
}

async function provenance(db: Pool, kind: string, id: string): Promise<{ rule: string | null; patch: string | null }> {
  if (kind === "ranking_run") {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT rs.version rule_version, p.version_label patch_version FROM ranking_runs r
       LEFT JOIN ranking_rule_sets rs ON rs.id = r.ranking_rule_set_id
       LEFT JOIN patches p ON p.id = r.patch_id WHERE r.id = ?`, [id]);
    return { rule: rows[0]?.rule_version ?? null, patch: rows[0]?.patch_version ?? null };
  }
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT GROUP_CONCAT(DISTINCT p.version_label ORDER BY p.version_label SEPARATOR ',') patch_versions
       FROM (SELECT patch_id FROM brawler_mode_aggregates WHERE aggregation_run_id = ?
             UNION SELECT patch_id FROM brawler_overall_aggregates WHERE aggregation_run_id = ?
             UNION SELECT patch_id FROM matchup_aggregates WHERE aggregation_run_id = ?) x
       LEFT JOIN patches p ON p.id = x.patch_id`, [id, id, id]);
  return { rule: null, patch: rows[0]?.patch_versions ?? null };
}

export async function runRetentionOperation(db: Pool, provider: ObjectStorageProvider | null, options: OperationOptions = {}) {
  const action = options.action ?? "dry-run";
  const plan = await planRetention(db);
  if (action === "dry-run") return { ok: true, action, destructive: false, writes: 0, plan };
  if (!provider || !options.bucket) throw new Error("archive_storage_required");
  const allowlist = validateExactRunAllowlist(options.allowlist ?? []);
  const targets = plan.allowlist.filter((target) => allowlist.includes(target.runId));
  if (!targets.length || new Set(targets.map((t) => t.runId)).size !== allowlist.length) throw new Error("allowlist_contains_ineligible_or_unknown_run");

  if ((action === "reimport" || action === "delete") &&
      !(await hasIsolatedStagingAttestation(db, options.environmentId))) throw new Error("isolated_staging_attestation_required");

  const results: unknown[] = [];
  const codeVersion = options.codeVersion ?? process.env.GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null;
  if (action === "archive" && !codeVersion) throw new Error("code_version_required");
  for (const target of targets) {
    if (action === "archive") {
      const p = await provenance(db, target.runKind, target.runId);
      results.push(await exportRunToArchive(db, provider, { ...target, bucket: options.bucket,
        codeVersion,
        ruleSetVersion: p.rule, patchContext: p.patch }));
    } else if (action === "verify") {
      results.push(await verifyArchivedRun(db, provider, target.runKind, target.runId, target.sourceTable));
    } else if (action === "reimport") {
      results.push(await reimportArchivedRunToStaging(db, provider, target.runKind, target.runId, target.sourceTable, options.forceReimport));
    } else {
      if (options.destructive !== true) throw new Error("explicit_destructive_flag_required");
      results.push(await deleteRunChildRows(db, { ...target, allowlist, dryRun: false, batchSize: options.batchSize }));
    }
  }
  return { ok: true, action, destructive: action === "delete", allowlist, targets, results };
}
