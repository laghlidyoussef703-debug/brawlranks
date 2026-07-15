import { NextResponse } from "next/server";

// Explicit Node.js runtime (not Edge) — required so this route can later
// reach Hostinger MySQL and the DigitalOcean proxy via standard Node APIs.
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "brawlranks-hostinger-app",
    time: new Date().toISOString(),
  });
}
