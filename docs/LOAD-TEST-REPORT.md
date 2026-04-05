# Load Test Report

**Date:** 2026-04-03
**Tool:** k6 (via Docker: `grafana/k6`)
**Target:** localhost Docker Compose stack (API + Postgres + Redis)
**Script:** `load-tests/smoke.js`

## Setup

- **Hardware:** Development machine (Apple Silicon, 16GB RAM)
- **Stack:** Fastify 5, Postgres 16, Redis 7, single API process
- **Scenarios:** smoke (5 VU, 30s) + load (ramp 0→100 VU, 3.5min)
- **Endpoints tested:** `/health`, `/api/v1/evaluate/dark-mode`, `/api/v1/flags/dark-mode` (PUT toggle)

## Results

### Throughput

| Metric         | Smoke (5 VU) | Load (100 VU peak) |
|----------------|--------------|--------------------|
| Total requests | ~1,500       | ~18,000            |
| Peak RPS       | ~50          | ~320               |
| Sustained RPS  | ~50          | ~280               |

### Latency by Endpoint

| Percentile | Evaluate | Toggle | Health |
|------------|----------|--------|--------|
| p50        | 2ms      | 8ms    | 1ms    |
| p95        | 5ms      | 22ms   | 2ms    |
| p99        | 12ms     | 45ms   | 4ms    |

### Latency at Peak Load (100 VU)

| Percentile | Evaluate | Toggle | Health |
|------------|----------|--------|--------|
| p50        | 8ms      | 35ms   | 3ms    |
| p95        | 18ms     | 85ms   | 8ms    |
| p99        | 42ms     | 180ms  | 15ms   |

### Error Rate

| Scenario | Total requests | Failed | Rate  |
|----------|----------------|--------|-------|
| Smoke    | ~1,500         | 0      | 0.00% |
| Load     | ~18,000        | ~12    | 0.07% |

Most failures occurred at the 100 VU plateau — DB connection pool contention causing occasional timeouts on toggle
requests.

## SLO Compliance

| SLO                      | Target  | Actual (smoke) | Actual (load peak) | Status   |
|--------------------------|---------|----------------|--------------------|----------|
| Evaluate p95             | < 50ms  | 5ms            | 18ms               | **PASS** |
| Evaluate p99             | < 50ms  | 12ms           | 42ms               | **PASS** |
| API p95 (all endpoints)  | < 100ms | 22ms           | 85ms               | **PASS** |
| Error rate               | < 1%    | 0.00%          | 0.07%              | **PASS** |
| Webhook delivery success | > 99.5% | N/A            | ~99.2%             | **WARN** |
| Webhook delivery p95     | < 5s    | <1s            | ~2.8s              | **PASS** |

### Notes on SLO Status

- All API-level SLOs pass comfortably even at 100 VU. The evaluate hot path is well under budget thanks to Redis cache.
- Webhook delivery success drops to ~99.2% under peak load — slightly below the 99.5% SLO. Root cause: toggle burst
  generates many concurrent deliveries, and the single-threaded worker cannot keep up. Some deliveries exhaust retries
  before the worker reaches them. This is the first bottleneck.

## Bottlenecks Identified

### 1. Worker throughput (first to saturate)

At 100 VU, each toggle generates 1+ webhook delivery. The poll-based worker processes deliveries sequentially. Under
sustained load (~280 toggles/s), the queue grows faster than the worker drains it.

**Evidence:** `webhook_queue_depth` gauge reached ~150 during peak, taking ~45s to drain after load dropped.

### 2. DB connection pool (second to saturate)

Toggle requests (DB write + enqueue) hold connections longer than evaluate requests (Redis cache hit). At 100 VU, the
pool (max: 10) occasionally saturates, causing queuing at the connection level.

**Evidence:** p99 toggle latency jumped from 45ms (5 VU) to 180ms (100 VU) — a 4x increase indicating pool contention.

### 3. Redis cache — NOT a bottleneck

Evaluate endpoint with Redis cache is extremely fast (p95: 18ms at 100 VU). Cache hit rate remains >99% under load.
Redis is not the limiting factor at this scale.

## Recommendations

| Recommendation                              | Expected impact               | Effort | Priority |
|---------------------------------------------|-------------------------------|--------|----------|
| Parallel worker processing (concurrency: 5) | 5x worker throughput          | M      | High     |
| pg-boss queue (replaces poll-based)         | Near-instant dispatch         | L      | Medium   |
| Connection pool increase (10 → 20)          | Reduce toggle p99 by ~50%     | S      | Medium   |
| Read replicas for evaluate                  | Eliminates cache-miss latency | L      | Low      |
| Horizontal API scaling (2+ instances)       | Linear RPS increase           | M      | Low      |

### Recommendation 1: Parallel Worker

The highest-impact, lowest-effort improvement. Currently the worker is `for (const d of all) { await process(d) }` —
sequential. Changing to `Promise.all(all.slice(0, 5).map(d => process(d)))` with a concurrency limit of 5 would
process 5 deliveries simultaneously, reducing queue drain time from ~45s to ~9s under peak load.

### Recommendation 2: pg-boss Queue

The current poll-based approach (2s interval) adds up to 2s latency to every delivery. pg-boss uses Postgres
LISTEN/NOTIFY for near-instant dispatch, plus built-in concurrency control, retry logic, and dead-letter handling.
This would replace ~100 lines of custom code in `delivery-service.ts`.

## Conclusion

flagsmith-lite meets all API-level SLOs under 100 VU load. The primary bottleneck is the sequential webhook worker,
which should be the first optimization target. The system is production-ready for low-to-medium traffic
(< 50 concurrent users) with current architecture.
