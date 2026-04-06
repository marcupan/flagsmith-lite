# Technical Vision — flagsmith-lite

> Where we are, where we need to be, and how to get there.

## 1. Where We Are

### Current State

flagsmith-lite is a feature flag control plane with:

- **API:** Fastify 5 REST API — CRUD flags, evaluate, webhook subscriptions, admin endpoints
- **Webhooks:** Full delivery subsystem — queue, retry (5 attempts), circuit breaker, HMAC signing, dead-letter
- **Worker:** Poll-based webhook processor with structured logging and correlation ID propagation
- **Observability:** Prometheus metrics (8 custom + Node.js defaults), Grafana dashboard (10 panels), 6 alert rules
- **CI/CD:** GitHub Actions pipeline (5 stages), deploy/rollback shell scripts
- **DX tooling:** CLI with 5 commands, shared TypeScript/ESLint/Prettier configs, seed script, setup script
- **Reliability:** 2 incident simulations, 2 postmortems with 6 implemented action items
- **Testing:** Unit, integration, and E2E tests via Vitest; k6 load test
- **Documentation:** 5 ADRs, 1 RFC, runbook, SLO definitions, scope document, DX audit

### Strengths (with evidence)

1. **Evaluate hot path is fast:** p95 = 18ms at 100 VU (SLO target: 50ms). Redis cache hit rate >99% means SDK
   consumers get sub-5ms responses in the common case. _Source: load test report._

2. **Reliability patterns are production-grade:** State machine prevents impossible transitions, circuit breaker
   prevents cascade failure, dead-letter preserves failed deliveries for replay. All patterns were validated through
   incident simulations. _Source: incidents 001, 002._

3. **Developer experience is measured:** Setup time documented, seed data idempotent, CLI automates common tasks.
   New engineer can go from clone to running in <5 minutes. _Source: DX audit._

### Weaknesses (with evidence)

1. **Worker is the bottleneck:** Sequential processing limits webhook throughput. At 100 VU, queue depth reached ~150
   and delivery success dropped to 99.2% (below 99.5% SLO). _Source: load test report._

2. **No horizontal scaling path:** Single API process, single worker process. No service discovery, no load balancing
   configuration, no shared session state. _Source: architecture review._

3. **Secrets stored in plaintext:** Webhook subscription secrets are stored unencrypted in Postgres. Documented as
   accepted risk in SCOPE.md but unaddressed. _Source: SCOPE.md excluded features._

## 2. Where We Need to Be (6-Month Target)

### Target State

A **production-ready feature flag service** that can:

- Handle 500+ concurrent users with <100ms p95 latency across all endpoints
- Deliver webhooks within 2s of flag change at 99.9% success rate
- Scale horizontally (2+ API instances, concurrent workers)
- Recover from incidents automatically where possible
- Be operated by any engineer on the team, not just the creator

### Why

| Target                      | Business driver                                                   |
| --------------------------- | ----------------------------------------------------------------- |
| 500+ concurrent users       | Growth from internal tool to team-wide service                    |
| 99.9% delivery success      | Consumers depend on webhooks for cache invalidation, audit trails |
| Horizontal scaling          | Single-process architecture is a bus factor of 1 for uptime       |
| Auto-recovery               | Reduce MTTR from manual intervention (~5min) to self-heal (~30s)  |
| Operability by any engineer | Creator cannot be the only person who understands the system      |

## 3. How to Get There

### Phase 1 (Month 1-2): Worker Reliability

- Replace poll-based worker with pg-boss (queue with LISTEN/NOTIFY)
- Add worker concurrency (5 parallel delivery processors)
- Implement `FOR UPDATE SKIP LOCKED` for safe concurrent processing
- Add automatic dead-letter replay on circuit breaker close

**Unlocks:** Webhook delivery SLO compliance (99.5% → 99.9%). Removes the primary bottleneck identified in load tests.

### Phase 2 (Month 3-4): Horizontal Scaling

- Stateless API instances behind a load balancer (nginx/Caddy)
- Redis-based rate limiting (shared state across instances)
- Shared session/auth state via Redis (if needed)
- Health check–based routing (unhealthy instances auto-removed)
- Load test at 500 VU to validate scaling

**Unlocks:** Linear throughput scaling. Eliminates single-process as SPOF.

### Phase 3 (Month 5-6): Security and Operability

- Encrypt webhook secrets at rest (AES-256-GCM, key from env var)
- Secret rotation API (versioned secrets, accept old+new during transition)
- Self-service subscription management UI (React admin panel)
- Runbook automation: turn manual recovery steps into CLI commands
- On-call training documentation and handoff procedures

**Unlocks:** Secure by default. Operable by any team member. Ready for external consumers.

## 4. What We Will Not Do

| Non-goal                           | Why not                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Multi-tenant architecture          | Single-tenant covers all reliability patterns. Multi-tenancy adds isolation, billing, quota — orthogonal concerns.            |
| Kafka or distributed streaming     | pg-boss handles projected volume (10K deliveries/min). Kafka adds ZooKeeper/KRaft ops overhead for zero benefit at our scale. |
| Real-time WebSocket dashboard      | Admin API covers all debugging needs. A real-time UI adds 15h+ frontend work for an incident-time-only use case.              |
| GraphQL API                        | REST is sufficient for 7 endpoints. GraphQL adds schema management, query complexity limits, and client library requirements. |
| Inbound webhooks (event reception) | We only send outbound notifications. Inbound is a different auth + routing domain with no code overlap.                       |
| Mobile SDK                         | Web SDK (fetch-based) covers mobile via React Native. Native iOS/Android SDKs are a 40h+ investment per platform.             |

## 5. Risks and Open Questions

| Risk                                    | Impact                                 | Mitigation                                                              |
| --------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| pg-boss migration complexity            | Worker downtime during transition      | Feature flag the new worker; run both in parallel during migration      |
| Horizontal scaling reveals hidden state | Bugs from shared-nothing assumption    | Load test at 500 VU before declaring scaling complete                   |
| Secret encryption key management        | Key rotation failures = service outage | Start with env var, migrate to KMS only when multiple keys needed       |
| Postgres scaling limits                 | Connection pool exhaustion at 500+ VU  | Monitor pool metrics (added in Phase 3.5), consider PgBouncer if needed |
| Team knowledge concentration            | Creator leaving = knowledge loss       | Runbook + on-call docs + pair incident response sessions (Phase 3)      |

| Open question                               | Decision needed by |
| ------------------------------------------- | ------------------ |
| PgBouncer vs increasing Postgres pool size? | Phase 2 start      |
| Self-hosted vs managed Postgres?            | Phase 2 start      |
| Should secret encryption use KMS or env?    | Phase 3 start      |
| Who is the on-call escalation path?         | Phase 3 start      |
