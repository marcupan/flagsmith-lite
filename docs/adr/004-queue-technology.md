# ADR-004: Queue Technology for Webhook Delivery

## Status

Accepted

## Context

When a flag changes, webhook notifications must be delivered to registered consumer URLs. This delivery must be decoupled
from the API response path — the admin toggling a flag should not wait for all HTTP POST requests to consumers to
complete. We need a queue to buffer delivery jobs and support retries with exponential backoff and dead-letter handling.

**Constraints:**

- Single engineer, no dedicated infrastructure team
- Postgres and Redis already in Docker Compose stack
- Must support retries with configurable backoff
- Must handle permanently failed deliveries (dead-letter equivalent)
- Must allow monitoring queue depth for saturation alerts

## Options Considered

### A: BullMQ (Redis-backed)

Mature Redis-based queue with built-in retry, backoff, and dead-letter support. Dashboard available via `bull-board`.
Requires Redis — already present in our stack.

- **Pro:** Rich feature set, large community, built-in backoff strategies, real-time events
- **Con:** Queue state lost if Redis restarts without persistence (AOF/RDB). Adds dependency on Redis availability for
  writes, not just caching

### B: pg-boss (Postgres-backed)

Postgres-native job queue using `SKIP LOCKED` internally. Zero additional infrastructure — uses the database we already
have.

- **Pro:** Transactional enqueue (insert delivery row + enqueue in same transaction), durable by default (Postgres WAL),
  built-in retry/expiry/dead-letter
- **Con:** Polling-based (configurable interval), slightly higher latency than Redis pub/sub. Adds load to Postgres under
  high throughput

### C: Custom `FOR UPDATE SKIP LOCKED`

Hand-rolled queue using Postgres advisory locks or `SELECT FOR UPDATE SKIP LOCKED` on the deliveries table itself.

- **Pro:** Full control, no external dependency, schema is the queue
- **Con:** Must implement retry logic, backoff, dead-letter, and concurrency control manually. High bug surface area for
  a single engineer

## Decision

**Option B — pg-boss.** Rationale:

1. **Transactional safety:** Enqueue happens in the same Postgres transaction as the flag update. If the transaction
   rolls back, no orphan delivery job exists. BullMQ cannot participate in a Postgres transaction — the Redis LPUSH
   happens outside the DB commit, creating a window where the queue has a job but the DB change was rolled back.

2. **Durability by default:** Postgres WAL ensures jobs survive restarts. Redis requires AOF configuration to avoid data
   loss — an ops burden for a solo engineer.

3. **Ops simplicity:** No additional infrastructure. `pg-boss` manages its own schema (`pgboss.*` tables) and garbage
   collection. Monitoring queue depth is a SQL query: `SELECT count(*) FROM pgboss.job WHERE name = 'webhook-deliver'
AND state = 'active'`.

4. **Migration path:** If throughput outgrows Postgres-backed queuing (>1000 deliveries/sec sustained), migrate to
   BullMQ by swapping the enqueue/dequeue calls. The delivery state machine in our `webhook_deliveries` table remains
   the source of truth regardless of queue backend — the queue is a transport mechanism, not the record of delivery
   state.

## Consequences

- Polling interval (default 2s) adds up to 2s latency before a job is picked up. Acceptable for webhook delivery where
  consumers tolerate seconds of delay.
- Postgres becomes both data store and job queue — monitor connection pool usage and query latency. If Postgres is
  overwhelmed, both API and delivery processing degrade together.
- `pg-boss` adds ~15 tables to the database under the `pgboss` schema. These are internal and should not be modified
  directly.
