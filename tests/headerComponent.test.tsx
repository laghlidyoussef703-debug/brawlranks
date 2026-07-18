import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatic } from "./testUtils/renderStatic";
import { Header } from "@/components/layout/Header";
import { PLANNED_NAV_ITEMS } from "@/components/layout/navigation";

test("Header: with no items, renders only the home link and no <nav> (never a dead-link placeholder)", () => {
  const doc = renderStatic(<Header items={[]} />);
  assert.equal(doc.querySelector('nav[aria-label="Primary"]'), null);
  const homeLink = doc.querySelector('a[aria-label="BrawlRanks home"]');
  assert.ok(homeLink);
  assert.equal(homeLink?.getAttribute("href"), "/");
});

test("Header: with items, renders every item as a real link with the correct href", () => {
  const doc = renderStatic(<Header items={PLANNED_NAV_ITEMS} />);
  for (const item of PLANNED_NAV_ITEMS) {
    const link = doc.querySelector(`a[href="${item.href}"]`);
    assert.ok(link, `expected a link to ${item.href}`);
    assert.match(link?.textContent ?? "", new RegExp(item.label));
  }
});

test("Header: marks the current route's link with aria-current=\"page\", and no other link", () => {
  const doc = renderStatic(<Header items={PLANNED_NAV_ITEMS} currentPath="/tier-list" />);
  const current = doc.querySelectorAll('a[aria-current="page"]');
  assert.equal(current.length, 1);
  assert.equal(current[0].getAttribute("href"), "/tier-list");
});

test("Header: renders no active link when currentPath matches nothing", () => {
  const doc = renderStatic(<Header items={PLANNED_NAV_ITEMS} currentPath="/some-other-page" />);
  assert.equal(doc.querySelectorAll('a[aria-current="page"]').length, 0);
});
