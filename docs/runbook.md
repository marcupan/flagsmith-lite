# flagsmith-lite Webhook Delivery Runbook

Operational procedures for diagnosing and resolving webhook delivery issues.

## Prerequisites

All commands assume:

- Postgres is accessible via `psql` or the app's Drizzle ORM
- The API is running (for curl commands)
- `API_KEY` is set in your shell

```bash
export BASE="http://localhost:3000/api/v1"
export API_KEY="your-api-key"
```

---

## How to Check System Health

### Queue depth (pending deliveries)

```sql
SELECT state, count(*)
FROM webhook_deliveries
GROUP BY state
ORDER BY state;
```

Expected: `pending` and `retrying` counts should be low. If either grows continuously, the worker is not keeping up.

### Recent delivery activity

```sql
SELECT id,
       subscription_id,
       flag_key,
       state,
       attempts,
       last_error,
       created_at,
       updated_at
FROM webhook_deliveries
ORDER BY updated_at DESC
LIMIT 20;
```

### Delivery rate (last hour)

```sql
SELECT state, count(*)
FROM webhook_deliveries
WHERE updated_at > now() - interval '1 hour'
GROUP BY state;
```

### Circuit breaker status

The circuit breaker state is in-memory. Check via the API health endpoint or application logs for entries like
`"circuit open for example.com"`.

---

## Scenario: Deliveries Stuck in "sending"

**Symptoms:**

- `SELECT count(*) FROM webhook_deliveries WHERE state = 'sending'` returns a growing number
- Deliveries have `updated_at` that is minutes or hours old

**Cause:**

The worker crashed or was killed while processing a delivery. The delivery transitioned to `sending` but never
completed (no transition to `delivered`, `retrying`, or `failed`).

**Resolution:**

1. Identify stuck deliveries:

```sql
SELECT id, subscription_id, flag_key, attempts, updated_at
FROM webhook_deliveries
WHERE state = 'sending'
  AND updated_at < now() - interval '5 minutes';
```

2. Reset them to `retrying` so the worker picks them up again:

```sql
-- CAUTION: this manually overrides the state machine
UPDATE webhook_deliveries
SET state      = 'retrying',
    updated_at = now()
WHERE state = 'sending'
  AND updated_at < now() - interval '5 minutes';
```

3. Insert audit log entries for traceability:

```sql
INSERT INTO delivery_transitions (delivery_id, from_state, to_state, reason, created_at)
SELECT id, 'sending', 'retrying', 'Manual recovery: stuck in sending', now()
FROM webhook_deliveries
WHERE state = 'retrying'
  AND updated_at = (SELECT max(updated_at) FROM webhook_deliveries WHERE state = 'retrying');
```

4. Verify the worker is running and processing deliveries.

---

## Scenario: Dead Letter Queue Growing

**Symptoms:**

- `SELECT count(*) FROM webhook_deliveries WHERE state = 'dead'` is increasing
- Consumers report not receiving webhooks

**Cause:**

Either the consumer URL is permanently unreachable, or the consumer is returning 4xx errors (bad auth, wrong endpoint).

**Resolution:**

1. Identify which subscriptions have the most dead deliveries:

```sql
SELECT ws.id, ws.url, count(wd.id) as dead_count
FROM webhook_deliveries wd
       JOIN webhook_subscriptions ws ON ws.id = wd.subscription_id
WHERE wd.state = 'dead'
GROUP BY ws.id, ws.url
ORDER BY dead_count DESC;
```

2. Check the `last_error` on recent dead deliveries:

```sql
SELECT id, subscription_id, last_error, attempts, updated_at
FROM webhook_deliveries
WHERE state = 'dead'
ORDER BY updated_at DESC
LIMIT 10;
```

3. If `last_error` shows `HTTP 4xx` — the consumer URL or auth is wrong. Contact the consumer owner.

4. If `last_error` shows `ECONNREFUSED` or timeout — the consumer was down for all retry attempts. See "How to Replay
   Dead Deliveries" below.

---

## Scenario: Duplicate Deliveries Detected

**Symptoms:**

- Consumer reports receive the same webhook payload multiple times
- Multiple `delivered` transitions for the same delivery ID in audit log

**Resolution:**

1. Check the delivery's transition history:

```sql
SELECT dt.from_state, dt.to_state, dt.reason, dt.created_at
FROM delivery_transitions dt
WHERE dt.delivery_id = < delivery_id >
ORDER BY dt.created_at;
```

2. If you see `pending → sending` appearing twice for the same delivery: this indicates a race condition where two
   workers picked up the same row. This should not happen with `FOR UPDATE SKIP LOCKED` / pg-boss. Check worker
   concurrency settings.

