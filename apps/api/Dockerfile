# syntax=docker/dockerfile:1.4

# ── Stage 1: Prune monorepo to only what @project/api needs ─────────────
FROM node:22-alpine AS pruner
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app
COPY . .
RUN pnpm dlx turbo prune @project/api --docker

# ── Stage 2: Install deps (only pruned subset) ──────────────────────────
FROM node:22-alpine AS installer
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app

# Copy pruned package.json files + lockfile for dependency install
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# Copy pruned source, root tsconfig (extends base), and build
COPY --from=pruner /app/out/full/ .
COPY --from=pruner /app/tsconfig.base.json .
RUN pnpm turbo build --filter=@project/api

# ── Stage 3: Production runner ──────────────────────────────────────────
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app
ENV NODE_ENV=production

# Copy only what's needed to run
COPY --from=installer /app/node_modules ./node_modules
COPY --from=installer /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=installer /app/apps/api/dist ./apps/api/dist
COPY --from=installer /app/apps/api/package.json ./apps/api/
COPY --from=installer /app/apps/api/drizzle ./apps/api/drizzle
COPY --from=installer /app/apps/api/migrate.ts ./apps/api/
COPY --from=installer /app/apps/api/src ./apps/api/src
COPY --from=installer /app/apps/api/tsconfig.json ./apps/api/
COPY --from=installer /app/packages/shared ./packages/shared
COPY --from=installer /app/package.json .
COPY --from=installer /app/pnpm-workspace.yaml .
COPY --from=installer /app/tsconfig.base.json .

EXPOSE 3000

# Run as non-root to limit blast radius if the process is compromised
RUN chown -R node:node /app
USER node

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Run migrations before starting the server, with retry for transient DNS/network
# failures that can occur on container startup (e.g., EAI_AGAIN on macOS Docker Desktop).
WORKDIR /app/apps/api
CMD ["sh", "-c", "i=1; until pnpm exec tsx migrate.ts; do if [ $i -ge 5 ]; then echo 'Migration failed after 5 attempts, exiting'; exit 1; fi; echo \"Migration attempt $i failed, retrying in 3s...\"; i=$((i+1)); sleep 3; done && pnpm exec tsx src/index.ts"]
