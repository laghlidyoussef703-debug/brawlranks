/**
 * Client for the DigitalOcean fixed-IP proxy service.
 *
 * The proxy — not this Hostinger app — is the only component that ever
 * holds the real Brawl Stars API key (BRAWLRANKS_WEBSITE_SPEC.md Section
 * 24). This module only ever talks to the proxy over HTTPS with a shared
 * signing secret; it never talks to the official Brawl Stars API directly.
 *
 * Expected proxy response envelope for GET /v1/brawlers:
 *   {
 *     "ok": boolean,               // proxy-level success
 *     "status": number,            // HTTP status returned by the official API, as observed by the proxy
 *     "fetchedAt": string,         // ISO timestamp of when the proxy fetched from the official API
 *     "payload": { "items": [...] } // the official API's data, forwarded as-is
 *   }
 * This contract is owned by the proxy service (a separate deployment) — if
 * the real proxy's envelope differs, this parsing logic is the one place to
 * update it.
 *
 * Phase 3 adds client functions for rankings/player/club/battlelog. Per
 * Section 24.4, the proxy exposes only specific, purpose-built endpoints —
 * never a generic pass-through — so each function below targets one fixed,
 * hardcoded path template, mirroring the existing /v1/brawlers pattern.
 * IMPORTANT: the DigitalOcean proxy's own codebase is a separate deployment
 * outside this repository. Whether it has actually been extended to expose
 * these new paths has NOT been verified this session (no live proxy
 * credentials in this local environment — see PHASE3.md "Known
 * limitations"). A live call through any of the new functions below will
 * fail with a 404/transport error until the proxy service itself is
 * deployed with matching support — that deployment is out of this repo's
 * scope and must happen separately.
 */

export const PROXY_TIMEOUT_MS = 15_000;

export interface ProxyBrawlersResult {
  /** Whether the HTTPS request to the proxy itself completed (any response received). */
  proxyReached: boolean;
  /** HTTP status of the fetch call to the proxy. */
  httpStatus: number | null;
  /** Parsed JSON body, if the response was valid JSON. */
  body: unknown;
  /** Set when the request could not be completed at all (network error, timeout, non-JSON body). */
  transportError?: string;
}

interface ProxyEnvelope {
  ok?: boolean;
  status?: number;
  fetchedAt?: string;
  payload?: { items?: unknown[]; [key: string]: unknown };
}

