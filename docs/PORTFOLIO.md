# Staff Engineer Portfolio — flagsmith-lite

## About

A Senior → Staff+ growth project: building a feature flag service from scratch, demonstrating architecture, reliability,
delivery, and technical leadership in a single evolving codebase.

**Stack:** TypeScript, Fastify 5, Drizzle ORM, Postgres, Redis, Prometheus/Grafana, GitHub Actions, pnpm monorepo with
Turborepo.

## What This Project Covers

### Phase 1: Control Plane Foundations

- **API contract design** — typed, versioned REST API with Fastify 5 plugin architecture
- **Monorepo architecture** — Turborepo with 6 packages (api, web, sdk, shared, config-ts, config-lint, cli)
- **Advanced TypeScript** — branded types (`FlagKey`), discriminated unions, exhaustive checks
- **Testing strategy** — pyramid model: unit → integration → E2E, all via Vitest
- **Technical communication** — RFC for environment model, 5 ADRs for key decisions

### Phase 2: Reliability and Integration

- **Webhook delivery subsystem** — subscription CRUD, queue-based worker, HMAC signing
- **Explicit state machine** — `pending → sending → delivered/retrying/failed → dead` with transition validation
- **Reliability patterns** — exponential backoff retry (5 attempts), per-domain circuit breaker, dead-letter
- **Structured logging** — Pino JSON logs with correlation ID propagation across API → worker → consumer
- **Scope management** — explicit included/excluded features with rationale (SCOPE.md, EFFORT-IMPACT.md)

### Phase 3: Delivery and Operations

- **CI/CD pipeline** — GitHub Actions with 5 stages, concurrency control, Docker smoke tests
- **Observability** — 10 Prometheus metrics, Grafana dashboard (10 panels), 6 SLO definitions, 6 alert rules
- **Incident response** — 2 simulation scripts (SEV2 DB overload, SEV3 consumer outage), 2 blameless postmortems, 6
  implemented action items
- **Developer productivity** — DX audit with measurements, CLI tooling (5 commands), setup/seed scripts
- **Internal platform** — shared configs (TypeScript, ESLint, Prettier), CLI tool as codified workflow
- **Load testing** — k6 script with smoke + load scenarios, SLO compliance report, bottleneck analysis
- **Technical strategy** — vision document with 3-phase roadmap, evidence-based priorities, explicit non-goals

## Key Artifacts

| Type              | Count | Location                   |
|-------------------|-------|----------------------------|
| ADR               | 5     | `docs/adr/`                |
| RFC               | 1     | `docs/rfcs/`               |
| Postmortem        | 2     | `docs/incidents/`          |
| Load test report  | 1     | `docs/LOAD-TEST-REPORT.md` |
| Technical vision  | 1     | `docs/VISION.md`           |
| Runbook           | 1     | `docs/runbook.md`          |
| SLO definitions   | 1     | `docs/SLO.md`              |
| DX audit          | 1     | `docs/DX-AUDIT.md`         |
| Scope document    | 1     | `docs/SCOPE.md`            |
| Effort/impact map | 1     | `docs/EFFORT-IMPACT.md`    |
| Platform docs     | 1     | `docs/PLATFORM.md`         |
| Onboarding guide  | 1     | `docs/ONBOARDING.md`       |
| Merge checklist   | 1     | `docs/MERGE-CHECKLIST.md`  |
| PR descriptions   | 3     | `docs/prs/`                |

## Staff+ Skills Demonstrated

| Skill                     | Evidence                                                               |
|---------------------------|------------------------------------------------------------------------|
| System design             | Webhook delivery architecture with queue, retry, circuit breaker       |
| Technical decision-making | 5 ADRs with context, alternatives, consequences                        |
| Scope management          | Explicit non-goals with rationale, effort/impact quadrant              |
| Observability             | 10 metrics, 6 alerts, Grafana dashboard, SLO definitions               |
| Incident response         | 2 simulations, blameless postmortems, 6 implemented action items       |
| Performance analysis      | k6 load test, bottleneck identification, prioritized recommendations   |
| Technical communication   | RFC, vision doc, onboarding guide, runbook                             |
| Developer productivity    | DX audit with measurements, CLI tool, shared configs                   |
| Platform thinking         | Internal tooling (config packages, CLI) that makes the right path easy |
| Technical strategy        | Vision doc with phased roadmap, non-goals, risks, evidence             |

## How to Explore

```bash
# Clone and setup
git clone <repo> && cd staff-flagsmith-lite
pnpm install

# Run everything
docker compose up -d db cache
pnpm --filter @project/api dev
pnpm --filter @project/api dev:worker

# Try it
pnpm cli health
curl http://localhost:3000/health
curl http://localhost:3000/api/v1/evaluate/dark-mode

# Read the key docs
cat docs/VISION.md           # Where the system is headed
cat docs/SLO.md              # What "good" looks like
cat docs/runbook.md           # How to operate it
cat docs/incidents/001-*.md   # How we handle failures
```
