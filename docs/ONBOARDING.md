# flagsmith-lite — Onboarding

A feature flag service with webhook delivery. Admins toggle flags via API,
SDK consumers evaluate flags, and registered webhooks receive push
notifications on flag changes.

## Architecture

```
                  ┌─────────────────────────────────────────────┐
                  │              Docker Compose                 │
                  │                                             │
 Admin / UI ──────┤  ┌─────────┐        ┌──────────┐            │
  (apps/web)      │  │   API   │───────→│ Postgres │            │
                  │  │ :3000   │        │  :5433   │            │
 SDK Consumer ────┤  │ Fastify │←───────│  flags   │            │
  GET /evaluate   │  └────┬────┘        │  subs    │            │
                  │       │             │  deliver │            │
                  │       │ cache       └──────────┘            │
                  │       │                                     │
                  │       ▼                                     │
                  │  ┌─────────┐                                │
                  │  │  Redis  │                                │
                  │  │  :6379  │                                │
                  │  └─────────┘                                │
                  │                                             │
                  │  ┌──────────┐       ┌──────────────────┐    │
                  │  │  Worker  │──────→│ Consumer URLs    │    │
                  │  │ polls DB │       │ POST /hook       │    │
                  │  │ sends    │       │ X-Webhook-Sig    │    │
                  │  │ webhooks │       └──────────────────┘    │
                  │  └──────────┘                               │
                  └─────────────────────────────────────────────┘
```

**API** (`apps/api/src/index.ts`) — Fastify server. Flag CRUD, webhook
subscription management, evaluate endpoint, admin dashboard endpoints.

**Worker** (`apps/api/src/worker.ts`) — Same codebase, different entry point.
Polls for pending/retrying deliveries every 2s, sends POST to consumer URLs
with HMAC-SHA256 signature.

**Shared** (`packages/shared/`) — Types, branded primitives, error codes,
delivery state machine. Used by both API and worker.

**Web** (`apps/web/`) — React 19 + Vite. Minimal admin UI.

## How to run locally

### Prerequisites

- Node.js 22+
- pnpm 9+
- Docker Desktop (for Postgres + Redis)

### Steps

```bash
# 1. Clone and install
git clone <repo-url>
cd staff-roadmap-1-flagsmith-lite
pnpm install

# 2. Start infrastructure (Postgres + Redis)
docker compose up db cache -d

# 3. Wait for healthy
docker compose ps   # db and cache should show (healthy)

# 4. Run database migrations
cd apps/api
DATABASE_URL=postgres://flagr:password@localhost:5433/flagr pnpm exec tsx migrate.ts
cd ../..

# 5. Start the API (loads .env automatically)
pnpm --filter @project/api dev
# API is now on http://localhost:3000

# 6. (Optional) Start the worker in another terminal
cd apps/api
DATABASE_URL=postgres://flagr:password@localhost:5433/flagr pnpm exec tsx src/worker.ts

# 7. Verify
curl http://localhost:3000/health | jq .
```

### Or use Docker Compose for everything

```bash
docker compose up --build -d
# API on :3000, Web on :5173
# API_KEY defaults to "local-dev-key"
```

## How to toggle a flag and see a webhook

```bash
export API_KEY=local-dev-key   # or change-me-in-production for local dev
export BASE=http://localhost:3000/api/v1

# 1. Create a flag
curl -s -X POST "$BASE/flags" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"key":"dark-mode","name":"Dark Mode","enabled":false}' | jq .

# 2. Register a webhook (httpbin echoes the POST back)
curl -s -X POST "$BASE/webhooks" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"url":"https://httpbin.org/post","events":["flag.toggled"],"secret":"my-secret-at-least-16-chars"}' | jq .

# 3. Toggle the flag
curl -s -X PUT "$BASE/flags/dark-mode" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"enabled":true}' | jq .

# 4. Wait for worker, then check delivery
sleep 5
curl -s "$BASE/admin/delivery-stats" -H "X-Api-Key: $API_KEY" | jq .
# Expected: { "delivered": 1, ... }
```

## How to trace a delivery

Every request can include `X-Correlation-Id`. This ID flows through
API -> delivery row -> worker logs.

```bash
# Toggle with explicit correlation ID
curl -s -X PUT "$BASE/flags/dark-mode" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -H "X-Correlation-Id: debug-123" \
  -d '{"enabled":false}' | jq .

# Find all logs for this trace (Docker Compose)
docker compose logs --no-log-prefix api worker | grep "debug-123"

# Or check the audit trail via API
curl -s "$BASE/admin/deliveries/1/transitions" -H "X-Api-Key: $API_KEY" | jq .
```

## How to check if something is broken

```bash
# 1. Health check
curl -s http://localhost:3000/health | jq .
# Expected: { "status": "ok", ... }

# 2. Delivery stats — are deliveries piling up?
curl -s "$BASE/admin/delivery-stats" -H "X-Api-Key: $API_KEY" | jq .
# Watch for: pending > 0 (worker not running), retrying > 10 (consumers down)

# 3. Typecheck + format + build
pnpm verify

# 4. Run tests (needs Postgres running)
DATABASE_URL=postgres://flagr:password@localhost:5433/flagr \
  pnpm --filter @project/api test:integration

# 5. Environment check
pnpm doctor
```

## Key decisions

| Decision           | ADR                                        | Summary                                                  |
|--------------------|--------------------------------------------|----------------------------------------------------------|
| Queue technology   | [ADR-004](adr/004-queue-technology.md)     | pg-boss (Postgres) — transactional enqueue, no new infra |
| Idempotency        | [ADR-005](adr/005-idempotency-strategy.md) | Row-level locking via delivery ID, no Redis lock         |
| DB schema strategy | [ADR-002](adr/002-db-schema-strategy.md)   | Drizzle ORM with generated migrations                    |
| Environment model  | [ADR-003](adr/003-environment-model.md)    | Separate `flag_overrides` table (deferred)               |
| API style          | [ADR-001](adr/001-api-style.md)            | REST, JSON Schema validation, versioned under `/api/v1/` |

## Common mistakes

**1. Wrong API key.** Local dev uses `change-me-in-production` (from `.env`).
Docker Compose uses `local-dev-key` (from `docker-compose.yml` default). Check
which one your running server expects.

**2. Port 3000 already in use.** Docker maps the API container to :3000. If you
also run `pnpm --filter @project/api dev` locally, they collide. Either stop
the Docker API container (`docker stop staff-roadmap-1-flagsmith-lite-api-1`)
or change the local port.

**3. Migrations not run.** If you get "relation does not exist" errors, run
migrations:
`DATABASE_URL=postgres://flagr:password@localhost:5433/flagr pnpm exec tsx migrate.ts`
from the `apps/api/` directory.

**4. Worker not running.** If you toggle a flag but deliveries stay `pending`,
the worker process is not running. Start it in a separate terminal or use
`docker compose up` which includes the worker service.

**5. Forgetting `X-Api-Key` header.** All routes under `/api/v1/` (except
`/evaluate`) require the `X-Api-Key` header. The error message
`"Invalid or missing X-Api-Key header"` always means this.
