# ADR-001: API Style

## Status

Accepted

## Context

flagsmith-lite serves two audiences: admin UI (React, full CRUD) and SDK clients (read-only evaluate). ~7 endpoints, 1–2
engineers, shared TypeScript monorepo.

## Options Considered

### Option A: REST and manual shared types

Fastify routes with JSON Schema validation. Types defined once in `packages/shared/` and imported by both `apps/api` and
`apps/web`. No code generation step.

- Pro: zero build-time overhead, works with any HTTP client, Fastify JSON Schema provides runtime validation for free
- Con: types and validation can drift — changing Fastify schema does not auto-update TS interface

### Option B: tRPC

End-to-end type-safe RPC. Types inferred from router definition; no shared package needed.

- Pro: zero type drift by design, ~2KB client bundle
- Con: SDK consumers outside the monorepo cannot use tRPC types, evaluate endpoint requires a parallel REST route

### Option C: GraphQL

Schema-first API with codegen for TS types.

- Pro: flexible queries, rich ecosystem, introspection
- Con: overkill for 7 endpoints, adds ~40KB client bundle (Apollo) or codegen pipeline, query complexity not justified
  for a flat domain model

## Decision

Option A — REST with shared TypeScript types. Main reason: two distinct consumer types. Admin UI lives in the monorepo
and imports shared types directly. SDK clients are external HTTP consumers that need a simple REST contract. tRPC would
force maintaining a parallel REST layer for SDK, doubling the API surface.

## Consequences

- Simpler: any HTTP client works, SDK consumers need no framework dependencies, Fastify JSON Schema provides runtime
  validation
- Harder: type drift between shared interfaces and JSON Schema is possible — must catch via integration tests
- Exit path: if type drift becomes a problem, add OpenAPI spec generation from Fastify schemas (`@fastify/swagger`)
  without changing routes

Reference: `apps/api/src/routes/flags.ts`, `apps/api/src/index.ts:92-100`, `packages/shared/index.ts`
