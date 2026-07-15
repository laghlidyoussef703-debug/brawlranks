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
