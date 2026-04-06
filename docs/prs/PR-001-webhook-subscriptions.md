# PR-001: Webhook Subscription Management

## What changed

Add webhook subscription CRUD endpoints so external consumers can register URLs
to receive push notifications when feature flags change. This replaces the
polling-only model with event-driven delivery.

## Why

SDK consumers currently must poll `GET /evaluate/:key` to detect flag changes.
With 50+ consumers checking every 2 seconds, that is 1500 req/min of wasted
traffic for a flag that changes once per day. Webhooks push the change to
registered endpoints — zero waste, instant notification.

This PR adds the **registration layer only**. The actual delivery worker and
retry logic ship in PR-002.

## How

### Shared types (`packages/shared/index.ts`)

- `WebhookEventType` union: `"flag.toggled" | "flag.created" | "flag.deleted"`
- `WEBHOOK_EVENT_TYPES` runtime array for validation
- `WebhookSubscription`, `CreateWebhookBody`, `DeliveryState`, `WebhookDelivery`
- `ErrorCodes` extended: `WEBHOOK_NOT_FOUND`, `WEBHOOK_INVALID_URL`, `WEBHOOK_INVALID_EVENTS`

### Database schema (`apps/api/src/schema.ts`)

Two new tables:

- **`webhook_subscriptions`** — `id`, `url`, `secret`, `events` (text[]),
  `active`, timestamps. Stores registration data. `secret` column holds the
  HMAC signing key (needed by worker in PR-002).
- **`webhook_deliveries`** — `id`, `subscription_id` (FK cascade), `flag_key`,
  `event_type`, `state` (default `"pending"`), `attempts` (default 0),
  `last_error`, timestamps. Each row is one delivery attempt to one consumer.

FK uses `ON DELETE CASCADE` — deleting a subscription removes all its
deliveries and their audit trail automatically.

### Migration (`apps/api/drizzle/0001_odd_rafael_vega.sql`)

Generated via `drizzle-kit generate`. Creates both tables and the FK constraint.

### Routes (`apps/api/src/routes/webhooks.ts`)

| Method | Path                   | Auth    | Purpose                               |
| ------ | ---------------------- | ------- | ------------------------------------- |
| POST   | `/api/v1/webhooks`     | API key | Register consumer URL                 |
| GET    | `/api/v1/webhooks`     | API key | List all subscriptions (newest first) |
| DELETE | `/api/v1/webhooks/:id` | API key | Remove subscription + cascade         |

**Validation:**

- URL must match `^https?:\/\/.+` (allows HTTP in dev, restricts in prod later)
- Events array validated against `WEBHOOK_EVENT_TYPES` runtime constant
- Secret minimum 16 characters (Fastify JSON schema + custom check)

### Security boundary (`apps/api/src/mappers.ts`)

`toWebhookResponse()` **never returns the secret**. The field exists in the DB
row but is structurally excluded in the mapper. This is a compile-time guarantee
via the return type `WebhookSubscription`, which has no `secret` property.

### Error helpers (`apps/api/src/errors.ts`)

`webhookNotFound(id)`, `webhookInvalidUrl(url)`, `webhookInvalidEvents()` —
consistent with existing `flagNotFound`/`flagKeyExists` pattern.

### ADR-004: Queue Technology (pg-boss)

Chose pg-boss over BullMQ because:

1. Transactional enqueue — delivery insert + job enqueue in one Postgres tx
2. No new infra — Postgres already in the stack
3. Durability by default — WAL, not Redis AOF config

### ADR-005: Idempotency Strategy

Row-level `SELECT FOR UPDATE SKIP LOCKED` via pg-boss. Idempotency key is
`webhook_deliveries.id`. No distributed locks needed.

## What I considered but did not do

- **Hash the secret** — Worker needs plaintext for HMAC signing. Hashing would
  require the worker to have the original secret, defeating the purpose. The
  right approach is encryption-at-rest (deferred to Phase 3).
- **Bulk INSERT for subscriptions** — For N subscriptions, we do N individual
  inserts in a loop. Batch insert is cleaner but complicates getting the
  returned delivery IDs. Acceptable for now; fan-out job is the real fix.
- **Pagination on GET /webhooks** — Not implemented. At expected scale (<100
  subscriptions) this is unnecessary. If needed, add cursor-based pagination.

## How to test

```bash
export API_KEY=local-dev-key
export BASE=http://localhost:3000/api/v1

# Create subscription
curl -s -X POST "$BASE/webhooks" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"url":"https://httpbin.org/post","events":["flag.toggled"],"secret":"my-super-secret-key-123"}' | jq .

# List (secret must not appear)
curl -s "$BASE/webhooks" -H "X-Api-Key: $API_KEY" | jq '.[0] | keys'
# Expected: no "secret" key

# Delete
curl -s -X DELETE "$BASE/webhooks/1" -H "X-Api-Key: $API_KEY" | jq .

# Auth required
curl -s "$BASE/webhooks"
# Expected: 401

# Invalid URL
curl -s -X POST "$BASE/webhooks" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"url":"not-a-url","events":["flag.toggled"],"secret":"my-super-secret-key-123"}' | jq .
# Expected: 400
```

Automated: 15 integration tests in `apps/api/src/__tests__/webhooks.test.ts`
covering POST (8 cases), GET (3), DELETE (4).

## Risk

**Low.** Additive change — no existing endpoints modified. New tables have no
effect on existing queries. If subscriptions table causes issues, DROP the
migration and the rest of the API continues working.

**Rollback:** Revert the migration
(`DROP TABLE webhook_deliveries; DROP TABLE webhook_subscriptions;`), remove
the route registration in `index.ts`.
