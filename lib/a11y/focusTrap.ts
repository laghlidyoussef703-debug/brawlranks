/**
 * Framework-agnostic, DOM-driven focus-trap helper (PHASE6.md Section 9 —
 * MobileNav/MobileFilterSheet dialog focus-trap requirement). Deliberately
 * a plain function operating on real DOM nodes/events, not a React hook,
 * so it is directly testable in Node with a minimal DOM implementation
 * without needing a full component-testing framework.
 */

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

export interface FocusTrapHandle {
  /** Removes the trap's keydown listener and restores focus to whatever had it before activation (or to `returnFocusTo`, if given). */
  deactivate: () => void;
}

/**
 * Activates a Tab-cycling focus trap within `container` and focuses its
 * first focusable element. Does not itself handle Escape — pair with
 * `onEscapeKey` (or a caller's own handler) for that, since "close on
 * Escape" and "trap Tab" are independent concerns.
 */
export function activateFocusTrap(
  container: HTMLElement,
  options: { returnFocusTo?: HTMLElement | null } = {}
): FocusTrapHandle {
  const previouslyFocused = options.returnFocusTo ?? (document.activeElement as HTMLElement | null);

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Tab") return;

    const focusable = getFocusableElements(container);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !container.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }

  container.addEventListener("keydown", handleKeydown);
  getFocusableElements(container)[0]?.focus();

  return {
    deactivate() {
      container.removeEventListener("keydown", handleKeydown);
      previouslyFocused?.focus();
    },
  };
}

/** Returns a keydown handler that invokes `handler` only on Escape — for closing a dialog/drawer/overlay. */
export function onEscapeKey(handler: (event: KeyboardEvent) => void): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    if (event.key === "Escape") handler(event);
  };
}
