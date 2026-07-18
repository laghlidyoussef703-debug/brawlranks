/**
 * Logs only safe, non-sensitive error details to the server console.
 * Never pass raw env vars, headers, or full error objects that might
 * contain a connection string or secret in their message.
 */
export function logSafeError(context: string, code: string, detail?: unknown) {
  const safeDetail =
    detail instanceof Error
      ? detail.message
      : typeof detail === "string"
        ? detail
        : undefined;

  console.error(
    JSON.stringify({
      context,
      code,
      detail: safeDetail,
      time: new Date().toISOString(),
    })
  );
}

/**
 * Structured, non-sensitive info/progress logging (JSON to stdout) for
 * long-running batched workflows. Same safety contract as logSafeError:
 * only pass primitive, non-secret fields. Used for batch-progress and
 * lifecycle telemetry (Phase 5 resumable aggregation/ranking).
 */
export function logSafeInfo(context: string, event: string, detail?: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      level: "info",
      context,
      event,
      ...(detail ?? {}),
      time: new Date().toISOString(),
    })
  );
}

export type ErrorCode =
  | "UNAUTHORIZED"
  | "SERVER_MISCONFIGURED"
  | "PROXY_UNREACHABLE"
  | "PROXY_TIMEOUT"
  | "INVALID_PROXY_RESPONSE"
  | "MYSQL_ERROR"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

export function errorBody(code: ErrorCode, message: string) {
  return {
    ok: false as const,
    error: { code, message },
  };
}
