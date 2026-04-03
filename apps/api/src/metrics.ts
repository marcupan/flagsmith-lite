/**
 * Prometheus metrics for flagsmith-lite.
 *
 * Follows the "4 golden signals" model:
 * - Latency:    httpRequestDuration (Histogram)
 * - Traffic:    httpRequestTotal (Counter)
 * - Errors:     httpRequestTotal with status label (Counter)
 * - Saturation: queueDepth (Gauge)
 *
 * Plus business-specific metrics for flag evaluation and webhook delivery.
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

export const registry = new Registry();

// Default Node.js metrics: event loop lag, heap size, GC pauses, etc.
collectDefaultMetrics({ register: registry });

// ── HTTP Request Metrics (Golden Signals: Latency + Traffic + Errors) ────

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const httpRequestTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

// ── Flag Evaluation Metrics ─────────────────────────────────────────────

export const flagEvaluations = new Counter({
  name: "flag_evaluations_total",
  help: "Total number of flag evaluations",
  labelNames: ["source"] as const, // "cache" | "database"
  registers: [registry],
});

// ── Webhook Delivery Metrics ────────────────────────────────────────────

export const deliveriesTotal = new Counter({
  name: "webhook_deliveries_total",
  help: "Total number of webhook deliveries by final state",
  labelNames: ["state"] as const, // "delivered" | "failed" | "dead"
  registers: [registry],
});

export const deliveryDuration = new Histogram({
  name: "webhook_delivery_duration_seconds",
  help: "Time to deliver a webhook (pending to final state)",
  labelNames: ["result"] as const, // "success" | "failure"
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30],
  registers: [registry],
});

// ── Queue Saturation (Golden Signal: Saturation) ────────────────────────

export const queueDepth = new Gauge({
  name: "webhook_queue_depth",
  help: "Current number of pending + retrying deliveries",
  registers: [registry],
});

// ── Circuit Breaker Metrics ─────────────────────────────────────────────

export const circuitBreakerState = new Gauge({
  name: "circuit_breaker_state",
  help: "Circuit breaker state per domain (0=closed, 1=half-open, 2=open)",
  labelNames: ["domain"] as const,
  registers: [registry],
});

// ── Database Pool Metrics (Action item from Incident 001) ──────────────

export const dbPoolMaxConnections = new Gauge({
  name: "db_pool_max_connections",
  help: "Maximum number of connections in the DB pool",
  registers: [registry],
});

// ── Delivery Failure Rate (Action item from Incident 002) ──────────────

export const deliveryAttempts = new Counter({
  name: "webhook_delivery_attempts_total",
  help: "Total webhook delivery attempts by result",
  labelNames: ["result"] as const, // "success" | "failure"
  registers: [registry],
});
