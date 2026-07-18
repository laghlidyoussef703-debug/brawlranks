import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatic } from "./testUtils/renderStatic";
import { Footer } from "@/components/layout/Footer";

test("Footer: renders the exact spec-mandated disclaimer text verbatim", () => {
  const doc = renderStatic(<Footer />);
  assert.match(
    doc.body.textContent ?? "",
    /BrawlRanks is an independent fan site and is not affiliated with or endorsed by Supercell\./
  );
});

test("Footer: renders a real copyright line with the current year and the Supercell trademark note", () => {
  const doc = renderStatic(<Footer />);
  const year = new Date().getFullYear();
  assert.match(doc.body.textContent ?? "", new RegExp(`${year} BrawlRanks`));
  assert.match(doc.body.textContent ?? "", /Brawl Stars is a trademark of Supercell\./);
});

test("Footer: renders the contact email as a real mailto link", () => {
  const doc = renderStatic(<Footer />);
  const mailLink = doc.querySelector('a[href="mailto:support@brawlranks.com"]');
  assert.ok(mailLink);
});

test("Footer: never claims BrawlRanks owns Fan Kit assets or implies Supercell endorsement", () => {
  const doc = renderStatic(<Footer />);
  const text = doc.body.textContent ?? "";
  assert.doesNotMatch(text, /endorsed by BrawlRanks|BrawlRanks owns|official Supercell partner/i);
});

test("Footer: with no groups, renders no link-group columns (no dead links, per this task's rule)", () => {
  const doc = renderStatic(<Footer groups={[]} />);
  assert.equal(doc.querySelector('[role="group"]'), null);
});

test("Footer: renders accessible link groups when groups are supplied", () => {
  const doc = renderStatic(
    <Footer groups={[{ heading: "Trust", items: [{ label: "About", href: "/about" }] }]} />
  );
  const group = doc.querySelector('[role="group"]');
  assert.ok(group);
  assert.ok(group?.getAttribute("aria-labelledby"));
  const link = doc.querySelector('a[href="/about"]');
  assert.ok(link);
});
