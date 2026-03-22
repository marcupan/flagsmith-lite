# flagsmith-lite

A feature flag service built as a realistic training ground for Senior → Staff Engineer growth.

This is **not** a production system. It exists to practice architectural decision-making, typed API contracts, build
system mastery, and technical communication — all in a monorepo that mirrors real-world patterns.

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
│  │               Auth via X-Api-Key, rate limiting   │
│  │                                                   │
│  └── web/        React 19 + Vite dashboard           │
│                  List, toggle, create, delete flags  │
│                                                      │
│  packages/                                           │
│  ├── shared/     TypeScript contracts (Flag, errors) │
│  │               Branded types (FlagKey, Timestamp)  │
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
```

## Key Decisions

| Decision          | Choice                             | Record                                        |
|-------------------|------------------------------------|-----------------------------------------------|
| API style         | REST + Fastify + shared TS types   | [ADR-001](docs/adr/001-api-style.md)          |
| DB schema         | Single `flags` table, boolean-only | [ADR-002](docs/adr/002-db-schema-strategy.md) |
| Environment model | Per-env overrides (proposed)       | [ADR-003](docs/adr/003-environment-model.md)  |

## API

Full endpoint reference with request/response examples: [docs/API.md](docs/API.md)

Highlights:

| Endpoint                    | Auth    | Description            |
|-----------------------------|---------|------------------------|
| `GET /health`               | Public  | Health check           |
| `GET /api/v1/flags`         | API key | List all flags         |
| `POST /api/v1/flags`        | API key | Create flag            |
| `GET /api/v1/evaluate/:key` | Public  | Evaluate flag (cached) |

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

Build pipeline uses [Turborepo](https://turbo.build/) for caching and topological task ordering. Repeated `pnpm build`
or `pnpm typecheck` runs hit cache (~100 ms) when source hasn't changed.

## Tests

| Package   | Unit | Integration | E2E | Total  |
|-----------|------|-------------|-----|--------|
| shared    | 25   | —           | —   | 25     |
| sdk       | 16   | —           | —   | 16     |
| api       | 16   | 15          | 6   | 37     |
| **Total** |      |             |     | **78** |

```bash
pnpm --filter @project/api test:unit         # fast, no Docker
pnpm --filter @project/api test:integration  # needs Postgres
pnpm --filter @project/api test:e2e          # needs Postgres
pnpm --filter @project/shared test           # branded types, errors
pnpm --filter @project/sdk test              # SDK client with mock fetch
```

## Project Scope

This project is deliberately constrained.

**In scope:** boolean flags, single-table schema, REST API, API key auth, Redis cache, Docker, CI pipeline, typed SDK.

**Out of scope:** multi-tenancy, RBAC, audit logs, percentage rollouts, A/B testing, SSE/WebSocket streaming.

## Status

**Completed:**

- REST API with full CRUD + evaluate endpoint
- Redis caching with graceful degradation
- Typed SDK with fail-closed defaults
- Branded types for compile-time safety
- Turborepo build pipeline with Docker multi-stage
- Seventy-eight tests across three packages
- CI pipeline (verify → integration → Docker smoke)
- Deployed on Railway

**Proposed:**

- [RFC-001: Environment Model](docs/rfcs/RFC-001-environment-model.md) — per-environment flag overrides

**Future (Project 2+):**

- Webhook delivery with queues, retries, idempotency
- Typed flag values (string, number, JSON)
- Percentage-based rollouts
