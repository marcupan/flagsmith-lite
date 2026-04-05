/**
 * k6 load test for flagsmith-lite API.
 *
 * Run:
 *   docker run --rm -i --network=host grafana/k6 run - <load-tests/smoke.js
 *
 * Or with k6 installed locally:
 *   k6 run load-tests/smoke.js
 *
 * Prerequisites:
 *   - API running on localhost:3000
 *   - At least one flag "dark-mode" created
 *   - API_KEY set (default: change-me-in-production)
 *
 * Scenarios:
 *   smoke — 5 virtual users for 30s (baseline, should never fail)
 *   load  — ramp from 0→20→50→100 VU over 3.5min (find bottlenecks)
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend } from "k6/metrics";

// ── Custom metrics ──────────────────────────────────────────────────────

const evaluateLatency = new Trend("evaluate_latency", true);
const toggleLatency = new Trend("toggle_latency", true);
const healthLatency = new Trend("health_latency", true);
const errorRate = new Rate("error_rate");

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
      vus: 5,
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
    // SLO: API p95 < 100ms, Evaluate p99 < 50ms, Error rate < 1%
    http_req_duration: ["p(95)<100", "p(99)<250"],
    http_req_failed: ["rate<0.01"],
    evaluate_latency: ["p(95)<50", "p(99)<100"],
    error_rate: ["rate<0.01"],
  },
};

// ── Test function ───────────────────────────────────────────────────────

export default function () {
  // 1. Health check (unprotected, lightweight)
  group("health", () => {
    const res = http.get(`${BASE}/health`);
    check(res, { "health 200": (r) => r.status === 200 });
    healthLatency.add(res.timings.duration);
    errorRate.add(res.status >= 500);
  });

  // 2. Evaluate flag (hot path — the most latency-critical endpoint)
  group("evaluate", () => {
    const res = http.get(`${BASE}/api/v1/evaluate/dark-mode`);
    check(res, {
      "evaluate 2xx": (r) => r.status >= 200 && r.status < 300,
    });
    evaluateLatency.add(res.timings.duration);
    errorRate.add(res.status >= 500);
  });

  // 3. Toggle flag (triggers webhook delivery, DB write)
  group("toggle", () => {
    const enabled = __ITER % 2 === 0;
    const res = http.put(`${BASE}/api/v1/flags/dark-mode`, JSON.stringify({ enabled }), {
      headers: HEADERS,
    });
    check(res, {
      "toggle 2xx": (r) => r.status >= 200 && r.status < 300,
    });
    toggleLatency.add(res.timings.duration);
    errorRate.add(res.status >= 500);
  });

  // Small pause between iterations to avoid pure CPU-bound spin
  sleep(0.1);
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
