import { createHash } from "node:crypto";
import { FAMILY_ORDER, TABLE_PLANS, type TablePlan } from "./model";

/**
 * DATASET.md Phase 8 scopes.
 *
 * A *scope* is the single, centralized definition of which tables a migration
 * pass touches. It exists so the "minimum continuity state" (Tier-1) and the
 * "full historical backfill" (`all`) can never be confused, and so Tier-1 can
 * never silently expand into the high-volume battle / raw / aggregate history.
 *
 * Tier-1 is FK-closed: every parent referenced by a Tier-1 table (or by the
 * current published snapshot copied via reconcileCurrentPublication) is itself
 * in Tier-1. It deliberately EXCLUDES all historical `normalized_battles`,
 * `battle_*`, `raw_api_snapshots`, `observed_players`, and every rebuildable
 * aggregate/ranking detail table.
 */

export type ScopeTier = "tier-1" | "all";

export interface ScopeDefinition {
  /** Canonical, lower-case scope name. */
  name: string;
  /** Accepted aliases (also lower-case). */
  aliases: readonly string[];
  /** Bumped when the table manifest meaning changes; part of the state binding. */
  version: number;
  tier: ScopeTier;
  description: string;
  /** Tables synchronized by the row engine (order is derived from TABLE_PLANS). */
  engineTables: readonly string[];
  /**
   * When true the CURRENT published snapshot chain is copied transactionally by
   * reconcileCurrentPublication rather than by a full engine copy of every
   * historical published snapshot. This is what keeps Tier-1 "current only".
   */
  currentPublicationOnly: boolean;
  /** Tables pulled in by reconcileCurrentPublication beyond `engineTables`. */
  dependencyExpandedTables: readonly string[];
  /** Reconcile the current publication pointer/items after the table pass. */
  reconcileCurrentPublication: boolean;
  /** Run the scoped global reconciliation limited to `engineTables`. */
  scopedReconciliation: boolean;
}

/**
 * High-volume history that Tier-1 must NEVER include automatically. Used as a
 * self-check so an accidental edit cannot expand Tier-1 into bulk history.
 * (`data_fetch_runs` is intentionally NOT here: it is a small FK parent of
 * normalized_players / patches and is required for continuity.)
 */
export const BULK_HISTORY_TABLES: readonly string[] = [
  "normalized_battles",
  "battle_teams",
  "battle_participants",
  "battle_observations",
  "raw_api_snapshots",
  "raw_snapshot_archives",
  "observed_players",
  "player_name_history",
  "crawl_batches",
  "brawler_mode_aggregates",
  "brawler_overall_aggregates",
  "matchup_aggregates",
  "ranking_results",
  "matchup_results",
];

/**
 * Tier-1 continuity manifest (the ONLY place it is defined).
 *
 * Grouped by purpose for readability; the effective order is always taken from
 * TABLE_PLANS (parent-before-child), never from this array.
 */
const TIER1_ENGINE_TABLES: readonly string[] = [
  // Run + workflow metadata: FK parents of the published chain, dedupe, audit,
  // and active/nonterminal workflow continuity.
  "workflow_runs",
  "data_fetch_runs",
  "aggregation_runs",
  "ranking_runs",
  "workflow_steps",
  "workflow_locks",
  // Canonical configuration + catalogs + current ranking configuration + patches
  // + discovery seeds. All small; all required for correct downstream writes.
  "data_sources",
  "source_endpoints",
  "workflow_definitions",
  "canonical_brawlers",
  "brawler_aliases",
  "gadgets",
  "star_powers",
  "canonical_game_modes",
  "mode_aliases",
  "canonical_maps",
  "map_aliases",
  "seed_players",
  "patches",
  "ranking_rule_sets",
  "ranking_rule_weights",
  "tier_thresholds",
  // Player identity + active crawl state: satisfies participant/last-fetch FKs,
  // preserves active schedules, and enables safe dedupe of new battles.
  "normalized_clubs",
  "normalized_players",
  "player_crawl_schedule",
];

/** Copied transactionally by reconcileCurrentPublication for the current pointer. */
const TIER1_PUBLICATION_TABLES: readonly string[] = [
  "published_snapshots",
  "published_snapshot_items",
  "published_matchup_items",
];

const ALL_TABLES: readonly string[] = [...new Set(TABLE_PLANS.map((plan) => plan.table))];

export const SCOPES: readonly ScopeDefinition[] = [
  {
    name: "tier-1",
    aliases: ["continuity", "tier1"],
    version: 1,
    tier: "tier-1",
    description:
      "Minimum continuity state for a safe writer cutover (Phase 8 Tier-1). " +
      "Excludes all historical battle / raw / observed-player / aggregate / ranking-detail bulk.",
    engineTables: TIER1_ENGINE_TABLES,
    currentPublicationOnly: true,
    dependencyExpandedTables: TIER1_PUBLICATION_TABLES,
    reconcileCurrentPublication: true,
    scopedReconciliation: true,
  },
  {
    name: "all",
    aliases: ["full", "tier-all"],
    version: 1,
    tier: "all",
    description: "Full historical synchronization of every audited table family (Tier-1 + Tier-2 + Tier-3).",
    engineTables: ALL_TABLES,
    currentPublicationOnly: false,
    dependencyExpandedTables: [],
    reconcileCurrentPublication: true,
    scopedReconciliation: true,
  },
];

