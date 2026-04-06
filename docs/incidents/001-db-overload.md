# Incident 001: Database Connection Pool Exhaustion

## Summary

Rapid flag toggles (100 requests in <3s) combined with a long-running exclusive table lock on `webhook_deliveries`
caused API response times to spike from ~5ms to >10s. Webhook deliveries stalled completely for ~30 seconds, and
approximately 15% of flag toggle requests received 5xx errors during the incident window.

**Severity:** SEV2 — significant degradation
**Duration:** ~2 minutes (from first spike to full recovery)
**Impact:** 100% of webhook deliveries blocked, ~15% of API requests failed

## Timeline

| Time   | Event                                                            |
| ------ | ---------------------------------------------------------------- |
| T+0:00 | Simulation starts: 100 rapid flag toggles fired concurrently     |
| T+0:02 | All toggles land — DB connection pool saturated                  |
| T+0:03 | Exclusive lock acquired on `webhook_deliveries` table            |
| T+0:05 | Grafana shows p95 latency spike from 5ms to 2000ms+              |
| T+0:10 | Error rate rises above 5% — HighErrorRate alert would fire       |
| T+0:15 | Worker unable to process deliveries — queue depth climbing       |
| T+0:20 | `pnpm cli health` shows API responding but slow (800ms+ latency) |
| T+0:30 | Operator identifies lock via `pg_stat_activity`                  |
| T+0:35 | Operator kills lock with `pg_terminate_backend()`                |
| T+0:40 | Latency drops back to normal, queue begins draining              |
| T+1:30 | All queued deliveries processed, queue depth returns to 0        |
| T+2:00 | Full recovery confirmed                                          |

## Root Cause

Two compounding factors:

1. **Connection pool saturation:** 100 concurrent flag toggle requests each opened a DB connection. The default
   `postgres.js` pool size (10 connections) was overwhelmed. Requests queued at the connection level, causing cascading
   latency as each connection held a transaction for the flag update + delivery enqueue.

2. **Exclusive table lock:** A simulated slow migration held `ACCESS EXCLUSIVE` lock on `webhook_deliveries` for 30
   seconds. This blocked ALL reads and writes to the deliveries table, including the worker's poll query and the
   enqueue `INSERT` statements. The lock caused connection-holding requests to wait indefinitely, further exhausting the
   pool.

Neither factor alone would have caused a SEV2. The combination — pool saturation + table lock — created a deadlock-like
situation where no connections could complete their transactions.

## Detection

**How it was detected:** Grafana p95 latency panel showed immediate spike. Error rate panel crossed 5% threshold.

**What should have caught it:**

- HighErrorRate alert (fires at >5% for 2min) — would have fired at T+2:00
- HighLatency alert (fires at p95 >100ms for 5min) — would have fired at T+5:00
- **Missing:** No alert for DB connection pool utilization
- **Missing:** No alert for long-running queries or table locks

## Mitigation

Steps taken to stop the immediate impact:

1. Identified the lock: `SELECT pid, query, state FROM pg_stat_activity WHERE state != 'idle'`
2. Killed the locking process: `SELECT pg_terminate_backend(<pid>)`
3. Verified recovery: `pnpm cli health` showed latency back to normal
4. Confirmed queue draining: `pnpm cli metrics` showed `webhook_queue_depth` decreasing

## Resolution

The lock was a simulated scenario. In production, this could be:

- A migration that locks tables without `CONCURRENTLY`
- A manual admin query that forgot `LIMIT` or ran against a large table
- A monitoring query that acquired locks unintentionally

Long-term fixes are captured in action items below.

## Impact

- API requests affected: ~15 out of 100 returned 5xx
- Webhook deliveries delayed: all 100+ deliveries stalled for ~30s
- Duration: ~2 minutes total
- Data loss: none (deliveries recovered after lock release)

## Lessons

### What went well

- Circuit breaker was NOT a factor (deliveries stalled at DB level, not at consumer level)
- Queue depth metric correctly showed the backlog building
- Recovery was automatic once the lock was removed — no manual delivery replay needed
- Grafana dashboard showed the spike immediately

### What went poorly

- No DB-level metrics: connection pool utilization is invisible
- No alert for long-running queries (>5s)
- The 100-request burst had no rate limiting at the API level (rate limiter may exist but wasn't tested)
- Worker processes deliveries sequentially — a smarter approach would skip locked rows

## Action Items

| Action                                                   | Priority | Status |
| -------------------------------------------------------- | -------- | ------ |
| Add Prometheus metric for DB connection pool utilization | High     | DONE   |
| Add query timeout (connect_timeout + idle_timeout) to DB | High     | DONE   |
| Add alert for connection pool saturation (>80%)          | High     | TODO   |
| Add alert for long-running queries (>10s)                | Medium   | TODO   |
| Document DB troubleshooting steps in runbook             | Medium   | DONE   |
| Evaluate `FOR UPDATE SKIP LOCKED` for worker poll        | Low      | TODO   |
