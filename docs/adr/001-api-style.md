# ADR-001: Стиль API

## Status

Accepted

## Context

flagsmith-lite обслуговує дві аудиторії: admin UI (React, повний CRUD) та SDK clients (read-only evaluate). ~7 endpoints, 1-2 інженери, спільний TypeScript monorepo.

## Options Considered

### Option A: REST + manual shared types

Fastify routes з JSON Schema validation. Типи визначаються один раз у `packages/shared/` та імпортуються і в `apps/api`, і в `apps/web`. Без кроку code generation.

- Перевага: нульовий build-time overhead, працює з будь-яким HTTP client, Fastify JSON Schema дає runtime validation безкоштовно
- Недолік: типи і валідація можуть розходитись — зміна schema в Fastify не оновлює TS interface автоматично

### Option B: tRPC

End-to-end type-safe RPC. Типи виводяться з визначення router, shared package не потрібен.

- Перевага: нульовий type drift by design, ~2KB client bundle
- Недолік: SDK consumers поза monorepo не можуть використовувати tRPC types, evaluate endpoint потребує паралельний REST route

### Option C: GraphQL

Schema-first API з codegen для TS types.

- Перевага: гнучкі запити, потужна екосистема, introspection
- Недолік: надмірний для 7 endpoints, додає ~40KB client bundle (Apollo) або codegen pipeline, складність запитів не виправдана для плоскої доменної моделі

## Decision

Option A — REST зі спільними TypeScript types. Головна причина: два різних типи споживачів. Admin UI живе в monorepo і імпортує shared types напряму. SDK clients — це зовнішні HTTP consumers, яким потрібен простий REST contract. tRPC змусив би підтримувати паралельний REST layer для SDK, подвоюючи поверхню API.

## Consequences

- Простіше: будь-який HTTP client працює, SDK consumers не потребують framework dependencies, Fastify JSON Schema дає runtime validation
- Складніше: type drift між shared interfaces і JSON Schema можливий — треба ловити через integration tests
- Шлях виходу: якщо type drift стане проблемою, додати OpenAPI spec generation з Fastify schemas (`@fastify/swagger`) без зміни routes

Reference: `apps/api/src/routes/flags.ts`, `apps/api/src/index.ts:92-100`, `packages/shared/index.ts`
