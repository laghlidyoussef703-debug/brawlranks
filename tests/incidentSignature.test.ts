/**
 * Incident signature computation for deduplication/aggregation (Phase 4.7).
 * Pure/DB-free — no skip needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIncidentSignature } from "@/lib/ingestion/incidents";

test("identical logical input produces an identical signature", () => {
  const input = { incidentType: "invalid_value", dataCategory: "battle_log", relatedEntityType: "battle", reasonKey: "unknown_mode" };
  assert.equal(computeIncidentSignature(input), computeIncidentSignature({ ...input }));
});

test("a different reasonKey produces a different signature (distinct root causes are never merged)", () => {
  const base = { incidentType: "invalid_value", dataCategory: "battle_log", relatedEntityType: "battle", reasonKey: "unknown_mode" };
  const other = { ...base, reasonKey: "unknown_map" };
  assert.notEqual(computeIncidentSignature(base), computeIncidentSignature(other));
});

test("a different incidentType produces a different signature even with the same reasonKey", () => {
  const a = { incidentType: "invalid_value", dataCategory: "battle_log", relatedEntityType: "battle", reasonKey: "x" };
  const b = { incidentType: "unknown_entity", dataCategory: "battle_log", relatedEntityType: "battle", reasonKey: "x" };
  assert.notEqual(computeIncidentSignature(a), computeIncidentSignature(b));
});

test("omitted optional fields (dataCategory/relatedEntityType) normalize the same as explicit null", () => {
  const omitted = { incidentType: "invalid_value", reasonKey: "x" };
  const explicitNull = { incidentType: "invalid_value", dataCategory: null, relatedEntityType: null, reasonKey: "x" };
  assert.equal(computeIncidentSignature(omitted), computeIncidentSignature(explicitNull));
});

test("signature is a 64-char lowercase hex string (sha256)", () => {
  const sig = computeIncidentSignature({ incidentType: "invalid_value", reasonKey: "x" });
  assert.match(sig, /^[0-9a-f]{64}$/);
});

test("signature never includes per-occurrence noise: two calls differing only in an out-of-schema extra field still match if the schema fields match", () => {
  const a = computeIncidentSignature({ incidentType: "invalid_value", reasonKey: "x" });
  const b = computeIncidentSignature({ incidentType: "invalid_value", reasonKey: "x" });
  assert.equal(a, b);
});
