# ADR-005: Idempotency Strategy for Webhook Delivery

## Status

Accepted

## Context

When a flag changes, one delivery record is created per active subscription. Network failures, worker crashes, or
Postgres failovers can cause a delivery attempt to be retried — potentially delivering the same payload to a consumer
twice. Consumers may not be idempotent themselves, so duplicate deliveries can cause confusion (e.g., a consumer
toggling its local cache on each POST would flip state incorrectly on a duplicate).

We need a strategy to ensure each delivery is attempted at most once per retry cycle, even under concurrent workers and
race conditions.

**Race condition scenario:** Flag `dark-mode` is toggled twice within 50ms. Two delivery jobs are enqueued for the same
subscription. Worker A picks job-1 and sends POST. Worker B picks job-2 and sends POST. Both are legitimate — they
represent distinct flag change events. The idempotency strategy must not deduplicate these (they are different events)
but must prevent the same job from being processed twice if a worker crashes mid-delivery and the job is re-enqueued.

## Options Considered

### A: Check delivery ID before sending

Before each HTTP POST, query `webhook_deliveries` for the delivery ID. If `state = 'delivered'`, skip. Otherwise,
transition to `'sending'` and proceed.

- **Pro:** Simple, uses existing table
- **Con:** TOCTOU race — two workers could both read `state = 'pending'` and both proceed. Requires row-level locking

### B: Unique constraint on idempotency key

Add a `delivery_key` column with a unique constraint: `(subscription_id, flag_key, event_type, event_timestamp)`. Insert
fails on duplicate, preventing double-enqueue.

- **Pro:** Database enforces uniqueness at insert time — no race conditions possible
- **Con:** Requires schema change, and the composite key must be carefully chosen to avoid false deduplication of
  legitimate rapid events

### C: Redis SET NX with TTL

Before sending, `SET delivery:{id} NX EX 300`. If SET succeeds, proceed. If it fails, another worker already claimed
this delivery.

- **Pro:** Fast, distributed lock with automatic expiry
- **Con:** Lost on Redis restart. If Redis is down, either all deliveries block (unsafe) or all proceed without
  idempotency (also unsafe)

## Decision

**Option A with row-level locking** — check delivery state with `SELECT ... FOR UPDATE SKIP LOCKED`.

The delivery flow becomes:

1. Worker polls for `state = 'pending'` jobs using `SELECT ... FOR UPDATE SKIP LOCKED` (via pg-boss internally)
2. pg-boss guarantees single-consumer delivery per job — only one worker receives a given job
3. Worker transitions state to `'sending'` before making the HTTP POST
4. On success → `'delivered'`. On failure → `'failed'` (pg-boss handles re-enqueue to `'retrying'` with backoff)
5. After max retries exhausted → `'dead'`

**Why not Option B:** The composite unique key `(subscription_id, flag_key, event_type)` would incorrectly deduplicate
rapid successive events. Adding a timestamp component requires choosing a precision (ms? μs?) and still risks edge
cases. Since pg-boss already guarantees single delivery per job, a unique constraint adds complexity without benefit.

**Why not Option C:** Redis is our cache layer with graceful degradation — the API works without it. Making idempotency
depend on Redis would create a hard dependency on a system designed to be optional.

## Idempotency Key

The idempotency key is the `webhook_deliveries.id` (auto-increment primary key). Each flag change event creates a
distinct delivery row per subscription. The delivery ID uniquely identifies the combination of (event + subscription).
pg-boss job references this delivery ID, and its single-consumer guarantee prevents duplicate processing.

## TTL / Cleanup

Delivered and dead-letter records are retained in `webhook_deliveries` for observability (dashboard queries, SLO
calculations). A scheduled cleanup job will purge records older than 30 days — implemented in Phase 2.3 (Reliability
Engineering).

## Consequences

- Idempotency is coupled to pg-boss's single-consumer guarantee. If we migrate to BullMQ (ADR-004 migration path), we
  must verify BullMQ provides equivalent guarantees (it does — `concurrency` + `lockDuration`).
- No distributed lock overhead — the database row lock is the lock.
- Rapid successive events for the same flag are correctly treated as distinct deliveries, each with its own ID.
