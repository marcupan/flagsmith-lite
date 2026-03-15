# syntax=docker/dockerfile:1.4

# ── deps stage: install all workspace dependencies ──────────────────────────
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

# Frozen lockfile ensures reproducible installs
RUN pnpm install --frozen-lockfile

# ── runner stage: lean image without build tools ─────────────────────────────
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app

# Copy installed packages from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules

# Copy source (tsx runs TypeScript directly; a compiled-JS stage is the next
# improvement — see docs/staff-playbook/10-repo-improvements.uk.md)
COPY packages/shared ./packages/shared
COPY apps/api/src ./apps/api/src
COPY apps/api/drizzle ./apps/api/drizzle
COPY apps/api/migrate.ts ./apps/api/migrate.ts
COPY apps/api/package.json ./apps/api/package.json

ENV NODE_ENV=production
EXPOSE 3000

# Run migrations before starting the server, with retry for transient DNS/network
# failures that can occur on container startup (e.g., EAI_AGAIN on macOS Docker Desktop).
CMD ["sh", "-c", "i=1; until pnpm --filter @project/api migrate; do if [ $i -ge 5 ]; then echo 'Migration failed after 5 attempts, exiting'; exit 1; fi; echo \"Migration attempt $i failed, retrying in 3s...\"; i=$((i+1)); sleep 3; done && pnpm --filter @project/api start"]
