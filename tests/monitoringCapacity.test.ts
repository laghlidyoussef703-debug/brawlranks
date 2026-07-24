/**
 * DATASET Phase 15 — capacity math + forecasting (pure, DB-free).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  growthRatePerDay, computeGrowthRates, daysToLimit, computeFree, forecastStatus, forecast, historySpanDays,
  type CapacityPoint,
} from "@/lib/monitoring/capacity";
import { loadThresholds } from "@/lib/monitoring/thresholds";

const T = loadThresholds();
const now = new Date("2026-08-01T00:00:00.000Z");
const daysAgo = (d: number): Date => new Date(now.getTime() - d * 86_400_000);

// history where total grows 1e6 bytes/day (older snapshots are smaller).
const linear = (ratePerDay: number, currentTotal: number): CapacityPoint[] => [
  { capturedAt: daysAgo(1), totalBytes: currentTotal - ratePerDay * 1 },
  { capturedAt: daysAgo(7), totalBytes: currentTotal - ratePerDay * 7 },
  { capturedAt: daysAgo(30), totalBytes: currentTotal - ratePerDay * 30 },
];

test("growthRatePerDay computes 24h/7d/30d rates", () => {
  const cur: CapacityPoint = { capturedAt: now, totalBytes: 100_000_000 };
  const h = linear(1_000_000, 100_000_000);
  assert.equal(Math.round(growthRatePerDay(h, cur, 1, 0.5)!), 1_000_000);
  assert.equal(Math.round(growthRatePerDay(h, cur, 7, 2)!), 1_000_000);
  assert.equal(Math.round(growthRatePerDay(h, cur, 30, 5)!), 1_000_000);
});

test("growthRatePerDay returns null when no snapshot near the horizon", () => {
  const cur: CapacityPoint = { capturedAt: now, totalBytes: 100 };
  assert.equal(growthRatePerDay([{ capturedAt: daysAgo(1), totalBytes: 90 }], cur, 30, 5), null);
});

test("conservative growth = max(7d, 30d, 0); zero growth stays 0", () => {
  const cur: CapacityPoint = { capturedAt: now, totalBytes: 100_000_000 };
  const rates = computeGrowthRates(linear(1_000_000, 100_000_000), cur);
  assert.equal(Math.round(rates.conservativeBytesPerDay!), 1_000_000);
  // zero growth (flat history)
  const flat: CapacityPoint[] = [{ capturedAt: daysAgo(7), totalBytes: 100_000_000 }, { capturedAt: daysAgo(30), totalBytes: 100_000_000 }];
  assert.equal(computeGrowthRates(flat, cur).conservativeBytesPerDay, 0);
});

test("negative growth is clamped to 0 (never a scary forecast)", () => {
  const cur: CapacityPoint = { capturedAt: now, totalBytes: 100_000_000 };
  const shrinking: CapacityPoint[] = [{ capturedAt: daysAgo(7), totalBytes: 110_000_000 }, { capturedAt: daysAgo(30), totalBytes: 130_000_000 }];
  const rates = computeGrowthRates(shrinking, cur);
  assert.ok(rates.growth7dBytesPerDay! < 0);
  assert.equal(rates.conservativeBytesPerDay, 0);
  assert.equal(daysToLimit(50_000_000, rates.conservativeBytesPerDay), Infinity);
});

test("daysToLimit: normal, zero growth -> Infinity, missing limit -> null", () => {
  assert.equal(daysToLimit(10_000_000, 1_000_000), 10);
  assert.equal(daysToLimit(10_000_000, 0), Infinity);
  assert.equal(daysToLimit(10_000_000, -5), Infinity);
  assert.equal(daysToLimit(null, 1_000_000), null); // no configured limit
  assert.equal(daysToLimit(10_000_000, null), null); // no growth known
});

test("computeFree handles known + unknown limit", () => {
  assert.deepEqual(computeFree(70, 100), { freeBytes: 30, freePercent: 30 });
  assert.deepEqual(computeFree(70, null), { freeBytes: null, freePercent: null });
});

test("forecastStatus uses the stricter of days-to-limit and free-percent", () => {
  // healthy: 100 days, 50% free
  assert.equal(forecastStatus(100, 50, T), "healthy");
  // free% critical (<20) wins over healthy days
  assert.equal(forecastStatus(100, 15, T), "critical");
  // days warning (<45) with healthy free -> warning
  assert.equal(forecastStatus(40, 50, T), "warning");
  // days critical (<30)
  assert.equal(forecastStatus(20, 50, T), "critical");
  // free% warning (<30)
  assert.equal(forecastStatus(100, 25, T), "warning");
  // both unknown -> unknown
  assert.equal(forecastStatus(null, null, T), "unknown");
  // Infinity days-to-limit is healthy on that axis
  assert.equal(forecastStatus(Infinity, 60, T), "healthy");
});

test("forecast 30/90/365 projects total using conservative rate; free needs a limit", () => {
  const f = forecast({ now, currentTotalBytes: 100_000_000, limitBytes: 200_000_000, conservativeBytesPerDay: 1_000_000, horizonDays: 90, snapshotCount: 10, spanDays: 30, thresholds: T });
  assert.equal(f.status, "ok");
  assert.equal(f.projectedTotalBytes, 190_000_000);
  assert.equal(f.projectedFreeBytes, 10_000_000);
  assert.equal(Math.round(f.projectedFreePercent!), 5);
  assert.equal(f.projectedDaysToLimit, 100); // (200-100)e6 / 1e6
  assert.ok(f.likelyLimitDate);
});

test("forecast returns insufficient_data with thin history (never fabricates)", () => {
  const noRate = forecast({ now, currentTotalBytes: 100, limitBytes: 200, conservativeBytesPerDay: null, horizonDays: 30, snapshotCount: 1, spanDays: 0, thresholds: T });
  assert.equal(noRate.status, "insufficient_data");
  assert.equal(noRate.projectedTotalBytes, null);
  const thin = forecast({ now, currentTotalBytes: 100, limitBytes: 200, conservativeBytesPerDay: 5, horizonDays: 30, snapshotCount: 1, spanDays: 0.2, thresholds: T });
  assert.equal(thin.status, "insufficient_data");
});

test("forecast with unknown limit projects total but leaves free/date null", () => {
  const f = forecast({ now, currentTotalBytes: 100, limitBytes: null, conservativeBytesPerDay: 5, horizonDays: 30, snapshotCount: 5, spanDays: 30, thresholds: T });
  assert.equal(f.status, "ok");
  assert.equal(f.projectedTotalBytes, 250);
  assert.equal(f.projectedFreeBytes, null);
  assert.equal(f.likelyLimitDate, null);
});

test("historySpanDays", () => {
  assert.equal(historySpanDays([], now), 0);
  assert.equal(Math.round(historySpanDays([{ capturedAt: daysAgo(10), totalBytes: 1 }], now)), 10);
});
