# RFC-001: Environment Model for Feature Flags

**Status:** Open
**Author:** marcupan
**Date:** 2026-03-22

---

## 1. Summary

flagsmith-lite flags are globally enabled or disabled — there is no way to test a flag in dev before enabling it in
production. This RFC proposes a per-environment override model so that each flag can have an independent state per
environment (dev, staging, production) while remaining backward-compatible with existing API clients and the SDK.

## 2. Motivation

**Current state:** A flag is a single row in the `flags` table with one `enabled` boolean. Toggling `dark-mode` to
`true` enables it everywhere — API consumers, the web dashboard, and SDK clients all see the same value.

**Problem scenario:**

1. Product asks to test `dark-mode` in dev before shipping to production.
2. Engineer toggles `dark-mode` → `true` for testing.
3. Production users immediately see `dark-mode` enabled.
4. Engineer panics, toggles back to `false`.
5. Dev testing is blocked because the flag cannot be on in dev and off in prod simultaneously.

**Workaround today:** Create separate flags (`dark-mode-dev`, `dark-mode-prod`). This breaks the conceptual link between
them — renaming, auditing, and cleanup become manual and error-prone.

**Goal:** A single flag `dark-mode` with independent values per environment.

## 3. Proposal

### 3.1 Data Model

```
┌────────────────────────┐       ┌─────────────────────────────────┐
│       flags            │       │       flag_overrides            │
├────────────────────────┤       ├─────────────────────────────────┤
│ id          SERIAL PK  │──┐    │ id            SERIAL PK         │
│ key         TEXT UQ    │  │    │ flag_id       INT FK → flags.id │
│ name        TEXT       │  └───>│ environment   TEXT              │
│ enabled     BOOLEAN    │       │ enabled       BOOLEAN           │
│ description TEXT       │       │ created_at    TIMESTAMPTZ       │
│ created_at  TIMESTAMPTZ│       │ updated_at    TIMESTAMPTZ       │
│ updated_at  TIMESTAMPTZ│       │                                 │
└────────────────────────┘       │ UQ(flag_id, environment)        │
                                 └─────────────────────────────────┘

Resolution order:
  1. Look up flag_overrides WHERE flag_id = ? AND environment = ?
  2. If override exists → use override.enabled
  3. If no override   → fall back to flags.enabled (global default)
```

### 3.2 Environment Definition

Environments are a predefined set stored as a TypeScript union and validated at the API layer — no separate
`environments` table.

```typescript
// packages/shared/index.ts
export const ENVIRONMENTS = ["dev", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
```

Rationale: flagsmith-lite is a learning project with a small, fixed set of environments. A dynamic `environments` table
adds CRUD endpoints, validation, and migration complexity with no current consumer. If user-created environments are
needed later, adding a table is an additive, non-breaking change.

### 3.3 SQL Migration

```sql
-- apps/api/drizzle/0001_add_flag_overrides.sql
CREATE TABLE IF NOT EXISTS "flag_overrides"
(
  "id"          serial PRIMARY KEY                     NOT NULL,
  "flag_id"     integer                                NOT NULL REFERENCES "flags" ("id") ON DELETE CASCADE,
  "environment" text                                   NOT NULL,
  "enabled"     boolean                                NOT NULL,
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"  timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "flag_overrides_flag_env_uq" UNIQUE ("flag_id", "environment")
);

CREATE INDEX "flag_overrides_lookup_idx"
  ON "flag_overrides" ("flag_id", "environment");
```

No changes to the existing `flags` table. Existing rows keep their `enabled` value as the global default.

### 3.4 Drizzle Schema Change

```typescript
// apps/api/src/schema.ts — addition
export const flagOverrides = pgTable(
  "flag_overrides",
  {
    id: serial("id").primaryKey(),
    flagId: integer("flag_id")
      .notNull()
      .references(() => flags.id, { onDelete: "cascade" }),
    environment: text("environment").notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    flagEnvUq: unique("flag_overrides_flag_env_uq").on(t.flagId, t.environment),
    lookupIdx: index("flag_overrides_lookup_idx").on(t.flagId, t.environment),
  }),
);
```

### 3.5 API Changes

**Evaluate endpoint** — `GET /api/v1/evaluate/:key`

```
GET /api/v1/evaluate/dark-mode              → uses "production" (default)
GET /api/v1/evaluate/dark-mode?env=dev      → uses "dev" override or global fallback
```

Resolution logic in `apps/api/src/routes/evaluate.ts`:

```typescript
const env: Environment = request.query.env ?? "production";

// 1. Check cache: key becomes flag:{env}:{flagKey}
const cacheKey = `flag:${env}:${flagKey}`;

// 2. If cache miss, query override
const override = await db.query.flagOverrides.findFirst({
  where: and(eq(flagOverrides.flagId, flag.id), eq(flagOverrides.environment, env)),
});

// 3. Resolve: override wins, else global default
const enabled = override ? override.enabled : flag.enabled;
```

Response gains an `environment` field:

```json
{
  "key": "dark-mode",
  "enabled": true,
  "evaluatedAt": "2026-03-22T10:00:00.000Z",
  "source": "database",
  "environment": "dev"
}
```

