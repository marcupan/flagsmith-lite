# SLI / SLO Definitions

Service Level Indicators (SLI) are measured metrics. Service Level Objectives (SLO) are targets
for those metrics. When an SLO is breached, it triggers an alert — not necessarily a page, but
a signal that something needs investigation.

## API Latency

- **SLI:** p95 response time across all API endpoints
- **SLO:** < 100ms
- **Metric:** `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))`
- **Window:** 7-day rolling
- **Alert:** `HighLatency` fires after 5 minutes above threshold

## Evaluate Endpoint Latency

- **SLI:** p99 response time for `GET /api/v1/evaluate/:key`
- **SLO:** < 50ms
- **Metric:** `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{route="/api/v1/evaluate/:key"}[5m]))`
- **Window:** 7-day rolling
- **Rationale:** This is the hot path — SDK clients call it on every feature check.
  50ms at p99 means even the slowest 1% of evaluations are fast. Cache hits should
  be <5ms; 50ms budget allows for cache misses that hit Postgres.

## Error Rate

- **SLI:** Percentage of HTTP 5xx responses
- **SLO:** < 1%
- **Metric:** `rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m])`
- **Window:** 5-minute rolling
- **Alert:** `HighErrorRate` fires at > 5% for 2 minutes (critical severity)

## Webhook Delivery Success Rate

- **SLI:** Percentage of deliveries reaching `delivered` state
- **SLO:** > 99.5%
- **Metric:**
  `webhook_deliveries_total{state="delivered"} / (webhook_deliveries_total{state="delivered"} + webhook_deliveries_total{state="dead"})`
- **Window:** 24-hour rolling
- **Rationale:** 99.5% allows for ~5 dead deliveries per 1000 — enough margin for
  permanently broken consumer URLs or DNS failures, but catches systematic issues
  (broken consumer, misconfigured webhook).

## Webhook Delivery Latency

- **SLI:** p95 time from enqueue (pending) to terminal state (delivered)
- **SLO:** < 5 seconds
- **Metric:** `histogram_quantile(0.95, rate(webhook_delivery_duration_seconds_bucket{result="success"}[5m]))`
- **Window:** 7-day rolling
- **Rationale:** 5 seconds includes worker poll interval (2s) + HTTP POST + consumer
  processing. Most deliveries complete in <1s. 5s budget allows for slow consumers
  without triggering false alerts.

## Queue Depth

- **SLI:** Number of pending + retrying deliveries
- **SLO:** < 100 sustained for > 5 minutes
- **Metric:** `webhook_queue_depth`
- **Alert:** `QueueBacklog` fires at > 100 for 5 minutes
- **Rationale:** Queue depth is a leading indicator. A growing queue means either the
  worker is slow, consumers are failing (circuit breakers open), or delivery volume
  exceeds processing capacity. 100 is ~50x normal — significant enough to investigate,
  not so low as to fire on normal burst traffic.