// --- Load-time integrity guards (fail closed on manifest drift) ------------

const KNOWN_TABLES = new Set(ALL_TABLES);
for (const scope of SCOPES) {
  for (const table of [...scope.engineTables, ...scope.dependencyExpandedTables]) {
    if (!KNOWN_TABLES.has(table)) {
      throw new Error(`Scope integrity error: '${scope.name}' references unknown table '${table}'.`);
    }
  }
}
{
  const tier1 = SCOPES.find((scope) => scope.name === "tier-1")!;
  const tier1Set = new Set([...tier1.engineTables, ...tier1.dependencyExpandedTables]);
  const leaked = BULK_HISTORY_TABLES.filter((table) => tier1Set.has(table));
  if (leaked.length) {
    throw new Error(`Scope integrity error: Tier-1 must not include bulk history tables: ${leaked.join(", ")}.`);
  }
}

// --- Resolution ------------------------------------------------------------

export function resolveScope(name: string): ScopeDefinition {
  const key = String(name).trim().toLowerCase();
  const found = SCOPES.find((scope) => scope.name === key || scope.aliases.includes(key));
  if (!found) {
    throw new Error(
      `Unknown migration scope: ${JSON.stringify(name)}. Known scopes: ${SCOPES.map((scope) => scope.name).join(", ")}. ` +
      `Refusing to run (fail-closed). Tier-1 never expands to 'all'; use --scope all explicitly for full history.`
    );
  }
  return found;
}

/** Ordered engine plans for a scope, in canonical (parent-before-child) order. */
export function scopePlans(scope: ScopeDefinition): TablePlan[] {
  const wanted = new Set(scope.engineTables);
  const plans = TABLE_PLANS.filter((plan) => wanted.has(plan.table));
  const covered = new Set(plans.map((plan) => plan.table));
  const missing = scope.engineTables.filter((table) => !covered.has(table));
  if (missing.length) throw new Error(`Scope '${scope.name}' references tables absent from TABLE_PLANS: ${missing.join(", ")}.`);
  return plans;
}

/** Stable content hash of the manifest; identical inputs always hash identically. */
export function scopeManifestHash(scope: ScopeDefinition): string {
  const payload = JSON.stringify({
    name: scope.name,
    version: scope.version,
    tier: scope.tier,
    engineTables: [...scope.engineTables].sort(),
    dependencyExpandedTables: [...scope.dependencyExpandedTables].sort(),
    currentPublicationOnly: scope.currentPublicationOnly,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export interface ScopeStateIdentity {
  scope: string;
  version: number;
  manifestHash: string;
}

export function scopeStateIdentity(scope: ScopeDefinition): ScopeStateIdentity {
  return { scope: scope.name, version: scope.version, manifestHash: scopeManifestHash(scope) };
}

const familyRank = (family: string): number => {
  const index = (FAMILY_ORDER as readonly string[]).indexOf(family);
  return index === -1 ? FAMILY_ORDER.length : index;
};

export interface ScopeSummary {
  scope: string;
  version: number;
  tier: ScopeTier;
  mode: "dry-run" | "apply";
  description: string;
  manifestHash: string;
  currentPublicationOnly: boolean;
  includedFamilies: string[];
  includedTables: string[];
  dependencyExpandedTables: string[];
  excludedTables: string[];
  excludedBulkHistory: string[];
  completionMeaning: string;
}

/** Human/machine-readable preflight description of a scope. */
export function summarizeScope(scope: ScopeDefinition, mode: "dry-run" | "apply"): ScopeSummary {
  const plans = scopePlans(scope);
  const includedTables = plans.map((plan) => plan.table);
  const includedFamilies = [...new Set(plans.map((plan) => plan.family))].sort((a, b) => familyRank(a) - familyRank(b));
  const covered = new Set([...scope.engineTables, ...scope.dependencyExpandedTables]);
  const excludedTables = ALL_TABLES.filter((table) => !covered.has(table)).sort();
  const excludedBulkHistory = BULK_HISTORY_TABLES.filter((table) => !covered.has(table)).sort();
  return {
    scope: scope.name,
    version: scope.version,
    tier: scope.tier,
    mode,
    description: scope.description,
    manifestHash: scopeManifestHash(scope),
    currentPublicationOnly: scope.currentPublicationOnly,
    includedFamilies,
    includedTables,
    dependencyExpandedTables: [...scope.dependencyExpandedTables],
    excludedTables,
    excludedBulkHistory,
    completionMeaning:
      scope.tier === "tier-1"
        ? "Tier-1 completion means continuity state is reconciled for writer cutover. It is NOT a Tier-2/Tier-3 historical backfill and does not claim full history is migrated."
        : "Full (Tier-1 + Tier-2 + Tier-3) historical synchronization of every audited table.",
  };
}
