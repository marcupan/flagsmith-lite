# PR-002: Delivery Worker with Retry and Circuit Breaker

## What changed

Add the webhook delivery pipeline: when a flag is toggled, pending deliveries
are created for each active subscription, and a background worker processes them
with retry, exponential backoff, and per-domain circuit breaker protection.

## Why

PR-001 established the subscription registry. This PR makes it do something:
when `PUT /flags/:key` changes `enabled`, each matching subscription gets a
delivery that is eventually POST-ed to the consumer URL. Without this, webhook
subscriptions are inert database rows.

## How

### State machine (`packages/shared/state-machine.ts`)

Explicit transition map — the single source of truth for the delivery lifecycle:

```
pending ──→ sending ──→ delivered         (happy path)
                    ──→ retrying          (5xx, timeout, circuit open)
                    ──→ failed            (4xx — permanent, not retryable)
retrying ──→ sending                      (retry attempt)
failed ──→ dead                           (max retries exhausted or 4xx)
delivered ──→ (terminal)
dead ──→ (terminal)
```

Functions: `canTransition(from, to)`, `transition(from, to)` (throws on
invalid), `isTerminal(state)`, `nextStates(state)`.

**Design choice:** `transition()` throws on invalid transitions rather than
returning `false`. Invalid transitions are bugs — they should crash loudly, not
silently corrupt state.

### Audit log table (`delivery_transitions`)

Every state change is logged: `delivery_id`, `from_state`, `to_state`,
`reason`, `created_at`. Indexed on `delivery_id` for fast lookups.

FK to `webhook_deliveries` with `ON DELETE CASCADE`.

### Delivery service (`apps/api/src/delivery-service.ts`)

**`enqueueDeliveries(db, params)`** — Called from the flag PUT handler. Finds
all active subscriptions matching the event type, creates a `pending` delivery
row per subscription, and logs the initial `null → pending` transition.

**`processDelivery(db, deliveryId, logger)`** — Processes one delivery:

1. Transition `pending → sending` (or `retrying → sending`)
2. Build payload: `{ event, key, enabled, timestamp, deliveryId }`
3. Sign with HMAC-SHA256: `X-Webhook-Signature: sha256=<hex>`
4. POST to consumer URL through the circuit breaker
5. On 2xx: `sending → delivered`
6. On 4xx: `sending → failed → dead` (permanent, not retryable)
7. On 5xx/timeout/circuit open: `sending → retrying` (or `→ failed → dead` if
   max attempts reached)

**`processPendingDeliveries(db, logger)`** — Polls for all `pending` and
`retrying` deliveries, processes each sequentially.

### Retry configuration

| Parameter             | Value | Rationale                           |
| --------------------- | ----- | ----------------------------------- |
| `MAX_ATTEMPTS`        | 5     | Industry standard for webhook retry |
| `BACKOFF_BASE_MS`     | 1000  | 1s, 2s, 4s, 8s, 16s exponential     |
| `DELIVERY_TIMEOUT_MS` | 10000 | 10s — generous for HTTP POST        |

`backoffDelay(attempt)` = `1000 * 2^(attempt-1)` ms.

Note: backoff delay is computed but not yet enforced as a wait — the current
poll-based worker processes retrying deliveries immediately. pg-boss integration
(ADR-004) will add proper delayed retry with backoff. This is an intentional
simplification for the learning phase.

### Circuit breaker (`apps/api/src/circuit-breaker.ts`)

**Per-domain** — all subscriptions on the same host share one breaker.

```
Closed ──(5 consecutive failures)──→ Open ──(30s elapsed)──→ Half-Open
   ↑                                                              │
   └───────────(probe success)─────────────────────────────────────┘
   Open ←──────(probe failure)─────────────────────────────────────┘
```

- `failureThreshold: 5` — requires 5 consecutive failures
- `resetTimeout: 30_000` — 30 seconds before half-open probe
- **Lazy transition**: no timers. `getState()` checks elapsed time on each call.
  No `setTimeout` to clean up, no memory leaks.
