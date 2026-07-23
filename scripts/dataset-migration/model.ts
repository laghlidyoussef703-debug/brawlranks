export type SyncMode = "mutable" | "immutable" | "full" | "parent" | "ephemeral";

export interface CompositeCursor {
  timestamp: string;
  id: string;
}

export interface TablePlan {
  family: string;
  table: string;
  mode: SyncMode;
  cursorColumn?: string;
  naturalKeys?: string[][];
  parent?: { table: string; foreignKey: string; terminalStatuses?: string[] };
  deleteTargetOnly?: boolean;
  /** When present, every other persisted column is an immutable fact. */
  mutableColumns?: string[];
}

export const FAMILY_ORDER = [
  "parent-runs",
  "workflow-children",
  "raw-data",
  "catalogs-config",
  "players",
  "battles",
  "battle-children",
  "derived-public",
] as const;

/**
 * DATASET.md defines the first eight families. Tables introduced by migrations
 * 0026-0029 are placed beside their owning raw/derived families so a current
 * schema is never silently only partly synchronized.
 */
export const TABLE_PLANS: TablePlan[] = [
  { family: "parent-runs", table: "workflow_runs", mode: "mutable", cursorColumn: "created_at", mutableColumns: ["status", "completed_at", "error_summary"] },
  { family: "parent-runs", table: "data_fetch_runs", mode: "mutable", cursorColumn: "created_at", mutableColumns: ["status", "http_status", "attempt_count", "fetched_at", "received_at", "completed_at", "next_attempt_at", "duration_ms", "schema_version", "error_code", "error_message", "retry_reason", "records_fetched", "changes_detected_count", "updated_at"] },
  { family: "parent-runs", table: "aggregation_runs", mode: "mutable", cursorColumn: "created_at", mutableColumns: ["status", "brawlers_processed", "completed_at"] },
  { family: "parent-runs", table: "ranking_runs", mode: "mutable", cursorColumn: "created_at", mutableColumns: ["status", "hold_reason", "tier_move_ratio", "brawlers_evaluated", "brawlers_published", "completed_at"] },

  { family: "workflow-children", table: "workflow_steps", mode: "parent", parent: { table: "workflow_runs", foreignKey: "workflow_run_id" }, naturalKeys: [["workflow_run_id", "step_order"]] },
  { family: "workflow-children", table: "workflow_locks", mode: "ephemeral", deleteTargetOnly: true, naturalKeys: [["workflow_definition_id", "active_flag"]] },

  { family: "raw-data", table: "raw_api_snapshots", mode: "immutable", cursorColumn: "created_at" },
  { family: "raw-data", table: "raw_snapshot_archives", mode: "mutable", cursorColumn: "updated_at", naturalKeys: [["object_bucket", "object_key"]], mutableColumns: ["object_size_bytes", "object_checksum", "archive_status", "attempt_count", "next_attempt_at", "last_error_code", "lease_owner", "lease_expires_at", "upload_started_at", "archived_at", "verified_at", "payload_removed_at", "updated_at"] },

  ...[
    "data_sources", "source_endpoints", "workflow_definitions", "normalized_snapshots",
    "canonical_brawlers", "brawler_aliases", "gadgets", "star_powers", "detected_changes",
    "data_incidents", "canonical_game_modes", "mode_aliases", "canonical_maps", "map_aliases",
    "seed_players", "ingestion_rate_budgets", "patches", "ranking_rule_sets",
    "ranking_rule_weights", "tier_thresholds", "retention_holds",
    "retention_environment_attestations",
  ].filter((table) => ![
    "normalized_snapshots", "brawler_aliases", "detected_changes", "mode_aliases", "map_aliases",
    "ranking_rule_weights", "tier_thresholds", "retention_environment_attestations",
  ].includes(table)).map((table) => ({ family: "catalogs-config", table, mode: "full" as const })),

  // Overrides for append-only/small-table facts and narrowly mutable flags.
  { family: "catalogs-config", table: "normalized_snapshots", mode: "full", mutableColumns: ["is_accepted"] },
  { family: "catalogs-config", table: "brawler_aliases", mode: "immutable" },
  { family: "catalogs-config", table: "detected_changes", mode: "immutable" },
  { family: "catalogs-config", table: "mode_aliases", mode: "immutable" },
  { family: "catalogs-config", table: "map_aliases", mode: "immutable" },
  { family: "catalogs-config", table: "ranking_rule_weights", mode: "immutable" },
  { family: "catalogs-config", table: "tier_thresholds", mode: "immutable" },
  { family: "catalogs-config", table: "retention_environment_attestations", mode: "immutable" },

  { family: "players", table: "observed_players", mode: "full", naturalKeys: [["player_tag"]], mutableColumns: ["promoted_to_active", "promoted_at"] },
  { family: "players", table: "normalized_clubs", mode: "mutable", cursorColumn: "updated_at", naturalKeys: [["club_tag"]] },
  { family: "players", table: "normalized_players", mode: "mutable", cursorColumn: "updated_at", naturalKeys: [["player_tag"]] },
  { family: "players", table: "player_crawl_schedule", mode: "mutable", cursorColumn: "updated_at", naturalKeys: [["player_tag"]] },
  { family: "players", table: "player_name_history", mode: "parent", parent: { table: "normalized_players", foreignKey: "player_id" } },
  { family: "players", table: "crawl_batches", mode: "parent", parent: { table: "workflow_runs", foreignKey: "workflow_run_id" } },

  { family: "battles", table: "normalized_battles", mode: "immutable", cursorColumn: "created_at", naturalKeys: [["battle_key"]] },

  { family: "battle-children", table: "battle_teams", mode: "parent", parent: { table: "normalized_battles", foreignKey: "battle_id" }, naturalKeys: [["battle_id", "team_index"]] },
  { family: "battle-children", table: "battle_participants", mode: "parent", parent: { table: "normalized_battles", foreignKey: "battle_id" }, naturalKeys: [["battle_id", "player_id"]] },
  { family: "battle-children", table: "battle_observations", mode: "immutable", cursorColumn: "observed_at", naturalKeys: [["battle_id", "data_fetch_run_id"]] },

  { family: "derived-public", table: "brawler_mode_aggregates", mode: "parent", parent: { table: "aggregation_runs", foreignKey: "aggregation_run_id", terminalStatuses: ["succeeded", "succeeded_with_warnings"] } },
  { family: "derived-public", table: "brawler_overall_aggregates", mode: "parent", parent: { table: "aggregation_runs", foreignKey: "aggregation_run_id", terminalStatuses: ["succeeded", "succeeded_with_warnings"] } },
  { family: "derived-public", table: "matchup_aggregates", mode: "parent", parent: { table: "aggregation_runs", foreignKey: "aggregation_run_id", terminalStatuses: ["succeeded", "succeeded_with_warnings"] } },
  { family: "derived-public", table: "ranking_results", mode: "parent", parent: { table: "ranking_runs", foreignKey: "ranking_run_id", terminalStatuses: ["succeeded", "held"] } },
  { family: "derived-public", table: "matchup_results", mode: "parent", parent: { table: "ranking_runs", foreignKey: "ranking_run_id", terminalStatuses: ["succeeded", "held"] } },
  // is_current is the one mutable pointer field; immutable snapshot facts and
  // child sets receive an additional atomic reconciliation gate.
  { family: "derived-public", table: "published_snapshots", mode: "mutable", cursorColumn: "created_at", naturalKeys: [["ranking_run_id"]] },
  { family: "derived-public", table: "published_snapshot_items", mode: "parent", parent: { table: "published_snapshots", foreignKey: "published_snapshot_id" } },
  { family: "derived-public", table: "published_matchup_items", mode: "parent", parent: { table: "published_snapshots", foreignKey: "published_snapshot_id" } },
  { family: "derived-public", table: "archived_run_manifests", mode: "full" },
  { family: "derived-public", table: "archived_run_verification_evidence", mode: "parent", parent: { table: "archived_run_manifests", foreignKey: "archived_run_manifest_id" } },
  { family: "derived-public", table: "retention_deletion_manifests", mode: "full" },
  { family: "derived-public", table: "aggregate_trend_summaries", mode: "full" },
];

export function plansFor(selection?: string): TablePlan[] {
  if (!selection || selection === "all") return TABLE_PLANS;
  const byTable = TABLE_PLANS.filter((plan) => plan.table === selection);
  if (byTable.length > 0) return byTable;
  const byFamily = TABLE_PLANS.filter((plan) => plan.family === selection);
  if (byFamily.length > 0) return byFamily;
  throw new Error(`Unknown family/table: ${selection}`);
}

export function compareCursor(a: CompositeCursor, b: CompositeCursor): number {
  const time = a.timestamp.localeCompare(b.timestamp);
  return time !== 0 ? time : a.id.localeCompare(b.id);
}

export function pagePredicate(column: string): string {
  return `(${column} > ? OR (${column} = ? AND id > ?)) AND (${column} < ? OR (${column} = ? AND id <= ?))`;
}
