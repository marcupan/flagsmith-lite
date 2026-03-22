/**
 * Error response resolution — pure logic extracted from Fastify error handler.
 * Determines statusCode, error code, and user-facing message from any thrown error.
 */

/**
 * Given an unknown error, resolve the HTTP status, machine-readable code,
 * and user-facing message. No I/O — safe to unit-test.
 */
export function resolveErrorResponse(error: unknown): {
  statusCode: number;
  code: string;
  message: string;
} {
  if (error == null || typeof error !== "object") {
    return { statusCode: 500, code: "INTERNAL_ERROR", message: "Internal server error" };
  }

  const statusCode = (error as { statusCode?: number }).statusCode ?? 500;

  return {
    statusCode,
    code:
      (error as { code?: string }).code ??
      (statusCode >= 500 ? "INTERNAL_ERROR" : "VALIDATION_ERROR"),
    message: statusCode >= 500 ? "Internal server error" : (error as Error).message,
  };
}
