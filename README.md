# flagsmith-lite

A feature flag service with webhook delivery, built as a realistic training ground for Senior → Staff Engineer growth.

This is **not** a production system. It exists to practice architectural decision-making, reliability engineering, typed
API contracts, and technical communication — all in a monorepo that mirrors real-world patterns.

## Quick Start

```bash
pnpm install
pnpm doctor                          # verify environment (Node 22+, pnpm, Docker)
docker compose up -d db cache        # Postgres 16 + Redis 7
pnpm --filter @project/api migrate   # run Drizzle migrations
pnpm dev                             # start API (port 3000) + Web (port 5173)
curl http://localhost:3000/health    # verify API is running
```

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    pnpm monorepo                     │
│                                                      │
│  apps/                                               │
│  ├── api/        Fastify 5 REST API                  │
│  │               CRUD flags, evaluate, Redis cache   │
│  │               Webhook subscriptions + admin       │
│  │               Auth via X-Api-Key, rate limiting   │
│  │                                                   │
│  └── web/        React 19 + Vite dashboard           │
│                  List, toggle, create, delete flags  │
│                                                      │
│  packages/                                           │
│  ├── shared/     TypeScript contracts (Flag, errors) │
│  │               Branded types (FlagKey, Timestamp)  │
│  │               Delivery state machine              │
│  │                                                   │
│  └── sdk/        Typed client for evaluate endpoint  │
│                  Fail-closed: isEnabled() → false    │
│                  Injectable fetch, AbortController   │
│                                                      │
│  infra/                                              │
│  ├── docker-compose.yml   Postgres 16 + Redis 7      │
│  └── Dockerfile           Multi-stage (turbo prune)  │
└──────────────────────┬───────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │ Postgres │  │  Redis   │  │ Railway  │
   │    16    │  │    7     │  │  deploy  │
   └──────────┘  └──────────┘  └──────────┘

Webhook delivery flow:

  Admin toggles flag ──→ PUT /flags/:key ──→ DB update
                                                │
                                                ▼
                                          enqueueDeliveries()
                                          (one per active subscription)
                                                │
                                                ▼
                                        ┌───────────────┐
                                        │    Worker     │
                                        │  polls every  │
                                        │    2 seconds  │
                                        └───────┬───────┘
                                                │
                                         POST consumer URL
                                         X-Webhook-Signature
                                                │
                                     ┌──────────┼──────────┐
                                     ▼          ▼          ▼
                                  delivered   retrying    dead
                                  (200 OK)    (5xx/net)  (max retries)
```

## Key Decisions

| Decision             | Choice                             | Record                                          |
|----------------------|------------------------------------|-------------------------------------------------|
| API style            | REST + Fastify + shared TS types   | [ADR-001](docs/adr/001-api-style.md)            |
| DB schema            | Single `flags` table, boolean-only | [ADR-002](docs/adr/002-db-schema-strategy.md)   |
| Environment model    | Per-env overrides (proposed)       | [ADR-003](docs/adr/003-environment-model.md)    |
| Queue technology     | pg-boss (Postgres-backed)          | [ADR-004](docs/adr/004-queue-technology.md)     |
| Idempotency strategy | Row-level locking via delivery ID  | [ADR-005](docs/adr/005-idempotency-strategy.md) |

## API

Full endpoint reference with request/response examples: [docs/API.md](docs/API.md)

### Flag endpoints

| Endpoint                    | Auth    | Description                            |
|-----------------------------|---------|----------------------------------------|
| `GET /health`               | Public  | Health check                           |
| `GET /api/v1/flags`         | API key | List all flags                         |
| `POST /api/v1/flags`        | API key | Create flag                            |
| `GET /api/v1/flags/:key`    | API key | Get single flag                        |
| `PUT /api/v1/flags/:key`    | API key | Update flag (toggles trigger webhooks) |
| `DELETE /api/v1/flags/:key` | API key | Delete flag                            |
| `GET /api/v1/evaluate/:key` | Public  | Evaluate flag (cached)                 |

### Webhook endpoints

| Endpoint                      | Auth    | Description           |
|-------------------------------|---------|-----------------------|
| `POST /api/v1/webhooks`       | API key | Register consumer URL |
| `GET /api/v1/webhooks`        | API key | List subscriptions    |
| `DELETE /api/v1/webhooks/:id` | API key | Remove subscription   |

### Admin endpoints

| Endpoint                                       | Auth    | Description                        |
|------------------------------------------------|---------|------------------------------------|
| `GET /api/v1/admin/delivery-stats`             | API key | Aggregate delivery counts by state |
| `GET /api/v1/admin/deliveries/:id`             | API key | Single delivery detail             |
| `GET /api/v1/admin/deliveries/:id/transitions` | API key | Audit log for a delivery           |
| `POST /api/v1/admin/deliveries/:id/replay`     | API key | Re-enqueue a failed/dead delivery  |

## Development

```bash
pnpm verify          # format + lint + typecheck + build + docs link check
pnpm test            # all tests (requires Postgres on port 5433)
pnpm test:unit       # unit tests only (no Docker needed)
pnpm build           # turbo build (topological, cached)
pnpm typecheck       # turbo typecheck
pnpm format:write    # auto-format all files
pnpm clean           # remove all build artifacts and node_modules
```

### Running the worker

The webhook delivery worker is a separate process that polls for pending deliveries:

```bash
# In a separate terminal (needs Postgres running)
cd apps/api
DATABASE_URL=postgres://flagr:password@localhost:5433/flagr pnpm exec tsx src/worker.ts
```

Or use Docker Compose, which starts everything together:

```bash
docker compose up --build -d    # API + worker + web + Postgres + Redis
```

### Webhook simulation

```bash
export API_KEY=change-me-in-production
export BASE=http://localhost:3000/api/v1

