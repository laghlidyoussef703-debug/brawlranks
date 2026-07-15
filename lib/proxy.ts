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
