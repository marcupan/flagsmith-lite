/**
 * Lightweight analytics wrapper.
 *
 * PostHog is initialised in main.tsx; this module provides typed event
 * helpers so callers don't import posthog-js directly. When
 * VITE_POSTHOG_KEY is absent (local dev), every call is a silent no-op.
 */
import posthog from "posthog-js";

function capture(name: string, properties?: Record<string, unknown>): void {
  // posthog-js silently ignores capture() if not initialised — safe to call always
  posthog.capture(name, properties);
}

// ── Typed event helpers ─────────────────────────────────────────────────

export function trackPageViewed(path: string): void {
  capture("page_viewed", { path });
}

export function trackDashboardLoaded(flagCount: number): void {
  capture("dashboard_loaded", { flag_count: flagCount });
}

export function trackFlagCreated(key: string, name: string): void {
  capture("flag_created", { key, name });
}

export function trackFlagToggled(key: string, enabled: boolean, rolloutPercentage: number): void {
  capture("flag_toggled", { key, enabled, rollout_percentage: rolloutPercentage });
}

export function trackFlagDeleted(key: string): void {
  capture("flag_deleted", { key });
}
