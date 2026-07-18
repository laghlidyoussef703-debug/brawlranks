import type { Metadata } from "next";
import { NotFoundContent, type NotFoundImageSrcs } from "@/components/not-found/NotFoundContent";

import character from "../reference_pages/404/character.png";
import tierList from "../reference_pages/404/icon_skin_cursed.png";
import brawlers from "../reference_pages/404/icon_in_game_BrawlersMagnet_1_active.png";
import gameModes from "../reference_pages/404/htt_summer_game_mode_icons_800x800.png";
import guides from "../reference_pages/404/icon_map_info.png";
import help from "../reference_pages/404/showdown_icon.png";

// A 404 has no real page context: it is always noindexed, and app/not-found.tsx
// already makes Next.js serve a real HTTP 404 status (spec Section 17.27). No
// canonical is emitted — there is no canonical URL for "page not found".
export const metadata: Metadata = {
  title: "Page Not Found | BrawlRanks",
  robots: { index: false, follow: false },
};

const images: NotFoundImageSrcs = {
  character: character.src,
  tierList: tierList.src,
  brawlers: brawlers.src,
  gameModes: gameModes.src,
  guides: guides.src,
  help: help.src,
};

export default function NotFound() {
  return <NotFoundContent images={images} />;
}
