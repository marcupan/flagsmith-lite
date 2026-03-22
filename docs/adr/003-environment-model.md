# ADR-003: Environment Model

## Status

Proposed

## Context

flagsmith-lite flags have a single global `enabled` boolean. There is no way to enable a flag in dev while keeping it
disabled in production. [RFC-001](../rfcs/RFC-001-environment-model.md) explored three approaches to add per-environment
flag state.

## Options Considered

- **A: Separate flag per environment** — `dark-mode-dev`, `dark-mode-prod` as independent rows. Zero schema change, but
  no conceptual link between environments.
- **B: Environment as column on flags** — one row per (key, environment) pair. Simple queries, but duplicates flag
  metadata (name, description) across rows.
- **C: Separate `flag_overrides` table** — normalized join table `flag_overrides(flag_id, environment, enabled)`. One
  extra query per evaluate, eliminated by Redis cache.

## Decision

**Option C — separate `flag_overrides` table.** Flag metadata lives once in `flags`. Per-environment state is an
additive override. The JOIN cost is negligible (~0.1 ms) and cached by Redis on hot paths.

Backward compatibility: `GET /api/v1/evaluate/:key` without `?env=` defaults to production. Existing SDK clients (
`isEnabled(key)`) continue working unchanged.

## Deferred to Project 2/3

The following is out of scope for Project 1:

- Dynamic user-created environments (hardcoded `dev | staging | production` for now)
- Typed flag values (JSONB overrides)
- Environment-aware web dashboard
- Percentage-based rollouts per environment

## Consequences

- **Additive migration** — existing `flags` table unchanged, new `flag_overrides` table added
- **Cache key change** — `flag:{key}` becomes `flag:{env}:{key}`, requires one-time cache flush on deployment
- **Exit path** — drop `flag_overrides` table and revert evaluate route; `flags` data is untouched

## References

- [RFC-001: Environment Model](../rfcs/RFC-001-environment-model.md)
- `apps/api/src/schema.ts` — current schema
- `apps/api/src/routes/evaluate.ts` — evaluate resolution logic
- `packages/shared/index.ts` — shared type contracts
