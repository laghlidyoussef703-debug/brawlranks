/**
 * Region/country-code validation and normalization (Phase 4.1). Pure/DB-free — no skip needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidCountryCodeShape, normalizeCountryCode, CURATED_REGIONS, CURATED_REGION_CODES } from "@/lib/ingestion/regions";

test("global (any case) is a valid shape", () => {
  assert.equal(isValidCountryCodeShape("global"), true);
  assert.equal(isValidCountryCodeShape("GLOBAL"), true);
  assert.equal(isValidCountryCodeShape("Global"), true);
});

test("exactly two ASCII letters is a valid shape, in either case", () => {
  assert.equal(isValidCountryCodeShape("us"), true);
  assert.equal(isValidCountryCodeShape("US"), true);
  assert.equal(isValidCountryCodeShape("Br"), true);
});

test("invalid shapes are rejected: wrong length, digits, symbols, empty, SQL-injection-shaped input", () => {
  assert.equal(isValidCountryCodeShape(""), false);
  assert.equal(isValidCountryCodeShape("u"), false);
  assert.equal(isValidCountryCodeShape("usa"), false);
  assert.equal(isValidCountryCodeShape("u1"), false);
  assert.equal(isValidCountryCodeShape("--"), false);
  assert.equal(isValidCountryCodeShape("us; DROP TABLE seed_players;"), false);
  assert.equal(isValidCountryCodeShape("<script>"), false);
});

test("normalizeCountryCode lowercases a valid real code and leaves global as global", () => {
  assert.equal(normalizeCountryCode("US"), "us");
  assert.equal(normalizeCountryCode("us"), "us");
  assert.equal(normalizeCountryCode("GLOBAL"), "global");
  assert.equal(normalizeCountryCode(" br "), "br");
});

test("normalizeCountryCode returns null for shape-invalid input rather than guessing or truncating", () => {
  assert.equal(normalizeCountryCode("usa"), null);
  assert.equal(normalizeCountryCode(""), null);
  assert.equal(normalizeCountryCode("1x"), null);
});

test("CURATED_REGION_CODES is derived from CURATED_REGIONS and every entry is itself shape-valid", () => {
  assert.equal(CURATED_REGION_CODES.length, CURATED_REGIONS.length);
  for (const code of CURATED_REGION_CODES) {
    assert.equal(isValidCountryCodeShape(code), true);
  }
});

test("CURATED_REGION_CODES has no duplicate entries", () => {
  assert.equal(new Set(CURATED_REGION_CODES).size, CURATED_REGION_CODES.length);
});

test("global is present in the curated set as the existing production baseline", () => {
  assert.ok(CURATED_REGION_CODES.includes("global"));
});
