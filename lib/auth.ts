import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison. Avoids leaking secret length/content via
 * response-time differences. If lengths differ, a dummy comparison of equal
 * length is still performed so the timing profile doesn't reveal that fact.
 */
function safeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");

  if (aBuf.length !== bBuf.length) {
    // Compare the buffer against itself to keep timing consistent, then
    // report false — never short-circuit on length alone.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }

  return timingSafeEqual(aBuf, bBuf);
}

export interface AuthResult {
  authorized: boolean;
  reason?: "missing_header" | "malformed_header" | "server_misconfigured" | "invalid_secret";
}

/**
 * Validates `Authorization: Bearer <INTERNAL_CRON_SECRET>` against the
 * server-only INTERNAL_CRON_SECRET env var, using a timing-safe comparison.
 * Never logs or echoes back the presented or expected secret value.
 */
export function verifyInternalCronBearer(request: Request): AuthResult {
  const expected = process.env.INTERNAL_CRON_SECRET;
  if (!expected) {
    return { authorized: false, reason: "server_misconfigured" };
  }

  const header = request.headers.get("authorization");
  if (!header) {
    return { authorized: false, reason: "missing_header" };
  }

  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  if (!match) {
    return { authorized: false, reason: "malformed_header" };
  }

  const presented = match[1];
  if (!safeCompare(presented, expected)) {
    return { authorized: false, reason: "invalid_secret" };
  }

  return { authorized: true };
}
