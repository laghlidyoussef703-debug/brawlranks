export interface NavItem {
  label: string;
  href: string;
}

/**
 * The full planned header nav, in spec Section 17.2's exact order. Not all
 * of these routes exist yet (Phase 6A ships none of them) — this is
 * reference/fixture data for future subphases and component tests, not
 * something Phase 6A's own app/layout.tsx spreads into a live Header.
 * Wiring an item in here into LIVE_NAV_ITEMS below is only correct once
 * its route actually ships.
 */
export const PLANNED_NAV_ITEMS: readonly NavItem[] = [
  { label: "Tier List", href: "/tier-list" },
  { label: "Brawlers", href: "/brawlers" },
  { label: "Game Modes", href: "/game-modes" },
  { label: "Meta", href: "/meta" },
  { label: "Best Brawlers", href: "/best-brawlers" },
  { label: "Guides", href: "/guides" },
  { label: "Updates", href: "/updates" },
];

/**
 * Nav items actually safe to render as live links today. Phase 6A ships
 * no public route beyond "/", so this is intentionally empty — each later
 * subphase should extend this list only as its own routes ship, per this
 * task's "do not link users to empty placeholder pages" rule.
 */
export const LIVE_NAV_ITEMS: readonly NavItem[] = [];

/**
 * Reference-header section labels whose routes do not exist yet
 * (reference_pages/contact/Contact.png's approved header composition).
 * Rendered by Header as non-clickable, accessibly-labeled text — never as
 * links — until each route actually ships and moves into LIVE_NAV_ITEMS.
 */
export const FUTURE_NAV_LABELS: readonly string[] = [
  "Tier List",
  "Brawlers",
  "Meta",
  "Builds",
  "Guides",
  "Counters",
  "Updates",
];

export interface FooterLinkGroup {
  heading: string;
  items: readonly NavItem[];
}

/** Only implemented public routes are linked. Later Phase 6B pages must add themselves incrementally. */
export const LIVE_FOOTER_GROUPS: readonly FooterLinkGroup[] = [
  {
    heading: "Trust",
    items: [
      { label: "Privacy Policy", href: "/privacy-policy" },
      { label: "Terms of Service", href: "/terms-of-service" },
      { label: "Disclaimer", href: "/disclaimer" },
      { label: "Contact", href: "/contact" },
      { label: "About", href: "/about" },
      { label: "Editorial Policy", href: "/editorial-policy" },
    ],
  },
];
