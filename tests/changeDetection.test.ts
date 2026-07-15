/**
 * The 9 required change-detection fixture scenarios
 * (BRAWLRANKS_WEBSITE_SPEC.md Section 8), plus the mass-removal protection
 * guard. Composes lib/catalog/schema.ts, lib/catalog/normalize.ts, and
 * lib/catalog/changeDetection.ts exactly as lib/catalog/sync.ts does, but
 * without any database — these are pure-function tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBrawlersPayload } from "@/lib/catalog/schema";
import { normalizeBrawlerItem } from "@/lib/catalog/normalize";
import {
  detectPerEntityChanges,
  detectRemoval,
  detectVolumeAnomaly,
  type PreviousAcceptedEntity,
} from "@/lib/catalog/changeDetection";

function asPrevious(item: ReturnType<typeof normalizeBrawlerItem>): PreviousAcceptedEntity {
  return {
    entityId: item.entityId,
    normalized: item.normalized,
    payloadChecksum: item.payloadChecksum,
  };
}

test("scenario 1: first ingestion of a Brawler produces a new_brawler change", () => {
  const candidate = normalizeBrawlerItem({ id: "1", name: "SHELLY", gadgets: [], starPowers: [] });
  const changes = detectPerEntityChanges(candidate, null);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changeType, "new_brawler");
});

test("scenario 2: repeated identical ingestion produces zero changes", () => {
  const item = { id: "1", name: "SHELLY", gadgets: [], starPowers: [] };
  const first = normalizeBrawlerItem(item);
  const second = normalizeBrawlerItem(item);
  const changes = detectPerEntityChanges(second, asPrevious(first));
  assert.equal(changes.length, 0);
});

test("scenario 3: a pure name change alone produces zero detected_changes rows (handled via alias instead)", () => {
  const before = normalizeBrawlerItem({ id: "1", name: "SHELLY", gadgets: [], starPowers: [] });
  const after = normalizeBrawlerItem({ id: "1", name: "SHELLY_RENAMED", gadgets: [], starPowers: [] });
  const changes = detectPerEntityChanges(after, asPrevious(before));
  assert.equal(changes.length, 0);
});

test("scenario 4: a genuinely new Brawler (never seen before) is detected as new_brawler", () => {
  const candidate = normalizeBrawlerItem({ id: "99", name: "NEW_BRAWLER", gadgets: [], starPowers: [] });
  const changes = detectPerEntityChanges(candidate, null);
  assert.equal(changes[0].changeType, "new_brawler");
  assert.equal(changes[0].entityId, "99");
});

test("scenario 5: a removed Brawler is detected as brawler_removed_or_deprecated", () => {
  const change = detectRemoval("1", "SHELLY");
  assert.equal(change.changeType, "brawler_removed_or_deprecated");
  assert.equal(change.oldValue, "SHELLY");
  assert.equal(change.severity, "warning");
});

test("scenario 6: an invalid payload item (missing name) is rejected before it ever reaches change detection", () => {
  const { valid, rejected } = validateBrawlersPayload([{ id: "1" }]);
  assert.equal(valid.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, "missing_or_invalid_name");
});

test("scenario 7: a partial payload (some valid, some invalid items) still processes the valid items", () => {
  const { valid, rejected } = validateBrawlersPayload([
    { id: "1", name: "SHELLY" },
    { id: "2" },
    { name: "no id" },
  ]);
  assert.equal(valid.length, 1);
  assert.equal(rejected.length, 2);
});

test("scenario 8: an unknown/malformed nested item (bad gadget) is dropped without failing the Brawler", () => {
  const { valid } = validateBrawlersPayload([
    { id: "1", name: "SHELLY", gadgets: [{ id: "g1" }, { id: "g2", name: "Valid Gadget" }] },
  ]);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].gadgets.length, 1);
  assert.equal(valid[0].gadgets[0].name, "Valid Gadget");
});

test("scenario 9: no-change comparison — identical checksums short-circuit to an empty change list", () => {
  const item = { id: "1", name: "SHELLY", gadgets: [{ id: "g1", name: "Gadget" }], starPowers: [] };
  const snapshot = normalizeBrawlerItem(item);
  const changes = detectPerEntityChanges(snapshot, asPrevious(snapshot));
  assert.equal(changes.length, 0);
});

test("mass-removal protection: losing more than half the roster in one run blocks acceptance", () => {
  const previous = ["1", "2", "3", "4", "5", "6"];
  const next = ["1", "2"];
  const result = detectVolumeAnomaly(previous, next);
  assert.equal(result.shouldBlockAcceptance, true);
  assert.equal(result.incident?.changeType, "unexpected_mass_change");
});

test("mass-removal protection: a small, gradual roster change is NOT blocked", () => {
  const previous = ["1", "2", "3", "4", "5", "6"];
  const next = ["1", "2", "3", "4", "5"];
  const result = detectVolumeAnomaly(previous, next);
  assert.equal(result.shouldBlockAcceptance, false);
});

test("mass-removal protection: zero new items when previous data existed is missing_source_data, not a mass removal", () => {
  const result = detectVolumeAnomaly(["1", "2", "3"], []);
  assert.equal(result.shouldBlockAcceptance, true);
  assert.equal(result.incident?.changeType, "missing_source_data");
});

test("mass-removal protection: first-ever ingestion (no previous data) is never blocked", () => {
  const result = detectVolumeAnomaly([], ["1", "2", "3"]);
  assert.equal(result.shouldBlockAcceptance, false);
});