3. If you see two separate delivery IDs for the same flag event and subscription: this is correct behavior. Each toggle
   creates a new delivery. The consumer should use the `X-Delivery-Id` header or `deliveryId` in the payload for
   deduplication on their side.

---

## Scenario: Consumer Not Responding (Circuit Breaker Open)

**Symptoms:**

- Logs show: `"Circuit open for example.com, deferring delivery"`
- Deliveries for that consumer are accumulating in `retrying` state
- Other consumers (different domains) are unaffected

**Cause:**

The consumer at `example.com` failed 5+ consecutive requests. The circuit breaker opened to protect both the consumer (from being hammered) and the worker (from wasting time on timeouts).

**Resolution:**

1. The circuit breaker will automatically transition to `half-open` after 30 seconds.
2. In `half-open`, one probe delivery will attempt. If it succeeds, the circuit closes and all pending deliveries
   resume.
3. If the consumer is still down, the circuit reopens for another 30 seconds.
4. No manual intervention is needed — the system self-heals when the consumer recovers.

**If you need to force-reset (e.g., consumer confirmed they're back):**

The circuit breaker is in-memory. Restart the API process to reset all breakers. This is safe — pending deliveries
remain in the database and will be retried.

---

## Scenario: High Delivery Latency

**Symptoms:**

- Gap between `created_at` and `updated_at` on delivered rows is > 30 seconds

**Cause:**

Either the worker poll interval is too slow, or the consumer is responding slowly (close to the 10-second timeout).

**Resolution:**

1. Check the average delivery time:

```sql
SELECT avg(extract(epoch FROM (updated_at - created_at))) as avg_seconds,
       max(extract(epoch FROM (updated_at - created_at))) as max_seconds
FROM webhook_deliveries
WHERE state = 'delivered'
  AND created_at > now() - interval '1 hour';
```

2. If `max_seconds` is close to 10: consumers are slow. Consider reducing `DELIVERY_TIMEOUT_MS` or contacting the
   consumer.

3. If the gap is large but the actual HTTP call is fast: the worker is not polling frequently enough. Reduce a poll
   interval or migrate to pg-boss for near-instant dispatch.

---

## How to Replay Dead Deliveries

Reset dead deliveries back to `pending` so they get retried from scratch.

**For a specific subscription:**

```sql
-- CAUTION: resets attempt counter. Consumer will receive these again.
UPDATE webhook_deliveries
SET state      = 'pending',
    attempts   = 0,
    last_error = NULL,
    updated_at = now()
WHERE state = 'dead'
  AND subscription_id = < subscription_id >;

-- Log the manual intervention
INSERT INTO delivery_transitions (delivery_id, from_state, to_state, reason, created_at)
SELECT id, 'dead', 'pending', 'Manual replay: operator intervention', now()
FROM webhook_deliveries
WHERE state = 'pending'
  AND attempts = 0
  AND subscription_id = < subscription_id >;
```

**For all dead deliveries (use with caution):**

```sql
UPDATE webhook_deliveries
SET state      = 'pending',
    attempts   = 0,
    last_error = NULL,
    updated_at = now()
WHERE state = 'dead';
```

**Via API (replay a single delivery):**

```bash
# Currently no replay endpoint — use SQL above.
# Future: POST /api/v1/webhooks/deliveries/:id/replay
```

---

## How to Manually Transition a Delivery

**WARNING:** Manual transitions bypass the state machine validation. Only use when automatic recovery is impossible.

```sql
-- Example: force a stuck delivery to dead
UPDATE webhook_deliveries
SET state      = 'dead',
    updated_at = now(),
    last_error = 'Manually killed by operator'
WHERE id = < delivery_id >;

INSERT INTO delivery_transitions (delivery_id, from_state, to_state, reason, created_at)
VALUES (<delivery_id>, '<current_state>', 'dead', 'Manual kill: <reason>', now());
```

Always record the transition in `delivery_transitions` for audit trail. Never leave a delivery in a modified state
without a corresponding transition log entry.

---

## Cleanup: Purge Old Deliveries

Delivered and dead records accumulate over time. Purge records older than 30 days:

```sql
-- Preview what will be deleted
SELECT state, count(*)
FROM webhook_deliveries
WHERE state IN ('delivered', 'dead')
  AND updated_at < now() - interval '30 days'
GROUP BY state;

-- Delete (cascades to delivery_transitions via FK)
DELETE
FROM webhook_deliveries
WHERE state IN ('delivered', 'dead')
  AND updated_at < now() - interval '30 days';
```