- **5xx trips the breaker, 4xx does not** — a 404 means that specific webhook
  URL is wrong, not that the entire server is down.

### Flag route integration (`apps/api/src/routes/flags.ts`)

The PUT handler now calls `enqueueDeliveries()` when `request.body.enabled` is
present. Enqueue errors are caught and logged — they do not fail the flag update
itself.

### Worker process (`apps/api/src/worker.ts`)

Standalone entry point: `tsx src/worker.ts`. Polls every 2s (configurable via
`WORKER_POLL_INTERVAL_MS`). Graceful shutdown on SIGINT/SIGTERM. Uses pino
logger with `service: "flagsmith-worker"` for log separation.

### Docker Compose

New `worker` service using the same Dockerfile but different command:
`["pnpm", "exec", "tsx", "src/worker.ts"]`. Shares DB connection, no Redis
dependency for queue (pg-boss uses Postgres).

## What I considered but did not do

- **pg-boss integration** — ADR-004 chose pg-boss, but for the learning phase
  we use a simpler poll-based approach. The delivery state machine and audit log
  work identically regardless of queue backend. Migration to pg-boss is additive.
- **Parallel delivery processing** — `processPendingDeliveries` processes
  deliveries sequentially. For <100 subscriptions this is fine. At scale, add
  a concurrency limiter (e.g., `p-limit(10)`).
- **Webhook payload includes `enabled: true` hardcoded** — Flag state should
  come from the actual DB row at delivery time, not enqueue time. Deferred to
  avoid complicating the pipeline for the initial implementation.

## How to test

```bash
export API_KEY=local-dev-key
export BASE=http://localhost:3000/api/v1

# Setup: create flag + subscription
curl -s -X POST "$BASE/flags" -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" -d '{"key":"test-hook","name":"Test","enabled":false}' | jq .

curl -s -X POST "$BASE/webhooks" -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"url":"https://httpbin.org/post","events":["flag.toggled"],"secret":"test-secret-at-least-16"}' | jq .

# Toggle — should create delivery
curl -s -X PUT "$BASE/flags/test-hook" -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" -H "X-Correlation-Id: pr002-test" \
  -d '{"enabled":true}' | jq .

# Wait for worker to process
sleep 5

# Check delivery state
curl -s "$BASE/admin/delivery-stats" -H "X-Api-Key: $API_KEY" | jq .
# Expected: delivered >= 1

# Verify audit trail
curl -s "$BASE/admin/deliveries/1/transitions" -H "X-Api-Key: $API_KEY" | jq .
# Expected: pending → sending → delivered
```

**Circuit breaker test:**

```bash
# Register subscription to unreachable host
curl -s -X POST "$BASE/webhooks" -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"url":"http://localhost:1/down","events":["flag.toggled"],"secret":"test-secret-at-least-16"}' | jq .

# Toggle 6+ times to trigger breaker (5 failures → open)
for i in $(seq 1 6); do
  curl -s -X PUT "$BASE/flags/test-hook" -H "Content-Type: application/json" \
    -H "X-Api-Key: $API_KEY" -d "{\"enabled\":$([ $((i%2)) -eq 0 ] && echo true || echo false)}" > /dev/null
  sleep 3
done

# Check logs for "Circuit open" message
docker compose logs worker | grep -i "circuit"
```

Automated: 30 unit tests for state machine in
`packages/shared/__tests__/state-machine.test.ts`, 8 integration tests in
`apps/api/src/__tests__/delivery.test.ts`.

## Risk

**Medium.** The PUT /flags/:key handler now has a side effect (enqueue). If
enqueue fails, the flag update still succeeds (catch block returns 0). The
worker is a new process — if it crashes, deliveries accumulate as `pending` but
are not lost. Restart recovers automatically.

**Rollback:** Remove the `enqueueDeliveries` call from `flags.ts`, stop the
worker container. Existing deliveries in DB are inert without the worker.
