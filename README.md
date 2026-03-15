# Flagsmith Lite — Staff Engineer Learning Project

Feature flag service built as a realistic training project for Senior → Staff Engineer growth.

## Quick start

```bash
pnpm install && pnpm doctor
docker compose up -d db cache
pnpm --filter @project/api migrate
pnpm --filter @project/api dev
pnpm smoke:health
```

## What is built

- **API** — Fastify 5 + TypeScript. CRUD for feature flags, Redis evaluation cache, typed errors, API key auth.
- **Web** — React 19 + Vite. Flag dashboard: list, toggle, create, delete.
- **Shared** — TypeScript contract between API and web.
- **Infra** — Postgres 16 + Redis 7 via Docker Compose with health checks.
- **CI** — 3-job GitHub Actions pipeline: verify → integration tests → docker smoke.

## Documentation

Start here: [docs/staff-playbook/00-start-here.uk.md](docs/staff-playbook/00-start-here.uk.md)

## Scripts

```bash
pnpm doctor        # environment check
pnpm verify        # format + lint + typecheck + build + docs links
pnpm smoke:health  # runtime health check (API must be running)
pnpm test          # integration tests (requires running Postgres)
```
