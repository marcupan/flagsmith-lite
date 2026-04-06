# PR-003: Structured Logging and Admin Endpoints

## What changed

Add end-to-end correlation ID tracing, structured JSON logging across API and
worker, and five admin endpoints for webhook delivery debugging and replay.

## Why

Without observability, debugging a failed delivery means reading raw Postgres
rows and guessing the timeline. With this PR, an on-call engineer can:

1. Take a correlation ID from an alert or user report
2. `grep` it across API + worker logs to see the full lifecycle
3. Use admin endpoints to inspect delivery state, audit trail, and stats
4. Replay dead deliveries after fixing the root cause

This is the difference between "something is broken" and "delivery #42 to
`api.acme.com` failed at 03:14 with HTTP 503 after 5 attempts, circuit breaker
opened, consumer recovered at 03:17".

## How

### Correlation ID flow (`apps/api/src/index.ts`)

Every request gets a `correlationId`:

```
Client ──X-Correlation-Id: abc──→ API (uses abc)
  or
Client ──(no header)──→ API (generates UUID)
```

The ID is:

- Stored on `request.correlationId`
- Injected into `request.log` as a pino child logger field
- Returned in `X-Correlation-Id` response header
- Passed to `enqueueDeliveries()` → stored in `webhook_deliveries.correlation_id`
- Worker's child logger inherits it per delivery

**Input validation**: IDs must match `^[\w-]{1,64}$` — prevents log injection
via ANSI codes or newlines in the correlation header.

### Structured logging

Every log line is JSON with consistent fields:

```json
{
  "level": 30,
  "time": 1711234567890,
  "service": "flagsmith-api",
  "correlationId": "abc-123",
  "reqId": "...",
  "msg": "Webhook deliveries enqueued",
  "flagKey": "dark-mode",
  "enqueued": 3
}
```

Worker uses the same pino format with `service: "flagsmith-worker"`.
Filtering is trivial: `jq 'select(.service == "flagsmith-worker")'`.

**Zero `console.log`** in the codebase — all output is structured pino.

### Admin routes (`apps/api/src/routes/admin.ts`)

All admin routes are under `/api/v1/admin/` and require API key auth.

| Endpoint                            | Method | Purpose                         |
| ----------------------------------- | ------ | ------------------------------- |
| `/admin/delivery-stats`             | GET    | Aggregate counts by state       |
| `/admin/deliveries/:id`             | GET    | Single delivery detail          |
| `/admin/deliveries/:id/transitions` | GET    | Full audit trail for a delivery |
| `/admin/deliveries/:id/replay`      | POST   | Re-enqueue dead/failed delivery |

Plus one on the webhooks router:

| Endpoint                                   | Method | Purpose                     |
| ------------------------------------------ | ------ | --------------------------- |
| `/webhooks/:id/deliveries?state=X&limit=N` | GET    | Deliveries per subscription |

### Replay mechanics

Replay is only allowed for `failed` and `dead` deliveries (guard in code).

On replay:

1. Reset `state → "pending"`, `attempts → 0`, `lastError → null`
2. Generate new `correlationId` (fresh trace for the retry flow)
3. Log transition: `dead → pending` with reason linking old correlation ID
4. Worker picks it up on next poll cycle

The old correlation ID is preserved in the transition `reason` field for
traceability: `"Manual replay (old correlationId: abc-123)"`.

### Delivery stats query

Uses `count(*)::int` grouped by state. Returns a complete object with all six
states, defaulting missing states to 0:

```json
{ "pending": 0, "sending": 0, "delivered": 89, "failed": 2, "retrying": 1, "dead": 3 }
```

### Helper extraction (code quality)

Admin routes extract `parseId()`, `notFound()`, and `findDelivery()` to
eliminate duplicated validation code across the three `:id` endpoints.

## What I considered but did not do

- **Separate admin auth** — Admin endpoints use the same API key as regular
  routes. In production, these should have a separate admin token or RBAC.
  Acceptable for a single-engineer project.
- **Pagination on delivery-stats** — Stats is an aggregate, not paginated. If
  the query becomes slow (millions of rows), add a materialized view.
- **Rate limiting on replay** — No special rate limit. An operator replaying
  1000 deliveries could overwhelm the worker. Acceptable risk given manual
  invocation.

## How to test

```bash
export API_KEY=local-dev-key
export BASE=http://localhost:3000/api/v1

# Prerequisites: flag + subscription + toggle (see PR-001, PR-002 test sections)

# Trace correlation across services
curl -s -X PUT "$BASE/flags/dark-mode" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -H "X-Correlation-Id: trace-test-001" \
  -d '{"enabled":true}' | jq .

sleep 5

# Find all logs for this correlation
docker compose logs --no-log-prefix api worker | grep "trace-test-001"
# Expected: multiple JSON lines with same correlationId from both services

# Admin endpoints
curl -s "$BASE/admin/delivery-stats" -H "X-Api-Key: $API_KEY" | jq .
curl -s "$BASE/admin/deliveries/1" -H "X-Api-Key: $API_KEY" | jq .
curl -s "$BASE/admin/deliveries/1/transitions" -H "X-Api-Key: $API_KEY" | jq .

# Replay (find a dead delivery first)
curl -s "$BASE/admin/delivery-stats" -H "X-Api-Key: $API_KEY" | jq '.dead'
# If dead > 0:
curl -s -X POST "$BASE/admin/deliveries/N/replay" -H "X-Api-Key: $API_KEY" | jq .
# Expected: 200, state: "pending", attempts: 0
```

Automated: 8 tests in `apps/api/src/__tests__/admin.test.ts` covering stats,
delivery detail, transitions, replay (happy + guard cases), auth.

## Risk

**Low.** Admin routes are read-only except replay. Replay resets state to
`pending` — worst case is redelivery (consumers should be idempotent per
ADR-005). Correlation ID header is validated against injection. No existing
endpoints are modified.

**Rollback:** Remove admin route registration from `index.ts`. Correlation ID
hooks are additive and harmless if admin routes are removed.
