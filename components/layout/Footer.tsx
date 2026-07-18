import Image from "next/image";
import Link from "next/link";
import type { FooterLinkGroup } from "@/components/layout/navigation";

const CONTACT_EMAIL = "support@brawlranks.com";

/** Verbatim short-form disclaimer, spec Section 17.2. The full-length version lives on /disclaimer. */
const DISCLAIMER =
  "BrawlRanks is an independent fan site and is not affiliated with or endorsed by Supercell.";

export interface FooterProps {
  /** Data-driven link groups (SEO hub links, legal/trust links) — empty until the pages they'd point to exist, per components/layout/navigation.ts. */
  groups?: readonly FooterLinkGroup[];
}

/**
 * Global footer, restyled to the approved reference composition
 * (reference_pages/contact/Contact.png): full-width dark navy band,
 * centered logo, a horizontal trust/legal link row, copyright at the
 * side. Server Component, no client JS. Only implemented routes are ever
 * linked — the groups come from navigation.ts's LIVE_FOOTER_GROUPS.
 */
export function Footer({ groups = [] }: FooterProps) {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t-[2px] border-[#020a19] bg-[rgb(2_12_31_/_0.98)]">
      <div className="mx-auto max-w-[1180px] px-4 pb-3 pt-2.5">
        <div className="relative mx-auto h-[44px] w-[110px] overflow-hidden">
          <Image
            src="/brand/logo-wordmark.png"
            alt="BrawlRanks"
            width={480}
            height={320}
            className="absolute left-0 top-[-15px] h-auto w-[110px] max-w-none"
          />
        </div>

        <div className="mt-1 flex flex-col items-center gap-2 text-center tablet:relative tablet:min-h-5 tablet:flex-row tablet:justify-center">
          <p className="text-[0.72rem] text-[#aeb9cb] tablet:absolute tablet:left-0">
            © {year} BrawlRanks. Brawl Stars is a trademark of Supercell.
          </p>
          {groups.length > 0 &&
            groups.map((group) => (
              <div key={group.heading} role="group" aria-labelledby={`footer-group-${group.heading}`}>
                <h2 id={`footer-group-${group.heading}`} className="sr-only">
                  {group.heading}
                </h2>
                <ul className="flex flex-wrap items-center justify-center gap-x-7 gap-y-1">
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className="rounded-[var(--radius-control)] text-[0.78rem] text-[#d4ddeb] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          <p className="sr-only">
            {DISCLAIMER}{" "}
            Questions?{" "}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="rounded-[var(--radius-control)] text-[#c3cde0] underline underline-offset-2 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]"
            >
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
