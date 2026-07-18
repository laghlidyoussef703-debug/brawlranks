"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { activateFocusTrap, onEscapeKey } from "@/lib/a11y/focusTrap";
import type { NavItem } from "@/components/layout/navigation";

/**
 * The smallest possible client island for mobile menu open/close state
 * (PHASE6.md Section 9/14 — Header's nav links themselves stay static/
 * server-rendered; only this trigger+panel needs interactivity).
 */
export function MobileNav({
  items,
  futureLabels = [],
  currentPath,
}: {
  items: readonly NavItem[];
  futureLabels?: readonly string[];
  currentPath?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open || !panelRef.current) return undefined;

    const trap = activateFocusTrap(panelRef.current, { returnFocusTo: triggerRef.current });
    const handleKeydown = onEscapeKey(() => setOpen(false));
    document.addEventListener("keydown", handleKeydown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      trap.deactivate();
      document.removeEventListener("keydown", handleKeydown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((value) => !value)}
        className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
      >
        <span aria-hidden="true" className="relative block h-4 w-5">
          <span
            className={`absolute inset-x-0 top-0 h-0.5 bg-current transition-transform motion-reduce:transition-none ${
              open ? "translate-y-[7px] rotate-45" : ""
            }`}
          />
          <span
            className={`absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-current transition-opacity motion-reduce:transition-none ${
              open ? "opacity-0" : "opacity-100"
            }`}
          />
          <span
            className={`absolute inset-x-0 bottom-0 h-0.5 bg-current transition-transform motion-reduce:transition-none ${
              open ? "-translate-y-[7px] -rotate-45" : ""
            }`}
          />
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Site menu"
          className="fixed inset-0 z-50 flex flex-col bg-[var(--color-surface)] p-4"
        >
          <div className="flex justify-end">
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
              className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] text-xl text-[var(--color-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
            >
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
          <nav aria-label="Primary" className="mt-4 flex flex-col gap-1">
            {items.length === 0 && futureLabels.length === 0 ? (
              <p className="px-3 py-2 text-sm text-[var(--color-text-secondary)]">More pages are coming soon.</p>
            ) : (
              <>
                {items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={currentPath === item.href ? "page" : undefined}
                    onClick={() => setOpen(false)}
                    className="rounded-[var(--radius-control)] px-3 py-3 text-base font-medium text-[var(--color-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
                  >
                    {item.label}
                  </Link>
                ))}
                {futureLabels.map((label) => (
                  <span
                    key={label}
                    aria-disabled="true"
                    className="rounded-[var(--radius-control)] px-3 py-3 font-display text-base uppercase text-[var(--color-text-secondary)]"
                  >
                    {label}
                    <span className="sr-only"> (coming soon)</span>
                  </span>
                ))}
              </>
            )}
          </nav>
        </div>
      )}
    </>
  );
}
