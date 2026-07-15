/**
 * Centralized failure classification and retry/backoff policy.
 * Spec: BRAWLRANKS_WEBSITE_SPEC.md Section 29 (failure handling table),
 * Section 7.23 (exponential backoff, Retry-After).
 *
 * Every classification below maps a raw failure signal (HTTP status,
 * transport error code) to: whether it's retryable at all, how many
 * attempts are allowed, and the next-attempt delay. Nothing here ever
 * retries a permanent 404 indefinitely or blindly retries a schema
 * mismatch (Section 29's explicit "no retry" rows).
 */

export type FailureCode =
  | "timeout"
  | "network_failure"
  | "proxy_unavailable"
  | "rate_limited"
  | "server_error"
  | "unauthorized"
  | "not_found"
  | "schema_mismatch"
  | "invalid_data"
  | "transaction_failure"
  | "deadlock"
  | "lock_timeout";

export interface RetryClassification {
  code: FailureCode;
  retryable: boolean;
  maxAttempts: number;
  /** Marks the fetch run / crawl-schedule row 'dead' rather than retried once maxAttempts is reached. */
  terminalStatus: "dead" | "failed";
}

const CLASSIFICATIONS: Record<FailureCode, RetryClassification> = {
  timeout: { code: "timeout", retryable: true, maxAttempts: 3, terminalStatus: "failed" },
  network_failure: { code: "network_failure", retryable: true, maxAttempts: 3, terminalStatus: "failed" },
  proxy_unavailable: { code: "proxy_unavailable", retryable: true, maxAttempts: 3, terminalStatus: "failed" },
  rate_limited: { code: "rate_limited", retryable: true, maxAttempts: 5, terminalStatus: "failed" },
  server_error: { code: "server_error", retryable: true, maxAttempts: 3, terminalStatus: "failed" },
  unauthorized: { code: "unauthorized", retryable: false, maxAttempts: 1, terminalStatus: "dead" },
  not_found: { code: "not_found", retryable: false, maxAttempts: 1, terminalStatus: "dead" },
  schema_mismatch: { code: "schema_mismatch", retryable: false, maxAttempts: 1, terminalStatus: "dead" },
  invalid_data: { code: "invalid_data", retryable: false, maxAttempts: 1, terminalStatus: "dead" },
  transaction_failure: { code: "transaction_failure", retryable: true, maxAttempts: 3, terminalStatus: "failed" },
  deadlock: { code: "deadlock", retryable: true, maxAttempts: 3, terminalStatus: "failed" },
  lock_timeout: { code: "lock_timeout", retryable: true, maxAttempts: 3, terminalStatus: "failed" },
};

export function classifyHttpStatus(status: number | null, transportError?: string): FailureCode {
  if (transportError === "proxy_timeout") return "timeout";
  if (transportError === "proxy_unreachable" || transportError === "proxy_not_configured") return "proxy_unavailable";
  if (transportError === "invalid_json_response") return "schema_mismatch";
  if (status === null) return "network_failure";
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status >= 500) return "server_error";
  return "invalid_data";
}

export function classifyMysqlError(error: unknown): FailureCode {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined;
  if (code === "ER_LOCK_DEADLOCK") return "deadlock";
  if (code === "ER_LOCK_WAIT_TIMEOUT") return "lock_timeout";
  return "transaction_failure";
}

export function getClassification(code: FailureCode): RetryClassification {
  return CLASSIFICATIONS[code];
}

const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 5 * 60_000;

/**
 * Exponential backoff with full jitter: delay = random(0, min(maxDelay,
 * base * 2^attempt)). `attempt` is 1-indexed (the delay computed BEFORE
 * the next attempt, i.e. after `attempt` failures so far).
 */
export function computeBackoffMs(attempt: number, retryAfterSeconds?: number | null): number {
  if (retryAfterSeconds !== undefined && retryAfterSeconds !== null && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, MAX_DELAY_MS);
  }
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exponential);
}

export interface RetryDecision {
  shouldRetry: boolean;
  nextAttemptDelayMs: number;
  terminalStatus: "dead" | "failed";
}

export function decideRetry(
  code: FailureCode,
  attemptCount: number,
  retryAfterSeconds?: number | null
): RetryDecision {
  const classification = getClassification(code);
  if (!classification.retryable || attemptCount >= classification.maxAttempts) {
    return { shouldRetry: false, nextAttemptDelayMs: 0, terminalStatus: classification.terminalStatus };
  }
  return {
    shouldRetry: true,
    nextAttemptDelayMs: computeBackoffMs(attemptCount, retryAfterSeconds),
    terminalStatus: classification.terminalStatus,
  };
}
