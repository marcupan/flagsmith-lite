# Merge Checklist

Before merging to main, verify every item. CI catches the automated checks — the
manual items require human judgment.

## Automated (CI must pass)

- [ ] Format check passes (`pnpm format:check`)
- [ ] Lint passes (`pnpm lint`)
- [ ] TypeScript compiles (`pnpm typecheck`)
- [ ] Unit tests pass (shared + sdk + api)
- [ ] Integration tests pass (api with Postgres)
- [ ] E2E tests pass
- [ ] Build succeeds (`pnpm build`)
- [ ] Docs link check passes (`pnpm docs:check-links`)
- [ ] Docker smoke test passes (health + flag CRUD)

## Manual — Code Quality

- [ ] PR description follows template (what / why / how / test plan / risk)
- [ ] ADR written if an architectural decision was made
- [ ] No TODO without a linked issue or documented plan
- [ ] No `console.log` left in production code (use Fastify logger)
- [ ] Error handling uses `AppError` pattern, not raw throws
- [ ] New functions have JSDoc for non-obvious parameters

## Manual — Data and API

- [ ] DB migration is additive (new columns nullable or have defaults)
- [ ] DB migration has been tested: `drizzle-kit generate` + `tsx migrate.ts`
- [ ] No breaking changes to existing API endpoints
- [ ] New API endpoints documented in `docs/API.md`
- [ ] New env vars documented in `.env.example` and `docs/ONBOARDING.md`
- [ ] Webhook payload changes are backward-compatible

## Manual — Webhook Delivery

- [ ] Delivery state transitions follow the state machine (no illegal jumps)
- [ ] New delivery-related code tested with simulation script
- [ ] Circuit breaker behavior verified for failure cases
- [ ] Audit trail (transitions table) updated for new state changes

## Manual — Security

- [ ] No secrets in code, logs, or error messages
- [ ] Webhook secrets never returned in API responses
- [ ] New endpoints have appropriate auth (API key required)
- [ ] No user input used in SQL without parameterized queries (Drizzle handles this)

## Branch Protection Rules (GitHub Settings)

Configure on the `main` branch:

- **Require pull request** — no direct push to main
- **Require CI to pass** — `quality`, `test-unit`, `test-integration`, `build` jobs
- **Require branch to be up-to-date** — merge conflicts caught before merge
- **Require 1 approval** — in team environments (solo: self-review via SELF-REVIEW.md)
- **No force push** — protect commit history
- **No branch deletion** — main is permanent

## Post-Merge

- [ ] Monitor CI on main — the merge commit must also pass
- [ ] If deploying: run `./scripts/deploy.sh staging <version>` first
- [ ] Verify staging health before promoting to production
- [ ] Update `deployments.log` via deploy script (automatic)
