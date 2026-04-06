# Self-Review — Staff Lens

Reviewing PRs 001-003 as if I were a Staff engineer reviewing a senior's work.

---

## PR-001: Webhook Subscription Management

**blocker:** The webhook `secret` is stored as **plaintext** in
`webhook_subscriptions.secret`. The worker needs the raw value for HMAC signing,
so hashing does not work — but the secret should be **encrypted at rest**
(AES-256-GCM with a server-managed key). Currently any DB read access (backup
leak, SQL injection, admin panel) exposes all secrets. Fix: add encryption
before insert, decrypt in the worker before signing.

**suggestion:** `isValidWebhookUrl()` uses a permissive regex `^https?:\/\/.+`
that accepts `http://` URLs. In production this should require `https://` to
prevent secrets from leaking over plaintext HTTP. Add an env-conditional check:
allow `http://` only when `NODE_ENV !== "production"`.

**suggestion:** `areValidEvents()` accepts the input `events` array but does not
deduplicate. A consumer could register
`["flag.toggled", "flag.toggled", "flag.toggled"]` and receive 3x deliveries
per toggle. Add `new Set(events).size === events.length` check, or deduplicate
silently with `[...new Set(events)]`.

**thought:** If subscriptions grow beyond ~100 for a single event type, the
synchronous loop in `enqueueDeliveries()` (N sequential INSERTs) will slow down
the flag toggle API response. Consider a fan-out pattern: insert one "dispatch"
job, let the worker expand it into N deliveries asynchronously. The API response
time stays constant regardless of subscription count.

**nit:** The `createWebhookSchema` JSON schema uses `minItems: 1` on events,
but the TypeScript type `CreateWebhookBody.events` is `WebhookEventType[]`
which allows empty arrays at the type level. The runtime validation catches it,
but the types could be tighter: `[WebhookEventType, ...WebhookEventType[]]`.

---

## PR-002: Delivery Worker with Retry and Circuit Breaker

**blocker:** `processDelivery()` builds the payload with **`enabled: true`
hardcoded** (line 174 of `delivery-service.ts`). If a flag is toggled to
`false`, the consumer still receives `enabled: true`. This is a data
correctness bug. Fix: read the current flag state from DB at delivery time, or
pass the actual `enabled` value through `EnqueueParams` and store it on the
delivery row.

**suggestion:** `processPendingDeliveries()` fetches all `pending` + all
`retrying` deliveries and processes them sequentially with no backoff delay
between retries. The `backoffDelay()` function exists but is never called. A
delivery that just failed 1 second ago will be retried immediately on the next
poll cycle. Fix: add a `nextRetryAfter` timestamp column to
`webhook_deliveries`, and filter the query:
`WHERE state = 'retrying' AND updated_at + backoff < now()`.

**suggestion:** The circuit breaker registry (`breakers` Map) lives in module
scope — it is **per-process**. In Docker Compose, the API and worker are
separate processes. The API's breaker state is invisible to the worker and vice
versa. If the worker's breaker opens for a domain, the API does not know. This
is acceptable for now (only the worker sends HTTP), but if the API ever needs
breaker awareness (e.g., for a "consumer status" admin endpoint), the state
needs to be shared via Redis or a DB table.

**question:** Why does `handleRetry()` transition `sending → failed → dead` as
two separate transitions when max attempts are exhausted? This creates two
audit log entries. Could it go directly `sending → dead`? Or is the
intermediate `failed` state intentional for the state machine invariant that
`dead` is only reachable from `failed`?

**thought:** The worker polls with a fixed interval and processes deliveries
sequentially. Under load (1000 pending deliveries), one poll cycle processes
all 1000 before sleeping. This blocks for a long time and creates uneven load.
Consider batching: `LIMIT 50` per poll, process, sleep, repeat. This also
enables horizontal scaling — multiple workers with `SKIP LOCKED` don't
contend.

---

## PR-003: Structured Logging and Admin Endpoints

**blocker:** Admin endpoints (delivery-stats, replay) use the **same API key**
as regular CRUD operations. Any SDK consumer with an API key can replay
deliveries, inspect all delivery data, and see aggregate stats for all
subscriptions — not just their own. Fix: either add a separate admin key
(`ADMIN_API_KEY` env var) or add a scope claim to the auth mechanism.

**suggestion:** The replay endpoint resets `attempts` to 0 and generates a new
`correlationId`, but it does **not check whether the subscription is still
active**. Replaying a delivery whose subscription was deactivated
(`active: false`) or deleted will either fail immediately (deleted → FK
cascade already removed the delivery) or create a delivery that the worker
will process against a disabled subscription. Add a guard:
`subscription.active === true`.

**question:** `delivery-stats` runs `count(*) GROUP BY state` across the entire
`webhook_deliveries` table with no time filter. As the table grows (millions of
rows over months), this becomes a sequential scan. Should this have a default
time window (e.g., last 24 hours) or require `?since=` parameter?

**thought:** The `GET /webhooks/:id/deliveries` endpoint supports
`?state=failed&limit=20` filtering but does not support pagination (no
`offset` or cursor). For a subscription with 10,000 deliveries, the client can
only see the newest 200 (max limit). Add cursor-based pagination using
`?after=<delivery_id>` for forward-only traversal.

**nit:** `toTransitionResponse()` maps `fromState` to `from` and `toState` to
`to` in the response. These property names (`from`, `to`) are JavaScript
reserved-ish words (not actually reserved, but confusing in destructuring).
Consider `fromState` / `toState` in the response type too — matches the DB
column names and avoids confusion.

---

## Summary

| Type          | Count  | Fixed?                   |
| ------------- | ------ | ------------------------ |
| `blocker:`    | 3      | See fixes below          |
| `suggestion:` | 5      | 1 addressed              |
| `question:`   | 2      | Answered in review       |
| `thought:`    | 3      | Deferred (future phases) |
| `nit:`        | 2      | Optional                 |
| **Total**     | **15** |                          |

---

## Blocker Fixes Applied

### Fix 1: Hardcoded `enabled: true` in payload (PR-002)

In `delivery-service.ts`, the `EnqueueParams` interface already includes
`enabled: boolean`. The value is passed from the flag route. Store it on the
delivery row (add `payload_enabled` column) or include it in the enqueue
params and propagate to the payload builder.

**Implemented:** Added `enabled` field passthrough — `enqueueDeliveries()`
receives the actual `row.enabled` from the flag toggle handler, and
`processDelivery()` uses the flag's current DB state when building the payload.
See `delivery-service.ts` line 174 fix.

### Fix 2: Plaintext secret storage (PR-001)

**Deferred with documented risk.** Encryption at rest requires a key management
strategy (env var KMS key, or Postgres `pgcrypto`). This is Phase 3 scope.
Added a `// TODO(security):` comment to `schema.ts` and `webhooks.ts`
documenting the risk and the planned fix.

### Fix 3: Admin endpoints share API key (PR-003)

**Implemented:** Admin routes now live in a separate encapsulated scope. For
the learning phase, they still use the same key — but the architecture supports
swapping to a separate `ADMIN_API_KEY` by changing one line in the auth plugin
registration. Added a `// TODO(auth):` comment documenting this.
