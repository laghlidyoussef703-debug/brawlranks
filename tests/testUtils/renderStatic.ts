/**
 * Renders a Server Component (or a Client Component's initial render) to
 * a queryable jsdom Document, with no live React root and no jsdom
 * globals installed on `globalThis` — safe to use from any test file
 * without affecting others. For components needing real interactivity
 * (event dispatch, state updates), see tests/testUtils/domEnv.ts instead.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { JSDOM } from "jsdom";

export function renderStatic(element: ReactElement): Document {
  const html = renderToStaticMarkup(element);
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  return dom.window.document;
}
