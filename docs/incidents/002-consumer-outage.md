# Incident 002: Webhook Consumer Outage

## Summary

All registered webhook consumers became unreachable (ECONNREFUSED). Over 20 deliveries accumulated in the queue, the
circuit breaker opened after 5 consecutive failures, and all deliveries eventually exhausted retries and entered the
`dead` state. No webhooks were delivered for approximately 3 minutes until the consumer was restored and dead deliveries
were manually replayed.

**Severity:** SEV3 — minor degradation (API unaffected, only webhooks impacted)
**Duration:** ~3 minutes of complete webhook delivery failure
**Impact:** 20 deliveries entered dead-letter state, 0 webhooks received by consumer

## Timeline

| Time   | Event                                                           |
| ------ | --------------------------------------------------------------- |
| T+0:00 | Consumer goes offline (port 19899 unreachable)                  |
| T+0:05 | 20 flag toggles fired, generating 20 pending deliveries         |
| T+0:10 | Worker picks up first batch — all fail with ECONNREFUSED        |
| T+0:15 | Circuit breaker transitions to OPEN for localhost:19899         |
| T+0:20 | Retrying deliveries deferred by circuit breaker (not attempted) |
| T+0:45 | Circuit breaker transitions to HALF-OPEN, probe delivery fails  |
| T+0:46 | Circuit breaker re-opens                                        |
| T+1:15 | Second half-open probe fails — breaker re-opens again           |
| T+1:30 | First deliveries exhaust 5 retries → state transitions to dead  |
| T+2:30 | All 20 deliveries reach dead state                              |
| T+2:45 | Operator starts mock consumer on port 19899                     |
| T+3:00 | Operator replays dead deliveries via admin API                  |
| T+3:15 | All replayed deliveries succeed, circuit breaker closes         |

## Root Cause

The webhook consumer at `localhost:19899` became unreachable. Every delivery attempt received `ECONNREFUSED` at the TCP
level (no process listening on the port).

The circuit breaker correctly opened after 5 failures, preventing further hammering of the dead consumer. However, this
also meant that deliveries in `retrying` state were deferred without decrementing their retry counter, extending the
total incident duration.

When the circuit breaker periodically probed (half-open state), the consumer was still down, so the breaker re-opened.
Once all deliveries had exhausted their 5 retry attempts, they transitioned through `failed` → `dead`.

## Detection

**How it was detected:** `pnpm cli metrics` showed:

- `webhook_queue_depth` spiking from 0 to 20
- `circuit_breaker_state{domain="localhost:19899"}` changing to 2 (open)
- `webhook_deliveries_total{state="dead"}` incrementing

**What should have caught it:**

- QueueBacklog alert (>100 for 5min) — would NOT fire (only 20 deliveries, threshold is 100)
- DeadLetterGrowing alert (rate > 0 for 15min) — would fire at T+15:00 (too slow!)
- **Missing:** No alert for circuit breaker state changes
- **Missing:** No alert for delivery failure rate (e.g., >50% of attempts failing)

## Mitigation

1. Started a mock consumer: `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end()}).listen(19899)"`
2. Verified consumer reachable: `curl http://localhost:19899`
3. Replayed dead deliveries via admin API
4. Confirmed circuit breaker closed and queue drained

## Resolution

Consumer was restored (simulated). In production this could be:

- Consumer service crashed and auto-restart kicked in
- Consumer deployed with wrong port/URL
- Network partition between services
- Consumer's load balancer draining connections

## Impact

- API performance: unaffected (webhooks are async)
- Webhook deliveries lost: 20 deliveries entered dead state
- Consumer received: 0 webhooks during outage, all 20 after replay
- Duration: ~3 minutes
- Data loss: none (dead deliveries preserved for replay)

## Lessons

### What went well

- Circuit breaker worked as designed — prevented hammering the dead consumer
- Dead-letter state preserved all failed deliveries for later replay
- Admin replay API allowed recovery without data loss
- API remained fully functional (webhooks are async, no user-facing impact)

### What went poorly

- DeadLetterGrowing alert has 15-minute threshold — too slow for a 3-minute incident
- QueueBacklog threshold (100) is too high for this workload (20 deliveries is significant)
- No way to see circuit breaker state from Grafana dashboard
- No automatic replay when circuit breaker closes (manual intervention required)
- Worker logs showed ECONNREFUSED but no structured "consumer unreachable" summary

## Action Items

| Action                                                       | Priority | Status |
| ------------------------------------------------------------ | -------- | ------ |
| Add circuit breaker state change metric to Grafana dashboard | High     | TODO   |
| Lower QueueBacklog alert threshold from 100 to 20            | High     | DONE   |
| Add delivery failure rate alert (>50% in 5min)               | High     | DONE   |
| Reduce DeadLetterGrowing alert threshold from 15min to 5min  | Medium   | DONE   |
| Add structured log for circuit breaker state transitions     | Medium   | TODO   |
| Document consumer outage recovery in runbook                 | Medium   | DONE   |
| Evaluate automatic dead-letter replay on circuit close       | Low      | TODO   |
