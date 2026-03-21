/** Current API version, returned by `/health` endpoint. */
export const API_VERSION = "1.0.0";

/** Response shape for `GET /health`. */
export interface HealthResponse {
  status: "ok";
  /** Semantic version from `API_VERSION` constant */
  version: string;
  /** ISO 8601 timestamp of response generation */
  timestamp: string;
}

/**
 * Feature flag as returned by the API.
 * All timestamps are ISO 8601 strings.
 */
export interface Flag {
  /** Auto-increment primary key */
  id: number;
  /** Unique flag identifier: lowercase alphanumeric, hyphens, underscores. 1-128 chars. Pattern: `^[a-z0-9_-]+$` */
  key: string;
  /** Human-readable name, 1-256 chars */
  name: string;
  /** Whether the flag is active */
  enabled: boolean;
  /** Optional description, max 1024 chars */
  description: string | null;
  /** ISO 8601 timestamp */
  createdAt: string;
  /** ISO 8601 timestamp */
  updatedAt: string;
}

/** Request body for `POST /api/v1/flags`. */
export interface CreateFlagBody {
  /** Unique flag key: `^[a-z0-9_-]+$`, 1-128 chars */
  key: string;
  /** Human-readable name, 1-256 chars */
  name: string;
  /** Initial state, defaults to `false` */
  enabled?: boolean;
  /** Optional description, max 1024 chars */
  description?: string;
}

/** Request body for `PUT /api/v1/flags/:key`. All fields optional. */
export interface UpdateFlagBody {
  /** Updated name, 1-256 chars */
  name?: string;
  /** Toggle flag state */
  enabled?: boolean;
  /** Updated description, max 1024 chars */
  description?: string;
}

/** Response shape for `GET /api/v1/evaluate/:key`. */
export interface EvaluateResponse {
  /** Flag key that was evaluated */
  key: string;
  /** Resolved flag state */
  enabled: boolean;
  /** ISO 8601 timestamp of evaluation */
  evaluatedAt: string;
  /** Where the value was resolved from — `"cache"` (Redis, 30s TTL) or `"database"` */
  source: "cache" | "database";
}

/**
 * Machine-readable error codes returned by the API.
 * Every error response includes `code`, `message`, and `requestId`.
 */
export type ErrorCode =
  | "FLAG_NOT_FOUND"
  | "FLAG_KEY_EXISTS"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "UNAUTHORIZED";

/** Structured error response returned by all API error paths. */
export interface AppError {
  /** Machine-readable error code */
  code: ErrorCode;
  /** Human-readable error description */
  message: string;
  /** Request correlation ID (UUID or caller-supplied slug) */
  requestId: string;
}
