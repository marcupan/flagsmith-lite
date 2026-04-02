# DX Audit — 2026-04-01

## Measurements

| Action                                 | Time          | Target | Status                |
| -------------------------------------- | ------------- | ------ | --------------------- |
| `pnpm install` (cached)                | 0.5s          | < 5s   | PASS                  |
| `pnpm install` (cold, no cache)        | ~15s          | < 30s  | PASS                  |
| `turbo build` (cold, 1 uncached)       | 3.1s          | < 30s  | PASS                  |
| `turbo build` (full cache)             | 0.4s          | < 3s   | PASS                  |
| `pnpm --filter @project/api test:unit` | 1.6s          | < 10s  | PASS                  |
| `pnpm --filter @project/shared test`   | ~1.5s         | < 10s  | PASS                  |
| `pnpm verify` (full pipeline)          | ~8s           | < 30s  | PASS                  |
| Fresh clone → running app              | ~45s (manual) | < 120s | PASS (with setup.sh)  |
| Save file → vitest watch result        | ~1s           | < 2s   | PASS                  |
| Toggle flag → see webhook delivery     | 2-4s          | < 5s   | PASS (worker poll 2s) |

## Friction Points Found

### 1. No one-command setup from fresh clone

**Impact:** Every new developer (or returning after a break) must manually:

1. `pnpm install`
2. Copy `.env.example` to `.env`
3. `docker compose up -d db cache`
4. Wait for Postgres healthy
5. Run migrations
6. Start the dev server

Six steps where one should suffice. Getting any step wrong wastes 5-10 minutes debugging.

**Fix:** Create `scripts/setup.sh` that does all 6 steps.

### 2. No seed data for development

**Impact:** After setup, the database is empty. To test webhooks, a developer must manually:

1. Create a flag (POST /flags)
2. Create a subscription (POST /webhooks)
3. Toggle the flag (PUT /flags/:key)

This is 3 curl commands that every developer repeats every time they reset the database.

**Fix:** Create `scripts/seed.ts` that populates dev data.

### 3. Worker has no watch mode

**Impact:** When editing `delivery-service.ts` or `worker.ts`, changes require manually
restarting the worker process. Developers forget and wonder why their changes aren't taking
effect.

**Fix:** Add `dev:worker` script with `tsx watch`.

### 4. No clear "what's running" status command

**Impact:** After setup, developers wonder: "Is Postgres running? Is the worker running?
Did migrations run?" No single command answers all three.

**Fix:** Enhance `pnpm doctor` to check runtime services (Postgres connectivity, worker
process, migration state).

### 5. `docs:check-links` fails on cross-project references in `docs/plan/`

**Impact:** `pnpm verify` fails due to links to sibling projects (`../../python/...`) that
only exist in the parent monorepo. This is not a real broken link but blocks CI.

**Fix:** Exclude `docs/plan/` from link checking, or make the link checker aware of
cross-project boundaries.

## Top-3 Improvements (by impact)

1. **`scripts/setup.sh`** — Eliminates 6 manual steps for every fresh clone. Impact: saves
   5-10 minutes per setup × every developer × every DB reset. Highest frequency friction
   point.

2. **`scripts/seed.ts`** — Eliminates 3 manual curl commands after every DB reset. Impact:
   saves 2-3 minutes × every DB reset. Second most frequent friction point.

3. **`dev:worker` watch mode** — Eliminates manual worker restart during delivery-service
   development. Impact: saves 10-30 seconds × every code change to delivery logic.

## Measurements After Fixes

| Action                              | Before                   | After                    | Improvement             |
| ----------------------------------- | ------------------------ | ------------------------ | ----------------------- |
| Fresh clone → running app           | ~45s + 6 manual steps    | ~45s + 0 manual steps    | 100% fewer manual steps |
| Empty DB → testable state           | ~2 min (3 curl commands) | ~3s (one script)         | 97% faster              |
| Worker code change → effect visible | ~15s (restart manually)  | ~1s (watch auto-restart) | 93% faster              |
