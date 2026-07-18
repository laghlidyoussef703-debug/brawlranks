"use client";

import { useId, useState } from "react";

/**
 * The 404 search bar. Per spec Section 16H, site search (`/search`) is
 * deliberately deferred past MVP, so this control is intentionally present
 * but not wired to a backend: submitting never fabricates results or
 * navigates to a non-existent route — it reveals an honest, accessible
 * notice pointing at the popular pages below. Keyboard-usable and
 * screen-reader friendly; no fake behavior.
 */
export function NotFoundSearch() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const id = useId();

  return (
    <form
      role="search"
      aria-label="Search BrawlRanks"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
      }}
    >
      <div className="flex items-center gap-2 rounded-[12px] border-2 border-[#081a3d] bg-[rgb(5_24_60_/_0.92)] p-1.5 pl-4 shadow-[0_3px_0_#050f2b,inset_0_1px_0_rgb(255_255_255_/_0.06)]">
        <span
          aria-hidden="true"
          className="relative block h-4 w-4 shrink-0 rounded-full border-2 border-[#8fa2c8] after:absolute after:-bottom-[6px] after:-right-[5px] after:block after:h-[8px] after:w-[2px] after:rotate-[-45deg] after:rounded-full after:bg-[#8fa2c8]"
        />
        <label htmlFor={id} className="sr-only">
          Search BrawlRanks
        </label>
        <input
          id={id}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search BrawlRanks..."
          className="min-h-11 flex-1 bg-transparent py-1 text-[0.95rem] text-white placeholder:text-[#9eacc4] focus:outline-none"
        />
        <button
          type="submit"
          className="shrink-0 rounded-[9px] border-2 border-[#8a5a06] bg-[linear-gradient(180deg,#ffe066,#f5ac00)] px-5 py-2.5 font-display text-[0.86rem] uppercase tracking-wide text-[#3a2400] shadow-[0_3px_0_#8a5a06] hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
        >
          Search
        </button>
      </div>
      <div role="status" aria-live="polite" className="mt-2 text-center">
        {submitted && (
          <p className="text-[0.8rem] font-semibold text-[#ffd529] [text-shadow:0_1px_1px_rgb(0_0_0_/_0.5)]">
            Site search isn&apos;t available yet — try the popular pages below.
          </p>
        )}
      </div>
    </form>
  );
}
