/**
 * DATASET Phase 15 — alert rules + safe response planner (pure, DB-free).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAlerts, type HealthAlertInput } from "@/lib/monitoring/alerts";
import { planCapacityResponse } from "@/lib/monitoring/responsePlan";
import { loadThresholds } from "@/lib/monitoring/thresholds";

const T = loadThresholds();

function health(over: Partial<HealthAlertInput> = {}): HealthAlertInput {
  return {
    collectorStatus: "ok",
    connectionUsagePercent: 10, lockWaitCount: 0, longRunningQueryCount: 0,
    rawArchiveFailedCount: 0, archiveVerificationFailureCount: 0, oldestPendingArchiveAgeSeconds: 0, rawArchivePendingCount: 0,
    workflowStalledCount: 0, workflowFailedCount: 0, expiredLockCount: 0, oldestActiveWorkflowAgeSeconds: 0,
    currentPublishedSnapshotId: "snap-1", currentPublishedSnapshotAgeSeconds: 3600, currentPublishedSnapshotItemCount: 50,
    latestRankingRunStatus: "succeeded",
    backupAgeSeconds: 3600, restoreTestAgeSeconds: 3600,
    ...over,
  };
}
const keys = (arr: { alertKey: string }[]) => new Set(arr.map((a) => a.alertKey));

test("healthy state fires no alerts", () => {
  const out = evaluateAlerts({ capacity: { daysToLimit: 100, freePercent: 60, forecastStatus: "healthy" }, health: health(), thresholds: T });
  assert.deepEqual(out, []);
});

test("capacity warning + critical thresholds", () => {
  const warn = evaluateAlerts({ capacity: { daysToLimit: 40, freePercent: 60, forecastStatus: "warning" }, health: health(), thresholds: T });
  assert.equal(warn.find((a) => a.alertKey === "capacity:days_to_limit")?.severity, "warning");
  const crit = evaluateAlerts({ capacity: { daysToLimit: 10, freePercent: 15, forecastStatus: "critical" }, health: health(), thresholds: T });
  assert.equal(crit.find((a) => a.alertKey === "capacity:days_to_limit")?.severity, "critical");
  assert.equal(crit.find((a) => a.alertKey === "capacity:free_percent")?.severity, "critical");
});

test("connection saturation warning + critical", () => {
  assert.equal(evaluateAlerts({ capacity: null, health: health({ connectionUsagePercent: 80 }), thresholds: T }).find((a) => a.alertKey === "db:connection_usage")?.severity, "warning");
  assert.equal(evaluateAlerts({ capacity: null, health: health({ connectionUsagePercent: 95 }), thresholds: T }).find((a) => a.alertKey === "db:connection_usage")?.severity, "critical");
});

test("lock waits, archive failure, stalled workflow, expired lock", () => {
  const out = evaluateAlerts({ capacity: null, health: health({ lockWaitCount: 20, rawArchiveFailedCount: 3, workflowStalledCount: 1, expiredLockCount: 2 }), thresholds: T });
  const k = keys(out);
  assert.ok(k.has("db:lock_waits"));
  assert.ok(k.has("archive:failed"));
  assert.ok(k.has("workflow:stalled"));
  assert.ok(k.has("workflow:expired_lock"));
});

test("archive verification failure is critical; backlog growing needs prior snapshot", () => {
  assert.equal(evaluateAlerts({ capacity: null, health: health({ archiveVerificationFailureCount: 1 }), thresholds: T }).find((a) => a.alertKey === "archive:verification_failure")?.severity, "critical");
  const growing = evaluateAlerts({ capacity: null, health: health({ rawArchivePendingCount: 9000 }), prevHealth: { rawArchivePendingCount: 100 }, thresholds: T });
  assert.ok(keys(growing).has("archive:backlog_growing"));
});

test("missing current snapshot is critical; empty snapshot is critical; stale snapshot warns/crits", () => {
  assert.equal(evaluateAlerts({ capacity: null, health: health({ currentPublishedSnapshotId: null }), thresholds: T }).find((a) => a.alertKey === "publishing:no_snapshot")?.severity, "critical");
  assert.equal(evaluateAlerts({ capacity: null, health: health({ currentPublishedSnapshotItemCount: 0 }), thresholds: T }).find((a) => a.alertKey === "publishing:empty_snapshot")?.severity, "critical");
  assert.equal(evaluateAlerts({ capacity: null, health: health({ currentPublishedSnapshotAgeSeconds: 60 * 3600 }), thresholds: T }).find((a) => a.alertKey === "publishing:snapshot_stale")?.severity, "warning");
  assert.equal(evaluateAlerts({ capacity: null, health: health({ currentPublishedSnapshotAgeSeconds: 100 * 3600 }), thresholds: T }).find((a) => a.alertKey === "publishing:snapshot_stale")?.severity, "critical");
});

test("backup age warn/crit; UNKNOWN backup/restore surfaced (not falsely healthy)", () => {
  assert.equal(evaluateAlerts({ capacity: null, health: health({ backupAgeSeconds: 27 * 3600 }), thresholds: T }).find((a) => a.alertKey === "backup:age")?.severity, "warning");
  assert.equal(evaluateAlerts({ capacity: null, health: health({ backupAgeSeconds: 40 * 3600 }), thresholds: T }).find((a) => a.alertKey === "backup:age")?.severity, "critical");
  const unknown = evaluateAlerts({ capacity: null, health: health({ backupAgeSeconds: null, restoreTestAgeSeconds: null }), thresholds: T });
  const k = keys(unknown);
  assert.ok(k.has("backup:evidence_unknown"));
  assert.ok(k.has("restore:evidence_unknown"));
});

test("collector failure raises a critical monitoring alert", () => {
  assert.equal(evaluateAlerts({ capacity: null, health: health({ collectorStatus: "failed" }), thresholds: T }).find((a) => a.alertKey === "monitoring:collector_failure")?.severity, "critical");
});

test("response planner: advisory-only, non-destructive, ordered, only when critical", () => {
  assert.equal(planCapacityResponse("healthy").triggered, false);
  assert.equal(planCapacityResponse("warning").triggered, false);
  const plan = planCapacityResponse("critical");
  assert.equal(plan.triggered, true);
  assert.equal(plan.actions[0].action, "raise_critical_capacity_alert");
  assert.equal(plan.actions[1].action, "freeze_rebuildable_producers");
  assert.ok(plan.actions.every((a) => a.destructive === false), "no destructive action");
  // ordered 1..n
  assert.deepEqual(plan.actions.map((a) => a.order), [1, 2, 3, 4, 5, 6]);
  assert.ok(plan.guarantees.some((g) => /no DELETE/.test(g)));
});
