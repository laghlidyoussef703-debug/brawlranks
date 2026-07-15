import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* Minimal infrastructure proof-of-concept config.
     Full BrawlRanks configuration (image domains, redirects, etc.)
     will be added when the real platform is implemented. */
  turbopack: {
    // Pin the workspace root explicitly — a stray lockfile in the parent
    // user directory otherwise makes Next.js guess the wrong root.
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
