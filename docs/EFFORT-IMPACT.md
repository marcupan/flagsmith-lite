# Effort / Impact Analysis

Placement of every feature — built and excluded — on the effort/impact quadrant.

```
                      High Effort
                          │
   Q4: CUT                │   Q2: BUILD WITH JUSTIFICATION
   ─────────────────      │   ────────────────────────────
   Kafka streaming        │   Retry + backoff + dead-letter
   Real-time dashboard    │   Circuit breaker (per-domain)
   Multi-tenant subs      │   Admin endpoints + replay
   OAuth subscription     │   Structured JSON logging
   auth                   │   Correlation ID propagation
   Payload templates      │   Delivery audit trail
                          │
 ─────────────────────────┼──────────────────────────────
                          │
   Q3: NICE-TO-HAVE       │   Q1: BUILD FIRST
   ─────────────────      │   ────────────────
   Delivery batching      │   State machine
   Per-sub retry config   │   HMAC-SHA256 signing
   Secret rotation API    │   Webhook subscription CRUD
   Payload versioning     │   Idempotency check
   Secret encryption      │
                          │
                      Low Effort
   Low Impact ──────────────────────── High Impact
```

## Q1: High Impact, Low Effort — built first

- **Delivery state machine** — 3h implementation. Prevents stuck/impossible states across the
  entire delivery lifecycle. Every other feature depends on correct state transitions. The
  highest-leverage item: one enum + one transition table eliminated an entire class of bugs.

- **HMAC-SHA256 payload signing** — 2h implementation. Without it, consumers have no way to
  verify the sender. Node.js `crypto.createHmac()` is ~10 lines. The security payoff is
  disproportionate to the effort.

- **Webhook subscription CRUD** — 4h implementation. The foundation. No delivery can happen
  without registered subscriptions. Standard Fastify route pattern, already proven in flags
  CRUD.

- **Idempotency check** — 2h implementation. pg-boss `SELECT FOR UPDATE SKIP LOCKED`
  guarantees single-consumer delivery per job. No additional infrastructure, no Redis lock,
  no distributed coordination. The "build" was choosing the right tool, not writing code.

## Q2: High Impact, High Effort — built with justification

- **Retry with exponential backoff + dead-letter** — 8h implementation. Core reliability
  pattern. Without retry, any transient network error loses a delivery permanently. The
  effort is justified because webhooks without retry are essentially unreliable notifications
  — consumers cannot trust them. Dead-letter prevents infinite retry loops against permanently
  broken consumers.

- **Circuit breaker (per-domain)** — 4h implementation. Without it, one dead consumer
  saturates the worker with 10-second timeouts, starving all healthy consumers. The effort is
  justified because this is a cascade failure prevention mechanism — the kind of problem that
  turns a minor outage into a total one.

- **Admin endpoints (stats, detail, transitions, replay)** — 6h implementation. Four endpoints
  with common patterns (id parsing, 404 handling). The effort is justified because without
  admin visibility, diagnosing delivery failures requires direct SQL access — unacceptable in
  any production system.

- **Structured JSON logging + correlation ID** — 4h implementation. Replaced `console.log`
  with Fastify's pino logger, added `X-Correlation-Id` header propagation. The effort is
  justified because tracing a flag toggle through API → delivery → consumer is impossible
  with unstructured logs once you have more than one concurrent request.

- **Delivery audit trail (transitions table)** — 3h implementation. An extra INSERT per state
  change. The effort is justified for post-incident review: "what happened to delivery #42?"
  has a complete answer in `delivery_transitions`, with timestamps and reasons.

## Q3: Low Impact, Low Effort — nice-to-have (some built, some deferred)

- **Delivery batching** — 4h to implement, but individual deliveries are easier to trace,
  retry, and reason about. Batching only matters when notification volume overwhelms consumer
  HTTP connection pools. Not the case at current scale.

- **Per-subscription retry configuration** — 3h to add config columns + validation. Global
  policy (5 attempts, exponential backoff) covers all current cases. Different SLAs are a
  hypothetical need.

- **Secret rotation API** — 3h to implement versioned-secret logic (accept old + new during
  transition). Delete-and-recreate works for now. Rotation matters during incidents when
  speed counts — a real but infrequent need.

- **Payload versioning** — 2h to add a `version` field. Only matters when the payload schema
  changes and consumers cannot upgrade simultaneously. The schema has not changed once.

- **Secret encryption at rest** — 3h to add AES-256-GCM encryption with env var key. Risk is
  documented. Encryption matters when the DB is a realistic attack surface (production data,
  shared hosting). Not the case in a learning project.

## Q4: Low Impact, High Effort — cut

- **Kafka / distributed streaming** — 20h+ for ZooKeeper/KRaft setup, partition management,
  consumer groups, schema registry. pg-boss handles current volume. Kafka teaches ops
  complexity, not reliability patterns. Same learning value at 10x the cost.

- **Real-time delivery dashboard** — 15h+ of frontend work (WebSocket server, connection
  management, React state for live updates, error handling for disconnects). Admin API + curl
  covers all debugging needs. The dashboard is a UX improvement for a problem that occurs
  during incidents — when engineers use CLI tools, not dashboards.

- **Multi-tenant subscriptions** — 12h+ for tenant isolation, per-tenant quotas, billing
  hooks, data partitioning. Single-tenant covers every reliability pattern (retry, circuit
  breaker, dead-letter, idempotency). Multi-tenancy is a business concern, not an engineering
  learning concern.

- **OAuth subscription authentication** — 10h+ for three-legged OAuth flow, token storage,
  refresh logic, error handling for expired tokens. HMAC shared secret is the industry
  standard for push webhooks. OAuth is for pull-based APIs where the consumer initiates the
  connection.

- **Webhook payload templates** — 8h+ for template DSL, parser, validation, testing of N
  template variations. Fixed payload format means one test covers all consumers. Templates
  multiply the test matrix by the number of template variations.

- **Multi-provider inbound webhooks** — 10h+ for inbound routing, provider-specific signature
  verification, event normalization. Completely different domain from outbound notifications.
  Zero code reuse with what we built.