export async function fetchBrawlersFromProxy(): Promise<ProxyBrawlersResult> {
  const baseUrl = process.env.DIGITALOCEAN_PROXY_URL;
  const sharedSecret = process.env.PROXY_SHARED_SECRET;

  if (!baseUrl || !sharedSecret) {
    return {
      proxyReached: false,
      httpStatus: null,
      body: null,
      transportError: "proxy_not_configured",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const res = await fetch(new URL("/v1/brawlers", baseUrl), {
      method: "GET",
      headers: {
        "x-proxy-secret": sharedSecret,
        accept: "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
    });

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      return {
        proxyReached: true,
        httpStatus: res.status,
        body: null,
        transportError: "invalid_json_response",
      };
    }

    return {
      proxyReached: true,
      httpStatus: res.status,
      body,
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      proxyReached: false,
      httpStatus: null,
      body: null,
      transportError: timedOut ? "proxy_timeout" : "proxy_unreachable",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export interface ValidatedBrawlersPayload {
  officialApiStatus: number;
  fetchedAt: string;
  payload: { items: unknown[]; [key: string]: unknown };
}

/**
 * Validates the proxy's response against the three required conditions:
 * outer HTTP status 200, envelope.ok === true, and payload.items is an array.
 * Returns null (never throws) if validation fails for any reason.
 */
export function validateProxyEnvelope(
  result: ProxyBrawlersResult
): ValidatedBrawlersPayload | null {
  if (result.httpStatus !== 200) return null;
  if (result.body === null || typeof result.body !== "object") return null;

  const envelope = result.body as ProxyEnvelope;
  if (envelope.ok !== true) return null;
  if (!envelope.payload || !Array.isArray(envelope.payload.items)) return null;

  const officialApiStatus =
    typeof envelope.status === "number" ? envelope.status : result.httpStatus;
  const fetchedAt =
    typeof envelope.fetchedAt === "string" ? envelope.fetchedAt : new Date().toISOString();

  return {
    officialApiStatus,
    fetchedAt,
    payload: envelope.payload as { items: unknown[]; [key: string]: unknown },
  };
}

// ---------------------------------------------------------------------------
// Phase 3: generic single-object envelope (player/club responses are one
// object, not an { items: [...] } list) plus the shared low-level fetch
// helper every Phase 3 client function below uses. The helper is NOT
// exported — every caller supplies a fixed, hardcoded path template, never
// a caller-controlled arbitrary path, which is what keeps this "one
// function per purpose-built endpoint," not a generic proxy passthrough.
// ---------------------------------------------------------------------------

// Structurally identical to ProxyBrawlersResult (both are the raw
// transport-level shape) — aliased under its own name for readability at
// single-object call sites.
export type ProxyObjectResult = ProxyBrawlersResult;

async function fetchFromProxy(path: string): Promise<ProxyBrawlersResult> {
  const baseUrl = process.env.DIGITALOCEAN_PROXY_URL;
  const sharedSecret = process.env.PROXY_SHARED_SECRET;

  if (!baseUrl || !sharedSecret) {
    return { proxyReached: false, httpStatus: null, body: null, transportError: "proxy_not_configured" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  try {
    const res = await fetch(new URL(path, baseUrl), {
      method: "GET",
      headers: { "x-proxy-secret": sharedSecret, accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      return { proxyReached: true, httpStatus: res.status, body: null, transportError: "invalid_json_response" };
    }

    return { proxyReached: true, httpStatus: res.status, body };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      proxyReached: false,
      httpStatus: null,
      body: null,
      transportError: timedOut ? "proxy_timeout" : "proxy_unreachable",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export interface ValidatedObjectPayload {
  officialApiStatus: number;
  fetchedAt: string;
  payload: Record<string, unknown>;
}

/** Same three-condition validation as validateProxyEnvelope, for a single-object payload rather than a list envelope. */
export function validateProxyObjectEnvelope(result: ProxyObjectResult): ValidatedObjectPayload | null {
  if (result.httpStatus !== 200) return null;
  if (result.body === null || typeof result.body !== "object") return null;

  const envelope = result.body as ProxyEnvelope & { payload?: Record<string, unknown> };
  if (envelope.ok !== true) return null;
  if (!envelope.payload || typeof envelope.payload !== "object") return null;

  const officialApiStatus = typeof envelope.status === "number" ? envelope.status : result.httpStatus;
  const fetchedAt = typeof envelope.fetchedAt === "string" ? envelope.fetchedAt : new Date().toISOString();

  return { officialApiStatus, fetchedAt, payload: envelope.payload };
}

/** GET a single player profile by tag (already percent-encoded, e.g. "%23ABC123"). */
export async function fetchPlayerFromProxy(encodedTag: string): Promise<ProxyObjectResult> {
  return fetchFromProxy(`/v1/players/${encodedTag}`);
}

/** GET a player's recent battle log by tag (already percent-encoded). */
export async function fetchPlayerBattleLogFromProxy(encodedTag: string): Promise<ProxyBrawlersResult> {
  return fetchFromProxy(`/v1/players/${encodedTag}/battlelog`);
}

/** GET a single club profile (including its embedded member list) by tag (already percent-encoded). */
export async function fetchClubFromProxy(encodedTag: string): Promise<ProxyObjectResult> {
  return fetchFromProxy(`/v1/clubs/${encodedTag}`);
}

export type RankingKind = "players" | "clubs" | "brawlers";

/** GET a rankings leaderboard page for one country code ("global" or an ISO country code), optionally scoped to one Brawler. */
export async function fetchRankingsFromProxy(
  kind: RankingKind,
  countryCode: string,
  brawlerSourceId?: string
): Promise<ProxyBrawlersResult> {
  const path =
    kind === "brawlers" && brawlerSourceId
      ? `/v1/rankings/${countryCode}/brawlers/${brawlerSourceId}`
      : `/v1/rankings/${countryCode}/${kind}`;
  return fetchFromProxy(path);
}
