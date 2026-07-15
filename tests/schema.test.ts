import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBrawlersPayload } from "@/lib/catalog/schema";

test("schema: accepts a well-formed item with gadgets and star powers", () => {
  const { valid, rejected } = validateBrawlersPayload([
    {
      id: "16000000",
      name: "SHELLY",
      gadgets: [{ id: "23000000", name: "Clay Pigeons" }],
      starPowers: [{ id: "23000001", name: "Shell Shock" }],
    },
  ]);
  assert.equal(valid.length, 1);
  assert.equal(rejected.length, 0);
  assert.equal(valid[0].id, "16000000");
  assert.equal(valid[0].gadgets.length, 1);
  assert.equal(valid[0].starPowers.length, 1);
});

test("schema: accepts an item missing gadgets/starPowers entirely (defensive/best-effort)", () => {
  const { valid, rejected } = validateBrawlersPayload([{ id: "16000001", name: "COLT" }]);
  assert.equal(valid.length, 1);
  assert.equal(rejected.length, 0);
  assert.deepEqual(valid[0].gadgets, []);
  assert.deepEqual(valid[0].starPowers, []);
});

test("schema: rejects an item with no id", () => {
  const { valid, rejected } = validateBrawlersPayload([{ name: "NO_ID" }]);
  assert.equal(valid.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, "missing_or_invalid_id");
});

test("schema: rejects an item with no name", () => {
  const { valid, rejected } = validateBrawlersPayload([{ id: "16000002" }]);
  assert.equal(valid.length, 0);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, "missing_or_invalid_name");
});

test("schema: rejects a non-object item without crashing the rest of the batch", () => {
  const { valid, rejected } = validateBrawlersPayload([null, "not-an-object", { id: "1", name: "OK" }]);
  assert.equal(valid.length, 1);
  assert.equal(rejected.length, 2);
  assert.equal(rejected[0].reason, "not_an_object");
});

test("schema: drops a malformed nested gadget entry without rejecting the parent Brawler", () => {
  const { valid, rejected } = validateBrawlersPayload([
    {
      id: "16000003",
      name: "BULL",
      gadgets: [{ id: "23000002", name: "Good Gadget" }, { name: "Missing Id" }, "not-an-object"],
    },
  ]);
  assert.equal(valid.length, 1);
  assert.equal(rejected.length, 0);
  assert.equal(valid[0].gadgets.length, 1);
  assert.equal(valid[0].gadgets[0].name, "Good Gadget");
});

test("schema: unknown extra fields on an item never cause rejection", () => {
  const { valid, rejected } = validateBrawlersPayload([
    { id: "16000004", name: "EL_PRIMO", rarity: "Starting Brawler", futureField: { nested: true } },
  ]);
  assert.equal(valid.length, 1);
  assert.equal(rejected.length, 0);
});

test("schema: coerces a numeric id to string", () => {
  const { valid } = validateBrawlersPayload([{ id: 16000005, name: "POCO" }]);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].id, "16000005");
});
