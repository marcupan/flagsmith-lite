/**
 * Deterministic percentage targeting engine.
 *
 * Uses SHA-256 to hash (flagKey + userId) into a stable bucket [0-99].
 * The same userId always lands in the same bucket for a given flag,
 * ensuring consistent experience across requests.
 *
 * No external dependencies — uses Node.js built-in `node:crypto`.
 */
import { createHash } from "node:crypto";

/** Reason codes explaining why evaluate returned a given result. */
export type EvaluateReason =
  | "flag_disabled"
  | "rollout_match"
  | "rollout_miss"
  | "no_user_id"
  | "rollout_full";

export interface TargetingResult {
  enabled: boolean;
  reason: EvaluateReason;
}

/**
 * Compute a deterministic bucket [0-99] from flagKey + userId.
 *
 * Algorithm:
 *   1. hash = SHA-256(flagKey + ":" + userId)  → 64 hex chars
 *   2. Take first 8 hex chars → parse as unsigned 32-bit int
 *   3. bucket = int % 100
 *
 * Why SHA-256 over Murmur3:
 *   - Available in Node.js `crypto` — zero dependencies
 *   - Uniformly distributed (cryptographic hash)
 *   - Slightly slower than Murmur3, but evaluate is I/O-bound (DB/Redis), not CPU-bound
 */
export function computeBucket(flagKey: string, userId: string): number {
  const hash = createHash("sha256").update(`${flagKey}:${userId}`).digest("hex");
  return parseInt(hash.substring(0, 8), 16) % 100;
}

/**
 * Evaluate whether a user should see a feature flag.
 *
 * Decision matrix:
 *   - enabled=false                        → disabled (flag_disabled)
 *   - enabled=true, rollout=100            → enabled  (rollout_full)
 *   - enabled=true, rollout<100, no userId → enabled  (no_user_id) — fallback
 *   - enabled=true, rollout<100, userId    → hash-based targeting
 */
export function evaluateTargeting(opts: {
  flagEnabled: boolean;
  rolloutPercentage: number;
  flagKey: string;
  userId?: string;
}): TargetingResult {
  // Master switch takes priority
  if (!opts.flagEnabled) {
    return { enabled: false, reason: "flag_disabled" };
  }

  // Full rollout — skip hashing entirely
  if (opts.rolloutPercentage >= 100) {
    return { enabled: true, reason: "rollout_full" };
  }

  // Zero rollout — disabled for everyone
  if (opts.rolloutPercentage <= 0) {
    return { enabled: false, reason: "rollout_miss" };
  }

  // Partial rollout without userId — fallback to enabled (backward compat)
  if (!opts.userId) {
    return { enabled: true, reason: "no_user_id" };
  }

  // Deterministic hash-based targeting
  const bucket = computeBucket(opts.flagKey, opts.userId);
  const match = bucket < opts.rolloutPercentage;

  return {
    enabled: match,
    reason: match ? "rollout_match" : "rollout_miss",
  };
}
