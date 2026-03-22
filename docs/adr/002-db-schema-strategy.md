# ADR-002: Database Schema Strategy

## Status

Accepted

## Context

flagsmith-lite stores feature flags. Initial scope: boolean kill-switches. Future: typed values and environments. Postgres + Drizzle ORM for schema and migrations.

## Options Considered

### Option A: Single `flags` table, boolean `enabled` only

Single table with `key`, `name`, `enabled`, `description`, timestamps. No value column, no environment column. Flags are either on or off.

- Pro: simplest schema, zero JOINs, evaluate is a single-row lookup (~0.1ms)
- Con: no typed values, no environments — requires migration to evolve

### Option B: Single `flags` table with `value` as JSONB

Same table but with `value JSONB` and `type TEXT` columns for storing arbitrary flag payloads.

- Pro: supports string/number/json flags from day one, still a single table
- Con: JSONB validation lives in application code, not DB constraints, adds complexity before any consumer of non-boolean flags exists

### Option C: `flags` + `flag_values` (one-to-many per environment)

Normalized schema with parent `flags` table and child `flag_values(flag_id, environment, enabled, value)`.

- Pro: environment-ready from day one, clean separation of metadata and values
- Con: every evaluated query requires a JOIN, schema over-engineered for single-environment boolean model

## Decision

Option A — boolean-only single table. The only confirmed consumer needs on/off switches. Adding JSONB or environments now adds complexity with zero benefit. Drizzle migrations make it safe to evolve the schema when requirements emerge.

## Consequences

- Simpler: trivial schema, fast queries, simple cache invalidation (`flag:{key}` → `"1"` or `"0"`)
- Harder: adding typed values requires a migration and API contract change
- Exit path: `ALTER TABLE flags ADD COLUMN value JSONB` + `ADD COLUMN type TEXT` — this is a non-breaking additive migration — existing boolean flags simply don't use the new columns

Reference: `apps/api/src/schema.ts`, `apps/api/drizzle/0000_initial.sql`

```sql
-- Actual initial migration:
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
