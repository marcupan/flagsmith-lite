/**
 * Branded (opaque) types — compile-time enforcement of domain semantics.
 *
 * A branded type is a primitive (string, number) intersected with a phantom
 * field that only exists at the type level. At runtime the value is unchanged;
 * the brand prevents accidental mixing of values that share the same base type
 * but carry different domain meaning (e.g., a user-id string vs. a flag-key string).
 */

declare const __brand: unique symbol;

/**
 * Generic brand helper. `Brand<string, "FlagKey">` produces a type that is
 * assignable TO string but NOT FROM string — callers must go through a
 * validating constructor.
 */
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** A validated flag key: lowercase alphanumeric + hyphens/underscores, 1-128 chars. */
export type FlagKey = Brand<string, "FlagKey">;

/** An ISO 8601 timestamp string. */
export type Timestamp = Brand<string, "ISO8601">;

/**
 * Regex mirrors Fastify JSON Schema pattern in `apps/api/src/routes/flags.ts`
 * line 39: `^[a-z0-9_-]+$`. Keep them in sync.
 */
const FLAG_KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Validate and brand a raw string as a FlagKey.
 * Throws if the key doesn't match the allowed pattern or length.
 */
export function FlagKey(raw: string): FlagKey {
  if (!FLAG_KEY_RE.test(raw) || raw.length < 1 || raw.length > 128) {
    throw new Error(`Invalid flag key: "${raw}"`);
  }

  return raw as FlagKey;
}

/**
 * Brand a Date (or current time) as an ISO 8601 Timestamp.
 */
export function Timestamp(date: Date = new Date()): Timestamp {
  return date.toISOString() as Timestamp;
}
