import type { CSSProperties } from "react";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import siteBackground from "../reference_pages/background.png";
import { displayFont, cjkFallbackFont } from "@/lib/fonts";
import { buildMetadata } from "@/lib/seo/metadata";
import { getSiteUrl } from "@/lib/env";
import { SkipLink } from "@/components/a11y/SkipLink";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { LIVE_NAV_ITEMS, LIVE_FOOTER_GROUPS, FUTURE_NAV_LABELS } from "@/components/layout/navigation";

// metadataBase + robots/canonical/OG defaults every page inherits unless
// it exports its own `metadata` (Next.js's normal per-route override
// behavior) — no client-side metadata injection anywhere in this tree.
export const metadata: Metadata = {
  metadataBase: getSiteUrl(),
  ...buildMetadata({
    description:
      "BrawlRanks tracks real Brawl Stars match data to calculate Brawler tiers, meta shifts, and counters — an independent fan project, not an official Supercell service.",
    pathname: "/",
  }),
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0e14",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${displayFont.variable} ${cjkFallbackFont.variable}`}
      style={{ "--site-background-image": `url(${siteBackground.src})` } as CSSProperties}
    >
      <body className="bg-[var(--color-background)] font-body text-[var(--color-text-primary)] antialiased">
        <SkipLink />
        <Header items={LIVE_NAV_ITEMS} futureLabels={FUTURE_NAV_LABELS} />
        <main id="main-content">{children}</main>
        <Footer groups={LIVE_FOOTER_GROUPS} />
      </body>
    </html>
  );
}
