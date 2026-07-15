import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSlug, normalizeBrawlerItem } from "@/lib/catalog/normalize";
import type { RawBrawlerItem } from "@/lib/catalog/schema";

test("normalize: generateSlug produces a stable lowercase hyphenated slug", () => {
  assert.equal(generateSlug("El Primo"), "el-primo");
  assert.equal(generateSlug("8-BIT"), "8-bit");
  assert.equal(generateSlug("Mr. P"), "mr-p");
});

test("normalize: generateSlug never produces an empty string", () => {
  assert.equal(generateSlug("!!!"), "unnamed");
});

function makeItem(overrides: Partial<RawBrawlerItem> = {}): RawBrawlerItem {
  return {
    id: "16000000",
    name: "SHELLY",
    gadgets: [
      { id: "g2", name: "Second Gadget" },
      { id: "g1", name: "First Gadget" },
    ],
    starPowers: [{ id: "s1", name: "Shell Shock" }],
    ...overrides,
  };
}

test("normalize: checksum is identical across two calls with identical input", () => {
  const a = normalizeBrawlerItem(makeItem());
  const b = normalizeBrawlerItem(makeItem());
  assert.equal(a.payloadChecksum, b.payloadChecksum);
});

test("normalize: checksum is order-independent for nested gadgets/starPowers", () => {
  const a = normalizeBrawlerItem(
    makeItem({ gadgets: [{ id: "g1", name: "First Gadget" }, { id: "g2", name: "Second Gadget" }] })
  );
  const b = normalizeBrawlerItem(
    makeItem({ gadgets: [{ id: "g2", name: "Second Gadget" }, { id: "g1", name: "First Gadget" }] })
  );
  assert.equal(a.payloadChecksum, b.payloadChecksum);
});

test("normalize: checksum changes when a nested item's name changes", () => {
  const a = normalizeBrawlerItem(makeItem());
  const b = normalizeBrawlerItem(
    makeItem({ starPowers: [{ id: "s1", name: "Renamed Star Power" }] })
  );
  assert.notEqual(a.payloadChecksum, b.payloadChecksum);
});

test("normalize: entityId is the source id, not a generated value", () => {
  const result = normalizeBrawlerItem(makeItem({ id: "99999" }));
  assert.equal(result.entityId, "99999");
  assert.equal(result.normalized.sourceId, "99999");
});
