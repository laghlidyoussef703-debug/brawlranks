/**
 * Skip-to-content link (PHASE6.md Section 9/24 — "Skip-to-content link in
 * Header"). Placed as the very first focusable element in app/layout.tsx,
 * visually hidden until it receives keyboard focus.
 */
export function SkipLink({ targetId = "main-content" }: { targetId?: string }) {
  return (
    <a
      href={`#${targetId}`}
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-[var(--radius-control)] focus:bg-[var(--color-surface-raised)] focus:px-4 focus:py-2 focus:text-[var(--color-text-primary)] focus:outline focus:outline-2 focus:outline-[var(--color-focus-ring)]"
    >
      Skip to content
    </a>
  );
}