# 1. Create a flag
curl -s -X POST "$BASE/flags" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"key":"dark-mode","name":"Dark Mode","enabled":false}' | jq .

# 2. Register a webhook consumer
curl -s -X POST "$BASE/webhooks" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"url":"https://httpbin.org/post","events":["flag.toggled"],"secret":"my-secret-at-least-16-chars"}' | jq .

# 3. Toggle the flag (triggers webhook delivery)
curl -s -X PUT "$BASE/flags/dark-mode" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -H "X-Correlation-Id: test-001" \
  -d '{"enabled":true}' | jq .

# 4. Check delivery status
curl -s "$BASE/admin/delivery-stats" -H "X-Api-Key: $API_KEY" | jq .
```

Build pipeline uses [Turborepo](https://turbo.build/) for caching and topological task ordering. Repeated `pnpm build`
or `pnpm typecheck` runs hit cache (~100 ms) when source hasn't changed.

## Tests

| Package   | Unit | Integration | E2E | Total   |
|-----------|------|-------------|-----|---------|
| shared    | 55   | —           | —   | 55      |
| sdk       | 16   | —           | —   | 16      |
| api       | 16   | 33          | 6   | 55      |
| **Total** |      |             |     | **126** |

```bash
pnpm --filter @project/api test:unit         # fast, no Docker
pnpm --filter @project/api test:integration  # needs Postgres (flags + webhooks + admin)
pnpm --filter @project/api test:e2e          # needs Postgres
pnpm --filter @project/shared test           # branded types, errors, state machine
pnpm --filter @project/sdk test              # SDK client with mock fetch
```

## Project Scope

This project is deliberately constrained. Full scope analysis: [docs/SCOPE.md](docs/SCOPE.md)

**In scope:** boolean flags, webhook delivery with retry and circuit breaker, REST API, API key auth, Redis cache, Docker,
CI pipeline, typed SDK, delivery state machine, admin endpoints, structured logging.

**Explicitly excluded:** Kafka, multi-tenancy, real-time dashboard, OAuth subscription auth, payload templates, inbound
webhooks. Each exclusion has a documented "when to revisit" trigger.

**Effort/Impact analysis:** [docs/EFFORT-IMPACT.md](docs/EFFORT-IMPACT.md)

## Status

**Phase 1 — Foundation (completed):**

- REST API with full CRUD + evaluate endpoint
- Redis caching with graceful degradation
- Typed SDK with fail-closed defaults
- Branded types for compile-time safety
- Turborepo build pipeline with Docker multi-stage
- CI pipeline (verify → integration → Docker smoke)
- Deployed on Railway

**Phase 2 — Webhook Delivery (completed):**

- Webhook subscription management (CRUD)
- Delivery state machine (pending → sending → delivered / retrying → dead)
- HMAC-SHA256 payload signing
- Retry with exponential backoff (5 attempts)
- Per-domain circuit breaker (closed → open → half-open)
- Correlation ID propagation (X-Correlation-Id)
- Structured JSON logging (pino)
- Admin dashboard endpoints (stats, detail, transitions, replay)
- Delivery audit trail (transitions table)
- 126 tests across three packages

**Proposed:**

- [RFC-001: Environment Model](docs/rfcs/RFC-001-environment-model.md) — per-environment flag overrides

**Future:**

- Typed flag values (string, number, JSON)
- Percentage-based rollouts
- Delivery metrics + alerting
- Secret encryption at rest
