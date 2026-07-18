import type { Metadata } from "next";
import { DisclaimerContent, DISCLAIMER_METADATA, type DisclaimerImageSrcs } from "@/components/disclaimer/DisclaimerContent";
import { buildMetadata } from "@/lib/seo/metadata";

import iconHunters from "../../reference_pages/Disclaimer/icon_hunters.png";
import imageWarningBan from "../../reference_pages/Disclaimer/image_warning_pop_up_ban.png";
import brawlStarsLogo from "../../reference_pages/Disclaimer/zBrawl Stars Logo 2_starr_parkk.png";
import iconQuest from "../../reference_pages/Disclaimer/icon_quest.png";
import iconLeaderboard from "../../reference_pages/Disclaimer/icon_leaderboard_demonic.png";
import iconMobaCenter from "../../reference_pages/Disclaimer/emoji_moba_center.png";
import iconKnockout from "../../reference_pages/Disclaimer/icon_knockout_5v5_power_level.png";
import iconGold from "../../reference_pages/Disclaimer/icon_gold_1.png";
import shieldFront from "../../reference_pages/Disclaimer/shield_front.png";
import iconRebound from "../../reference_pages/Disclaimer/icon_rebound.png";
import iconCalendar from "../../reference_pages/Disclaimer/icon_calendar_league_day.png";
import iconInbox from "../../reference_pages/Disclaimer/icon_inbox.png";
import character from "../../reference_pages/Disclaimer/barley_maple_barley_001.png";

export const metadata: Metadata = buildMetadata(DISCLAIMER_METADATA);

const images: DisclaimerImageSrcs = {
  iconHunters: iconHunters.src,
  imageWarningBan: imageWarningBan.src,
  brawlStarsLogo: brawlStarsLogo.src,
  iconQuest: iconQuest.src,
  iconLeaderboard: iconLeaderboard.src,
  iconMobaCenter: iconMobaCenter.src,
  iconKnockout: iconKnockout.src,
  iconGold: iconGold.src,
  shieldFront: shieldFront.src,
  iconRebound: iconRebound.src,
  iconCalendar: iconCalendar.src,
  iconInbox: iconInbox.src,
  character: character.src,
};

export default function DisclaimerPage() {
  return <DisclaimerContent images={images} />;
}
