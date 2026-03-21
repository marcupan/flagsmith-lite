# ADR-002: Стратегія Database Schema

## Status

Accepted

## Context

flagsmith-lite зберігає feature flags. Початковий scope: boolean kill-switches. Майбутнє: typed values та environments. Postgres + Drizzle ORM для schema та migrations.

## Options Considered

### Option A: Одна таблиця `flags`, тільки boolean `enabled`

Одна таблиця з `key`, `name`, `enabled`, `description`, timestamps. Без колонки value, без колонки environment. Flags або увімкнені, або ні.

- Перевага: найпростіша schema, нуль JOINs, evaluate — це single-row lookup (~0.1ms)
- Недолік: без typed values, без environments — потребує migration для еволюції

### Option B: Одна таблиця `flags` з `value` як JSONB

Та сама таблиця, але з колонками `value JSONB` і `type TEXT` для зберігання довільних flag payloads.

- Перевага: підтримує string/number/json flags з першого дня, все ще одна таблиця
- Недолік: JSONB validation живе в application code, а не в DB constraints, додає складність до появи споживача non-boolean flags

### Option C: `flags` + `flag_values` (one-to-many per environment)

Нормалізована schema з батьківською таблицею `flags` і дочірньою `flag_values(flag_id, environment, enabled, value)`.

- Перевага: готова до environments з першого дня, чисте розділення metadata і values
- Недолік: кожен evaluate query потребує JOIN, schema надмірно спроектована для single-environment boolean моделі

## Decision

Option A — boolean-only single table. Єдиний підтверджений споживач потребує on/off switches. Додавання JSONB або environments зараз додає складність з нульовою користю. Drizzle migrations роблять безпечною еволюцію schema, коли з'являться вимоги.

## Consequences

- Простіше: тривіальна schema, швидкі запити, просте cache invalidation (`flag:{key}` → `"1"` або `"0"`)
- Складніше: додавання typed values потребує migration та зміни API contract
- Шлях виходу: `ALTER TABLE flags ADD COLUMN value JSONB` + `ADD COLUMN type TEXT` — це non-breaking additive migration — існуючі boolean flags просто не використовують нові колонки

Reference: `apps/api/src/schema.ts`, `apps/api/drizzle/0000_initial.sql`

```sql
-- Фактична початкова migration:
CREATE TABLE IF NOT EXISTS "flags" (
  "id" serial PRIMARY KEY NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flags_key_unique" UNIQUE("key")
);
```
