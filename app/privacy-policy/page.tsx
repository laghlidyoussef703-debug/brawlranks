import type { Metadata } from "next";
import { PrivacyPolicyContent, PRIVACY_POLICY_METADATA, type PrivacyImageSrcs } from "@/components/privacy-policy/PrivacyPolicyContent";
import { buildMetadata } from "@/lib/seo/metadata";

import iconAnalytics from "../../reference_pages/Privacy/icon_achievements_tv.png";
import iconCookies from "../../reference_pages/Privacy/emoji_moba_center.png";
import iconDevice from "../../reference_pages/Privacy/wipeout_icon.png";
import iconLogs from "../../reference_pages/Privacy/icon_modifier_timedeto.png";
import iconContact from "../../reference_pages/Privacy/icon_inbox.png";
import iconPublic from "../../reference_pages/Privacy/icon_leaderboard_demonic.png";
import tick from "../../reference_pages/Privacy/tick.png";
import iconRebound from "../../reference_pages/Privacy/icon_rebound.png";
import iconGem from "../../reference_pages/Privacy/gem_grab_icon.png";
import character from "../../reference_pages/Privacy/barley_maple_barley_001.png";

export const metadata: Metadata = buildMetadata(PRIVACY_POLICY_METADATA);

const images: PrivacyImageSrcs = {
  iconAnalytics: iconAnalytics.src,
  iconCookies: iconCookies.src,
  iconDevice: iconDevice.src,
  iconLogs: iconLogs.src,
  iconContact: iconContact.src,
  iconPublic: iconPublic.src,
  tick: tick.src,
  iconRebound: iconRebound.src,
  iconGem: iconGem.src,
  character: character.src,
};

export default function PrivacyPolicyPage() {
  return <PrivacyPolicyContent images={images} />;
}
