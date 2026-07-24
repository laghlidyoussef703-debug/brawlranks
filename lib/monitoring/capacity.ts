/**
 * DATASET Phase 15 — capacity math + forecasting (PURE; no DB, no IO).
 *
 * Growth is measured from prior capacity snapshots. Every edge case is handled
 * explicitly and safely: zero growth and negative growth never produce a scary
 * "days to limit"; a missing configured limit is surfaced as `unknown`, never
 * guessed; insufficient history yields `insufficient_data`, never a fabricated
 * forecast.
 */

import type { MonitoringThresholds } from "./thresholds";

export type ForecastStatus = "healthy" | "warning" | "critical" | "unknown";

export interface CapacityPoint { capturedAt: Date; totalBytes: number }

/**
 * Bytes/day between `current` and the historical snapshot nearest to
 * `targetDays` ago (within `toleranceDays`). Returns null when no snapshot is
 * close enough to that horizon. May be negative (the DB shrank).
 */
export function growthRatePerDay(
  history: CapacityPoint[], current: CapacityPoint, targetDays: number, toleranceDays: number
): number | null {
  const targetMs = current.capturedAt.getTime() - targetDays * 86_400_000;
  const tolMs = toleranceDays * 86_400_000;
  let best: CapacityPoint | null = null;
  let bestDist = Infinity;
  for (const p of history) {
    if (p.capturedAt.getTime() >= current.capturedAt.getTime()) continue;
    const dist = Math.abs(p.capturedAt.getTime() - targetMs);
    if (dist <= tolMs && dist < bestDist) { best = p; bestDist = dist; }
  }
  if (!best) return null;
  const days = (current.capturedAt.getTime() - best.capturedAt.getTime()) / 86_400_000;
  if (days <= 0) return null;
  return (current.totalBytes - best.totalBytes) / days;
}

export interface GrowthRates {
  growth24hBytesPerDay: number | null;
  growth7dBytesPerDay: number | null;
  growth30dBytesPerDay: number | null;
  conservativeBytesPerDay: number | null;
}

/** conservative daily growth = max(7-day rate, 30-day rate, 0). Falls back to the 24h rate only when neither 7d nor 30d is available. */
export function computeGrowthRates(history: CapacityPoint[], current: CapacityPoint): GrowthRates {
  const g24 = growthRatePerDay(history, current, 1, 0.5);
  const g7 = growthRatePerDay(history, current, 7, 2);
  const g30 = growthRatePerDay(history, current, 30, 5);
  const longRates = [g7, g30].filter((r): r is number => r !== null);
  let conservative: number | null;
  if (longRates.length > 0) conservative = Math.max(0, ...longRates);
  else if (g24 !== null) conservative = Math.max(0, g24);
  else conservative = null;
  return { growth24hBytesPerDay: g24, growth7dBytesPerDay: g7, growth30dBytesPerDay: g30, conservativeBytesPerDay: conservative };
}

/**
 * Days until the configured limit is reached. null when the limit is unknown or
 * growth is unknown; Infinity when growth is zero or negative (never imminent).
 */
export function daysToLimit(freeBytes: number | null, conservativeBytesPerDay: number | null): number | null {
  if (freeBytes === null || conservativeBytesPerDay === null) return null;
  if (conservativeBytesPerDay <= 0) return Infinity;
  return freeBytes / conservativeBytesPerDay;
}

export interface FreeCapacity { freeBytes: number | null; freePercent: number | null }

export function computeFree(totalBytes: number, limitBytes: number | null): FreeCapacity {
  if (limitBytes === null || limitBytes <= 0) return { freeBytes: null, freePercent: null };
  const freeBytes = limitBytes - totalBytes;
  return { freeBytes, freePercent: (freeBytes / limitBytes) * 100 };
}

/**
 * Forecast status from the STRICTER of the days-to-limit and free-percent
 * conditions (headroom policy: >=30 days AND >=30% free). `unknown` when neither
 * signal is available (no configured limit).
 */
export function forecastStatus(
  d2l: number | null, freePercent: number | null, t: MonitoringThresholds
): ForecastStatus {
  const states: ForecastStatus[] = [];
  if (d2l !== null && Number.isFinite(d2l)) {
    if (d2l < t.daysToLimitCritical) states.push("critical");
    else if (d2l < t.daysToLimitWarning) states.push("warning");
    else states.push("healthy");
  }
  if (freePercent !== null) {
    if (freePercent < t.freePercentCritical) states.push("critical");
    else if (freePercent < t.freePercentWarning) states.push("warning");
    else states.push("healthy");
  }
  if (states.length === 0) return "unknown";
  if (states.includes("critical")) return "critical";
  if (states.includes("warning")) return "warning";
  return "healthy";
}

export interface Forecast {
  horizonDays: number;
  status: "ok" | "insufficient_data";
  projectedTotalBytes: number | null;
  projectedFreeBytes: number | null;
  projectedFreePercent: number | null;
  projectedDaysToLimit: number | null;
  likelyLimitDate: string | null;
}

/**
 * Projects total size forward by `horizonDays` using the conservative growth
 * rate. Returns `insufficient_data` (never a fabricated number) when history is
 * too thin. Free/percent/limit-date are only produced when the limit is known.
 */
export function forecast(
  params: {
    now: Date; currentTotalBytes: number; limitBytes: number | null;
    conservativeBytesPerDay: number | null; horizonDays: number;
    snapshotCount: number; spanDays: number; thresholds: MonitoringThresholds;
  }
): Forecast {
  const { now, currentTotalBytes, limitBytes, conservativeBytesPerDay, horizonDays, snapshotCount, spanDays, thresholds } = params;
  const insufficient =
    conservativeBytesPerDay === null ||
    snapshotCount < thresholds.minForecastSnapshots ||
    spanDays < thresholds.minForecastSpanDays;
  if (insufficient) {
    return { horizonDays, status: "insufficient_data", projectedTotalBytes: null, projectedFreeBytes: null, projectedFreePercent: null, projectedDaysToLimit: null, likelyLimitDate: null };
  }
  const rate = conservativeBytesPerDay as number;
  const projectedTotalBytes = currentTotalBytes + rate * horizonDays;
  let projectedFreeBytes: number | null = null;
  let projectedFreePercent: number | null = null;
  let projectedDaysToLimit: number | null = null;
  let likelyLimitDate: string | null = null;
  if (limitBytes !== null && limitBytes > 0) {
    projectedFreeBytes = limitBytes - projectedTotalBytes;
    projectedFreePercent = (projectedFreeBytes / limitBytes) * 100;
    const freeNow = limitBytes - currentTotalBytes;
    projectedDaysToLimit = rate > 0 ? freeNow / rate : Infinity;
    if (rate > 0 && freeNow > 0) {
      likelyLimitDate = new Date(now.getTime() + (freeNow / rate) * 86_400_000).toISOString();
    }
  }
  return { horizonDays, status: "ok", projectedTotalBytes, projectedFreeBytes, projectedFreePercent, projectedDaysToLimit, likelyLimitDate };
}

/** Days spanned by the given history relative to `now` (0 when empty). */
export function historySpanDays(history: CapacityPoint[], now: Date): number {
  if (history.length === 0) return 0;
  const oldest = Math.min(...history.map((p) => p.capturedAt.getTime()));
  return (now.getTime() - oldest) / 86_400_000;
}
