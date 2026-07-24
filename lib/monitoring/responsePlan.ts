/**
 * DATASET Phase 15 — SAFE capacity response planner (PURE; advisory only).
 *
 * Produces an ORDERED list of recommended, NON-DESTRUCTIVE actions when capacity
 * becomes critical. It NEVER runs anything: no DELETE, no OPTIMIZE, no ALTER, no
 * partitioning, no infra resize, no stopping ingestion, no timer changes. It only
 * returns structured recommendations for a human/incident.
 */

export type ForecastLevel = "healthy" | "warning" | "critical" | "unknown";

export interface RecommendedAction {
  order: number;
  action: string;
  detail: string;
  /** Always false — this planner proposes, it never performs. */
  destructive: false;
}

export interface CapacityResponsePlan {
  triggered: boolean;
  level: ForecastLevel;
  actions: RecommendedAction[];
  guarantees: string[];
}

const A = (order: number, action: string, detail: string): RecommendedAction => ({ order, action, detail, destructive: false });

export function planCapacityResponse(level: ForecastLevel): CapacityResponsePlan {
  const guarantees = [
    "no DELETE / OPTIMIZE / ALTER / partition / resize is performed",
    "canonical ingestion is not stopped automatically",
    "no timer is changed automatically",
    "public reads stay online",
  ];
  if (level !== "critical") {
    return { triggered: false, level, actions: [], guarantees };
  }
  return {
    triggered: true,
    level,
    actions: [
      A(1, "raise_critical_capacity_alert", "Create or escalate the critical capacity alert and open an incident ticket."),
      A(2, "freeze_rebuildable_producers", "Recommend pausing the REBUILDABLE producers first (aggregation rebuild, then ranking rebuild) — they can be recomputed later from canonical data."),
      A(3, "keep_canonical_ingestion_running", "Keep canonical ingestion (battle/player collection) running while write safety permits — its data is not rebuildable."),
      A(4, "request_additional_capacity", "Request/add DigitalOcean managed-MySQL storage capacity (operator action)."),
      A(5, "pause_canonical_writers_if_write_safety_threatened", "ONLY IF write safety is genuinely threatened, recommend pausing canonical writers (operator decision — never automatic)."),
      A(6, "keep_public_reads_online", "Keep the public read path online throughout."),
    ],
    guarantees,
  };
}
