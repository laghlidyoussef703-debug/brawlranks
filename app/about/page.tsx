import type { Metadata } from "next";
import { AboutContent, ABOUT_METADATA, type AboutImageSrcs } from "@/components/about/AboutContent";
import { buildMetadata } from "@/lib/seo/metadata";

import iconWhatIsBrawlranks from "../../reference_pages/about/icon_total_prestige.png";
import iconWhyWeExist from "../../reference_pages/about/icon_nano_power_cube.png";
import iconAutomation from "../../reference_pages/about/icon_achievements_tv.png";
import iconTrust from "../../reference_pages/about/icon_nano_shield.png";
import iconUnofficial from "../../reference_pages/about/Icon_extended_skull_67.png";
import iconQuestion from "../../reference_pages/about/pattern_loaded_question_mark.png";
import bannerCharacter from "../../reference_pages/about/barley_maple_barley_001.png";
import decorGem from "../../reference_pages/about/gem_red.png";
import decorEmblem from "../../reference_pages/about/emblem_icon_00.png";
import decorPyramid from "../../reference_pages/about/icon_achievements_pyramid_bg.png";

export const metadata: Metadata = buildMetadata(ABOUT_METADATA);

const images: AboutImageSrcs = {
  iconWhatIsBrawlranks: iconWhatIsBrawlranks.src,
  iconWhyWeExist: iconWhyWeExist.src,
  iconAutomation: iconAutomation.src,
  iconTrust: iconTrust.src,
  iconUnofficial: iconUnofficial.src,
  iconQuestion: iconQuestion.src,
  bannerCharacter: bannerCharacter.src,
  decorGem: decorGem.src,
  decorEmblem: decorEmblem.src,
  decorPyramid: decorPyramid.src,
};

export default function AboutPage() {
  return <AboutContent images={images} />;
}
