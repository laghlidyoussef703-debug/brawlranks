import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("global background: the shared layout provides the approved background asset without replacing the shell", async () => {
  const [layout, css] = await Promise.all([
    readFile("app/layout.tsx", "utf8"),
    readFile("app/globals.css", "utf8"),
  ]);
  assert.match(layout, /reference_pages\/background\.png/);
  assert.match(layout, /--site-background-image/);
  assert.match(css, /var\(--site-background-image, none\)/);
  assert.match(css, /background-repeat: no-repeat/);
  assert.match(css, /background-size: cover/);
});
