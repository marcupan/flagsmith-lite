// ── Re-exports from submodules ──────────────────────────────────────────
export { type Brand, FlagKey, type FlagKey as FlagKeyType, Timestamp } from "./branded.js";
export type { Timestamp as TimestampType } from "./branded.js";
export { exhaustive } from "./exhaustive.js";
export { canTransition, transition, isTerminal, nextStates } from "./state-machine.js";

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
  WEBHOOK_NOT_FOUND: { status: 404, message: "Webhook subscription not found" },
  WEBHOOK_INVALID_URL: { status: 400, message: "Invalid webhook URL" },
  WEBHOOK_INVALID_EVENTS: { status: 400, message: "Invalid webhook event types" },
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

// ── Webhooks ─────────────────────────────────────────────────────────────

/** Event types that trigger webhook delivery to subscribed consumers. */
export type WebhookEventType = "flag.toggled" | "flag.created" | "flag.deleted";

/** All known webhook event types, for runtime validation. */
export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = [
  "flag.toggled",
  "flag.created",
  "flag.deleted",
] as const;

/** Webhook subscription as returned by the API. */
export interface WebhookSubscription {
  id: number;
  /** Consumer URL that receives POST notifications */
  url: string;
  /** Which events this subscription listens for */
  events: WebhookEventType[];
  /** Whether this subscription is active */
  active: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Request body for `POST /api/v1/webhooks`. */
export interface CreateWebhookBody {
  /** Consumer endpoint URL (must be https in production, http allowed in dev) */
  url: string;
  /** Events to subscribe to */
  events: WebhookEventType[];
  /** Shared secret for HMAC-SHA256 signature verification */
  secret: string;
}

/** Delivery lifecycle states. Terminal states: delivered, dead. */
export type DeliveryState = "pending" | "sending" | "delivered" | "failed" | "retrying" | "dead";

/** Webhook delivery record as returned by the API. */
export interface WebhookDelivery {
  id: number;
  subscriptionId: number;
  flagKey: FlagKey;
  eventType: WebhookEventType;
  state: DeliveryState;
  attempts: number;
  lastError: string | null;
  /** End-to-end trace ID from the originating API request */
  correlationId: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Audit log entry for a delivery state change. */
export interface DeliveryTransition {
  deliveryId: number;
  from: DeliveryState | null;
  to: DeliveryState;
  reason: string;
  timestamp: Timestamp;
}

/** Payload shape sent to consumer webhook URLs. */
export interface WebhookPayload {
  event: WebhookEventType;
  key: string;
  enabled: boolean;
  timestamp: string;
  deliveryId: number;
}
