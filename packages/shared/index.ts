// ── Re-exports from submodules ──────────────────────────────────────────
export { type Brand, FlagKey, type FlagKey as FlagKeyType, Timestamp } from "./branded.js";
export type { Timestamp as TimestampType } from "./branded.js";
export { exhaustive } from "./exhaustive.js";

// ── Constants ───────────────────────────────────────────────────────────

/** Current API version, returned by `/health` endpoint. */
export const API_VERSION = "1.0.0";

// ── Branded type re-imports (used in interfaces below) ──────────────────
import type { FlagKey, Timestamp } from "./branded.js";

// ── Health ──────────────────────────────────────────────────────────────

/** Response shape for `GET /health`. */
export interface HealthResponse {
  status: "ok";
  /** Semantic version from `API_VERSION` constant */
  version: string;
  /** ISO 8601 timestamp of response generation */
  timestamp: Timestamp;
}

// ── Flags ───────────────────────────────────────────────────────────────

/**
 * Feature flag as returned by the API.
 * All timestamps are branded ISO 8601 strings.
 */
export interface Flag {
  /** Auto-increment primary key */
  id: number;
  /** Unique flag identifier: lowercase alphanumeric, hyphens, underscores. 1-128 chars. */
  key: FlagKey;
  /** Human-readable name, 1-256 chars */
  name: string;
  /** Whether the flag is active */
  enabled: boolean;
  /** Optional description, max 1024 chars */
  description: string | null;
  /** ISO 8601 timestamp */
  createdAt: Timestamp;
  /** ISO 8601 timestamp */
  updatedAt: Timestamp;
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

// ── Evaluate ────────────────────────────────────────────────────────────

/** Response shape for `GET /api/v1/evaluate/:key`. */
export interface EvaluateResponse {
  /** Flag key that was evaluated */
  key: FlagKey;
  /** Resolved flag state */
  enabled: boolean;
  /** ISO 8601 timestamp of evaluation */
  evaluatedAt: Timestamp;
  /** Where the value was resolved from — `"cache"` (Redis, 30s TTL) or `"database"` */
  source: "cache" | "database";
}

// ── Errors ──────────────────────────────────────────────────────────────

/**
 * Canonical error definitions. `as const satisfies` gives us:
 * 1. Literal types preserved (404, not `number`) via `as const`
 * 2. Shape validation (every entry has status and message) via `satisfies`
 */
export const ErrorCodes = {
  FLAG_NOT_FOUND: { status: 404, message: "Flag not found" },
  FLAG_KEY_EXISTS: { status: 409, message: "Flag with this key already exists" },
  VALIDATION_ERROR: { status: 400, message: "Validation error" },
  UNAUTHORIZED: { status: 401, message: "Invalid or missing API key" },
  INTERNAL_ERROR: { status: 500, message: "Internal server error" },
  SERVICE_UNAVAILABLE: { status: 503, message: "Service unavailable" },
} as const satisfies Record<string, { status: number; message: string }>;

/** Machine-readable error codes returned by the API. */
export type ErrorCode = keyof typeof ErrorCodes;

/**
 * Create a structured error payload from an ErrorCode.
 * Used by both the shared layer and the API's AppError class.
 */
export function createError(code: ErrorCode, overrideMessage?: string) {
  const def = ErrorCodes[code];

  return {
    code,
    message: overrideMessage ?? def.message,
    status: def.status,
  };
}

/** Structured error response returned by all API error paths. */
export interface AppErrorResponse {
  /** Machine-readable error code */
  code: ErrorCode;
  /** Human-readable error description */
  message: string;
  /** Request correlation ID (UUID or caller-supplied slug) */
  requestId: string;
}
