/**
 * Minimal jsdom-backed DOM environment for the one test file that needs
 * real interactivity (MobileNav's open/close/Escape/focus-restoration
 * behavior — event dispatch and React state updates, not just static
 * markup). Installs jsdom's window/document onto `globalThis` for the
 * lifetime of the calling test file only; each `node:test` file runs in
 * its own process, so this never leaks into other test files.
 */
import { JSDOM } from "jsdom";

export function installDomEnv(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });

  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.self = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.Node = dom.window.Node;
  g.customElements = dom.window.customElements;
  g.requestAnimationFrame = dom.window.requestAnimationFrame ?? ((cb: FrameRequestCallback) => setTimeout(cb, 0));
  g.cancelAnimationFrame = dom.window.cancelAnimationFrame ?? clearTimeout;
  g.requestIdleCallback = (cb: (deadline: unknown) => void) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 0 }), 0);
  g.cancelIdleCallback = clearTimeout;
  // jsdom has no native IntersectionObserver — next/image's lazy-loading
  // path uses one. A minimal stub (never actually fires) is enough since
  // these tests never scroll a real viewport.
  g.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;

  return dom;
}
