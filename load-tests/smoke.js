/**
 * k6 load test for flagsmith-lite API.
 *
 * Run (macOS — Docker Desktop does not support --network=host):
 *   docker run --rm -i \
 *     -e BASE_URL=http://host.docker.internal:3000 \
 *     -e API_KEY=change-me-in-production \
 *     grafana/k6 run - <load-tests/smoke.js
 *
 * Or with k6 installed locally:
 *   k6 run load-tests/smoke.js
 *
 * Prerequisites:
 *   - API running on localhost:3000
 *   - API_KEY set (default: change-me-in-production)
 *   - setup() auto-creates "dark-mode" flag if missing
 *
 * Scenarios:
 *   smoke — 1 VU for 30s (stays within rate limits, validates correctness)
 *   load  — ramp from 0→20→50→100 VU over 3.5min (tests rate limiter behavior)
 *
 * Rate Limiting:
 *   The API enforces 100 req/min global + 60 req/min on /evaluate.
 *   At >2 VU, most requests will receive 429 Too Many Requests.
 *   The checks treat 429 as "rate_limited" (expected), not as errors.
 *   Only 5xx responses count as real errors.
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend, Counter } from "k6/metrics";

// ── Custom metrics ──────────────────────────────────────────────────────

const evaluateLatency = new Trend("evaluate_latency", true);
const toggleLatency = new Trend("toggle_latency", true);
const healthLatency = new Trend("health_latency", true);
const errorRate = new Rate("error_rate");
const rateLimitedCount = new Counter("rate_limited_total");

// ── Configuration ───────────────────────────────────────────────────────

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const API_KEY = __ENV.API_KEY || "change-me-in-production";

const HEADERS = {
  "Content-Type": "application/json",
  "X-Api-Key": API_KEY,
};

export const options = {
  scenarios: {
    smoke: {
      executor: "constant-vus",
      vus: 1,
      duration: "30s",
    },
    load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 20 },
        { duration: "1m", target: 50 },
        { duration: "30s", target: 100 },
        { duration: "1m", target: 100 },
        { duration: "30s", target: 0 },
      ],
      startTime: "30s",
    },
  },
  thresholds: {
    // SLO-aligned thresholds (applied to successful requests only)
    http_req_duration: ["p(95)<100", "p(99)<250"],
    evaluate_latency: ["p(95)<50", "p(99)<100"],
    // Real errors: only 5xx count, not 429 rate limits
    error_rate: ["rate<0.01"],
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Check if response is successful OR rate-limited (both are acceptable).
 * Only 5xx is a real error.
 */
function isOkOrRateLimited(res) {
  if (res.status === 429) {
    rateLimitedCount.add(1);
    return true;
  }
  return res.status >= 200 && res.status < 400;
}

// ── Test function ───────────────────────────────────────────────────────

export default function () {
  // 1. Health check (unprotected, lightweight)
  group("health", () => {
    const res = http.get(`${BASE}/health`);
    check(res, {
      "health ok": (r) => isOkOrRateLimited(r),
    });
    healthLatency.add(res.timings.duration);
    errorRate.add(res.status >= 500);
  });

  // 2. Evaluate flag (hot path — the most latency-critical endpoint)
  group("evaluate", () => {
    const res = http.get(`${BASE}/api/v1/evaluate/dark-mode`);
    check(res, {
      "evaluate ok": (r) => isOkOrRateLimited(r),
    });
    // Only track latency for non-429 responses (429 is instant, skews metrics)
    if (res.status !== 429) {
      evaluateLatency.add(res.timings.duration);
    }
    errorRate.add(res.status >= 500);
  });

  // 3. Toggle flag (triggers webhook delivery, DB write)
  group("toggle", () => {
    const enabled = __ITER % 2 === 0;
    const res = http.put(`${BASE}/api/v1/flags/dark-mode`, JSON.stringify({ enabled }), {
      headers: HEADERS,
    });
    check(res, {
      "toggle ok": (r) => isOkOrRateLimited(r),
    });
    if (res.status !== 429) {
      toggleLatency.add(res.timings.duration);
    }
    errorRate.add(res.status >= 500);
  });

  // Small pause between iterations to avoid pure CPU-bound spin
  sleep(0.3);
}

// ── Setup: ensure test flag exists ──────────────────────────────────────

export function setup() {
  const createRes = http.post(
    `${BASE}/api/v1/flags`,
    JSON.stringify({ key: "dark-mode", name: "Dark Mode" }),
    { headers: HEADERS },
  );

  // 201 = created, 409 = already exists — both are fine
  if (createRes.status !== 201 && createRes.status !== 409) {
    console.warn(`Setup: unexpected status ${createRes.status} creating flag`);
  }

  return { flagKey: "dark-mode" };
}
