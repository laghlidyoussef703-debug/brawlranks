/**
 * Local font loading (PHASE6.md Section 6.2/9). Only licensing-verified
 * fonts are wired here:
 *   - Lilita One — primary display/heading face (SIL OFL 1.1 embedded).
 *   - Noto Sans CJK JP — CJK fallback only (SIL OFL 1.1, fsType=0).
 *
 * Explicitly NOT wired, and must not be added without a documented
 * licensing confirmation: KoBrawl Gothic40/60 (commercial JOONFONT
 * license field, fsType=4 "Restricted License embedding") and Nougat
 * ExtraBlack (no license metadata at all, fsType=4). See PHASE6.md
 * Section 6.2's per-file licensing classification table.
 *
 * Body copy deliberately uses a plain system-font stack (see
 * `--font-body` in app/globals.css), not a loaded font — PHASE6.md
 * documents no verified-license body-copy candidate exists yet, and this
 * task's own instructions default to a system sans-serif stack rather
 * than introducing a new font package for that role.
 */
import localFont from "next/font/local";

/**
 * Preloaded (used above the fold on every page, per PHASE6.md Section
 * 6.2's preload strategy). `next/font/local` auto-calculates fallback-
 * metric overrides from the real font file, minimizing CLS on swap.
 */
// Variable names are deliberately distinct from the Tailwind theme tokens
// of similar name (--font-display / --font-cjk in app/globals.css). Next's
// `variable` option injects this as a real runtime CSS custom property on
// whatever element gets the className (app/layout.tsx's <html>); the
// Tailwind theme tokens then reference it via `@theme inline` rather than
// sharing the same name, which would otherwise create an invalid
// self-referential `var(--x, ...)` inside `--x`'s own definition.
export const displayFont = localFont({
  src: "../font/lilitaone-regular-webfont (2).ttf",
  variable: "--next-font-display-family",
  weight: "400",
  style: "normal",
  display: "swap",
  preload: true,
  fallback: ["ui-rounded", "system-ui", "sans-serif"],
});

/**
 * Not preloaded — loaded only when the page actually renders CJK text
 * (e.g. a Japanese club/player name), per PHASE6.md Section 6.2: shipping
 * this 16–17MB family to every visitor by default would be a real
 * performance regression.
 */
export const cjkFallbackFont = localFont({
  src: [
    { path: "../font/NotoSansCJKjp-Regular (1).otf", weight: "400", style: "normal" },
    { path: "../font/NotoSansCJKjp-Black (1).otf", weight: "900", style: "normal" },
  ],
  variable: "--next-font-cjk-family",
  display: "swap",
  preload: false,
  fallback: ["Hiragino Kaku Gothic ProN", "Yu Gothic", "sans-serif"],
});

/** Combined className to apply once on <html> or <body> — exposes both CSS custom properties without forcing CJK font weight onto every element. */
export const fontVariableClassName = `${displayFont.variable} ${cjkFallbackFont.variable}`;
