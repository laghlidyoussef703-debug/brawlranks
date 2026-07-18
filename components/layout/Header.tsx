import Image from "next/image";
import Link from "next/link";
import { MobileNav } from "@/components/layout/MobileNav";
import type { NavItem } from "@/components/layout/navigation";

export interface HeaderProps {
  /** Data-driven, not hardcoded — pass LIVE_NAV_ITEMS (or a subset) once routes exist, per components/layout/navigation.ts. Defaults to none. */
  items?: readonly NavItem[];
  /** Current pathname, for aria-current="page" active-state — pass from the calling page/layout. */
  currentPath?: string;
  /**
   * Section labels whose routes don't exist yet (FUTURE_NAV_LABELS) —
   * rendered as non-clickable, accessibly-described text to preserve the
   * approved reference header composition without creating dead links.
   */
  futureLabels?: readonly string[];
}

/**
 * Global header, restyled to the approved reference composition
 * (reference_pages/contact/Contact.png): logo left, bold uppercase
 * section labels across the middle, search/language controls right.
 * Server Component — only `MobileNav`'s open/close state is a client
 * island. The search and language controls are deliberately
 * non-functional visual placeholders with honest accessible labels; no
 * search route or language system exists yet, and faking either is
 * prohibited (PHASE6.md Section 9's no-dead-link/no-fake-behavior rule).
 */
export function Header({ items = [], currentPath, futureLabels = [] }: HeaderProps) {
  const navLabelClass =
    "whitespace-nowrap rounded-[6px] px-3 py-2 font-display text-[0.88rem] uppercase tracking-[0.01em]";

  return (
    <header className="relative z-40 border-b border-[#0b4cb7] bg-[linear-gradient(180deg,rgb(8_75_190_/_0.96),rgb(5_62_166_/_0.9))] shadow-[0_2px_0_rgb(2_30_87_/_0.45)]">
      <div className="mx-auto flex h-[86px] max-w-[1440px] items-center gap-5 px-5 wide:px-8">
        <Link
          href="/"
          aria-label="BrawlRanks home"
          className="relative flex h-[68px] w-[150px] shrink-0 items-center overflow-hidden rounded-[var(--radius-control)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
        >
          <Image
            src="/brand/logo-wordmark.png"
            alt="BrawlRanks"
            width={480}
            height={320}
            priority
            className="absolute left-[-3px] top-[-19px] h-auto w-[160px] max-w-none"
          />
        </Link>

        {items.length > 0 && (
          <nav aria-label="Primary" className="hidden items-center gap-1 wide:flex">
            {items.map((item) => {
              const active = currentPath === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`${navLabelClass} transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)] ${
                    active ? "bg-white/10 text-white" : "text-white hover:bg-white/10"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}

        {futureLabels.length > 0 && (
          <div
            aria-label="Sections coming soon"
            className="mx-auto hidden min-w-0 items-center justify-center gap-1 wide:flex"
          >
            {futureLabels.map((label) => (
              <span key={label} aria-disabled="true" className={`${navLabelClass} cursor-default text-white`}>
                {label}
                <span className="sr-only"> (coming soon)</span>
              </span>
            ))}
          </div>
        )}

        <div className="ml-auto hidden shrink-0 items-center gap-3 wide:flex">
          <div
            aria-label="Site search is not currently available"
            className="flex h-11 w-11 cursor-default items-center justify-center rounded-[7px] border-[2px] border-[#06265f] bg-[rgb(5_42_108_/_0.95)] shadow-[0_2px_0_#041b46]"
          >
            <span
              aria-hidden="true"
              className="relative block h-3.5 w-3.5 rounded-full border-2 border-[#c8d7f2] after:absolute after:-bottom-[5px] after:-right-[4px] after:block after:h-[7px] after:w-[2px] after:rotate-[-45deg] after:rounded-full after:bg-[#c8d7f2]"
            />
          </div>
          <div
            aria-label="Language selection is not currently available — English only"
            className="flex h-11 min-w-[136px] cursor-default items-center gap-2.5 rounded-[7px] border-[2px] border-[#06265f] bg-[rgb(5_42_108_/_0.95)] px-3.5 text-[0.88rem] text-[#eef4ff] shadow-[0_2px_0_#041b46]"
          >
            <span aria-hidden="true" className="block h-3.5 w-3.5 rounded-full border-[1.5px] border-[#c8d7f2] [background:linear-gradient(90deg,transparent_45%,#c8d7f2_45%,#c8d7f2_55%,transparent_55%),linear-gradient(0deg,transparent_45%,#c8d7f2_45%,#c8d7f2_55%,transparent_55%)]" />
            English
          </div>
        </div>

        <div className="ml-auto wide:hidden">
          <MobileNav items={items} futureLabels={futureLabels} currentPath={currentPath} />
        </div>
      </div>
    </header>
  );
}