**Override management** — new endpoints under `/api/v1/flags/:key/overrides`:

| Method | Path                                | Action                       |
| ------ | ----------------------------------- | ---------------------------- |
| GET    | `/api/v1/flags/:key/overrides`      | List overrides for a flag    |
| PUT    | `/api/v1/flags/:key/overrides/:env` | Set override (upsert)        |
| DELETE | `/api/v1/flags/:key/overrides/:env` | Remove override (use global) |

### 3.6 Cache Evolution

| Current                      | Proposed                           |
| ---------------------------- | ---------------------------------- |
| `flag:{key}` → `"1"` / `"0"` | `flag:{env}:{key}` → `"1"` / `"0"` |

Cache invalidation on flag update:

- Update to `flags.enabled` (global) → invalidate `flag:*:{key}` (all environments)
- Update to `flag_overrides` → invalidate `flag:{env}:{key}` (single environment)

### 3.7 Shared Types Update

```typescript
// packages/shared/index.ts — additions
export const ENVIRONMENTS = ["dev", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

// EvaluateResponse gains optional environment field
export interface EvaluateResponse {
  key: FlagKey;
  enabled: boolean;
  evaluatedAt: Timestamp;
  source: "cache" | "database";
  environment?: Environment; // present when ?env= is provided
}
```

## 4. Alternatives Considered

| Approach                               | How                                                                      | Tradeoff                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: Separate flag per environment       | `dark-mode-dev`, `dark-mode-prod` as independent flags                   | Simplest — zero schema change. But no conceptual link between envs, cleanup is manual, reporting is fragmented.                                       |
| B: Environment as column on flags      | Add `environment TEXT` column to `flags`, one row per env                | Simple queries — `WHERE key = ? AND environment = ?`. But flag metadata (name, description) is duplicated per row. Renaming requires updating N rows. |
| **C: Separate `flag_overrides` table** | **`flags` (metadata) + `flag_overrides(flag_id, environment, enabled)`** | **Normalized — flag metadata lives once. Override is a small additive table. Cost: one JOIN (or two queries) per evaluate.**                          |

**Chosen: C.** The JOIN cost is negligible (~0.1 ms) and is eliminated by Redis cache on hot paths. Normalization
matters
more for data integrity when flags have many fields (name, description, future: tags, owner).

## 5. Migration / Rollout

### Phase 1: Schema only (non-breaking)

1. Add `flag_overrides` table via Drizzle migration.
2. No API changes yet. `GET /api/v1/evaluate/:key` continues to read from `flags.enabled`.
3. Deploy. Verify migration succeeds on Railway.

### Phase 2: API support (backward-compatible)

1. Add `?env=` query parameter to evaluate endpoint. Omitting it defaults to `"production"`.
2. Add `/api/v1/flags/:key/overrides` CRUD endpoints.
3. Update `EvaluateResponse` type with optional `environment` field.
4. SDK `isEnabled(key)` continues to work — no `env` parameter means production.
5. Deploy. Existing clients see no change.

### Phase 3: SDK + Dashboard

1. Add `isEnabled(key, env?)` optional parameter to `@project/sdk`.
2. Add environment selector to web dashboard.
3. Update cache keys from `flag:{key}` to `flag:{env}:{key}`.

**Rollback plan:** Drop `flag_overrides` table. Revert evaluate route to ignore `?env=`. No data loss — `flags` table is
unchanged.

## 6. Open Questions

1. **Should environments be predefined or user-created?** This RFC proposes a hardcoded
   `["dev", "staging", "production"]` union. If users need custom environments (e.g., "canary", "qa"), a dynamic
   `environments` table is needed. Defer decision until a real use case emerges.

2. **How to handle "flag exists in dev but not in prod"?** Current model: a flag either exists (in `flags` table) or it
   doesn't. An override in dev with no production override falls back to `flags.enabled`. But what if the flag should be
   invisible in production? This may require a `visibility` field or a `disabled_environments` list.

3. **Cache key migration — big bang or gradual?** Switching from `flag:{key}` to `flag:{env}:{key}` invalidates all
   cached entries. Options: (a) flush Redis on deployment, (b) read both key formats during a transition window, (c)
   accept
   cold cache for one TTL cycle (30s).

4. **Should overrides support typed values beyond boolean?** If Project 2 introduces string/JSON flag values,
   `flag_overrides.enabled` becomes insufficient. Consider `flag_overrides.value JSONB` from the start, or add it later
   as a separate migration.

---

**Files that will change:**

- `apps/api/src/schema.ts` — add `flagOverrides` table definition
- `apps/api/drizzle/0001_add_flag_overrides.sql` — new migration
- `apps/api/src/routes/evaluate.ts` — add `?env=` resolution logic, update cache keys
- `apps/api/src/routes/flags.ts` — add override sub-routes
- `packages/shared/index.ts` — add `Environment` type, update `EvaluateResponse`
- `packages/sdk/src/index.ts` — add optional `env` parameter to `isEnabled()` and `evaluate()`
- `apps/web/` — add environment selector (Phase 3)
