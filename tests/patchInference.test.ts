/**
 * Pure, DB-free patch-inference logic (Phase 5.1). No skip needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldCreatePatch, generateVersionLabel, PATCH_SOURCE_INFERRED } from "@/lib/patches/patchInference";

test("shouldCreatePatch is false for zero detected changes (Section 8.2's no-change case)", () => {
  assert.equal(shouldCreatePatch(0), false);
});

test("shouldCreatePatch is true for any positive change count", () => {
  assert.equal(shouldCreatePatch(1), true);
  assert.equal(shouldCreatePatch(5), true);
  assert.equal(shouldCreatePatch(500), true);
});

test("shouldCreatePatch never throws or goes negative-sensitive on a negative input (defensive — should never actually occur)", () => {
  assert.doesNotThrow(() => shouldCreatePatch(-1));
  assert.equal(shouldCreatePatch(-1), false);
});

test("generateVersionLabel produces the internal-YYYYMMDDTHHMMSSZ shape", () => {
  const label = generateVersionLabel(new Date("2026-07-16T14:32:05.000Z"));
  assert.equal(label, "internal-20260716T143205Z");
});

test("generateVersionLabel is deterministic for the same instant", () => {
  const instant = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(generateVersionLabel(instant), generateVersionLabel(instant));
});

test("generateVersionLabel differs for different instants", () => {
  const a = generateVersionLabel(new Date("2026-07-16T14:32:05.000Z"));
  const b = generateVersionLabel(new Date("2026-07-16T14:32:06.000Z"));
  assert.notEqual(a, b);
});

test("generateVersionLabel zero-pads every component and never claims an official Supercell version format", () => {
  const label = generateVersionLabel(new Date("2026-01-02T03:04:05.000Z"));
  assert.equal(label, "internal-20260102T030405Z");
  assert.ok(label.startsWith("internal-"), "must be clearly labeled internal, never a bare version-looking string");
  assert.doesNotMatch(label, /^v?\d+(\.\d+)+$/, "must not look like a Supercell-style version string (e.g. v56.123)");
});

test("PATCH_SOURCE_INFERRED is the only source value, and is honestly named", () => {
  assert.equal(PATCH_SOURCE_INFERRED, "inferred_from_catalog_change");
});
