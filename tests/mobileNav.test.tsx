/**
 * MobileNav — the one test file in this suite needing real DOM
 * interactivity (event dispatch, React state updates), not just static
 * markup. Installs jsdom globals via testUtils/domEnv before importing
 * react-dom/client or the component under test (done inside `before()`
 * rather than a top-level `await import()`, since this file's CJS
 * transform doesn't support top-level await); each node:test file runs
 * in its own process, so this doesn't affect any other test file.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { installDomEnv } from "./testUtils/domEnv";

installDomEnv();

// Dynamically loaded (inside before()) after jsdom globals are installed —
// typed loosely on purpose, since these are only test-harness plumbing.
let React: any;
let createRoot: any;
let act: any;
let MobileNav: any;
let PLANNED_NAV_ITEMS: any;

before(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  act = React.act;
  ({ MobileNav } = await import("@/components/layout/MobileNav"));
  ({ PLANNED_NAV_ITEMS } = await import("@/components/layout/navigation"));
});

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

async function unmount(root: any, container: HTMLElement) {
  await act(async () => {
    root.unmount();
  });
  container.remove();
}

test("MobileNav: aria-expanded starts false and flips to true when the trigger is clicked", async () => {
  const { container, root } = mount();
  await act(async () => {
    root.render(React.createElement(MobileNav, { items: PLANNED_NAV_ITEMS }));
  });

  const trigger = container.querySelector("button") as HTMLButtonElement;
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.ok(container.querySelector('[role="dialog"]'), "expected the panel to render once open");

  await unmount(root, container);
});

test("MobileNav: Escape closes the open panel and resets aria-expanded", async () => {
  const { container, root } = mount();
  await act(async () => {
    root.render(React.createElement(MobileNav, { items: PLANNED_NAV_ITEMS }));
  });

  const trigger = container.querySelector("button") as HTMLButtonElement;
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.ok(container.querySelector('[role="dialog"]'));

  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");

  await unmount(root, container);
});

test("MobileNav: restores focus to the trigger button after closing", async () => {
  const { container, root } = mount();
  await act(async () => {
    root.render(React.createElement(MobileNav, { items: PLANNED_NAV_ITEMS }));
  });

  const trigger = container.querySelector("button") as HTMLButtonElement;
  trigger.focus();

  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  assert.notEqual(document.activeElement, trigger, "focus should move into the open panel");

  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  assert.equal(document.activeElement, trigger, "focus must return to the trigger button on close");

  await unmount(root, container);
});

test("MobileNav: selecting a nav item closes the panel", async () => {
  const { container, root } = mount();
  await act(async () => {
    root.render(React.createElement(MobileNav, { items: PLANNED_NAV_ITEMS }));
  });

  const trigger = container.querySelector("button") as HTMLButtonElement;
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  const firstNavLink = container.querySelector('nav[aria-label="Primary"] a') as HTMLAnchorElement;
  assert.ok(firstNavLink, "expected at least one nav link in the open panel");

  await act(async () => {
    firstNavLink.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(container.querySelector('[role="dialog"]'), null);

  await unmount(root, container);
});

test("MobileNav: with zero items, the panel still opens and shows a truthful 'coming soon' message rather than a dead link", async () => {
  const { container, root } = mount();
  await act(async () => {
    root.render(React.createElement(MobileNav, { items: [] }));
  });

  const trigger = container.querySelector("button") as HTMLButtonElement;
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(container.querySelector('nav[aria-label="Primary"] a'), null);
  assert.match(container.textContent ?? "", /coming soon/i);

  await unmount(root, container);
});

test("MobileNav: future reference labels remain visible but never become broken links", async () => {
  const { container, root } = mount();
  const futureLabels = ["Tier List", "Brawlers", "Meta"];
  await act(async () => {
    root.render(React.createElement(MobileNav, { items: [], futureLabels }));
  });

  const trigger = container.querySelector("button") as HTMLButtonElement;
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });

  assert.equal(container.querySelector('nav[aria-label="Primary"] a'), null);
  for (const label of futureLabels) {
    assert.match(container.textContent ?? "", new RegExp(label));
  }
  assert.equal(container.querySelectorAll('[aria-disabled="true"]').length, futureLabels.length);

  await unmount(root, container);
});
