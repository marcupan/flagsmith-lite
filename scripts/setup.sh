#!/bin/bash
set -euo pipefail

# ─── Developer setup for flagsmith-lite ────────────────────────────────
# Usage: ./scripts/setup.sh
#
# Brings the project from a fresh clone to a running state:
#   1. Checks prerequisites (Node, pnpm, Docker)
#   2. Installs dependencies
#   3. Creates .env from example if missing
#   4. Starts infrastructure (Postgres + Redis)
#   5. Runs database migrations
#
# After this script: run `pnpm dev` to start the API + web.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${GREEN}[✓]${NC} $*"; }
fail() { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }
step() { echo -e "\n${GREEN}=== [$1/5] $2 ===${NC}"; }

cd "${PROJECT_ROOT}"

echo "=== flagsmith-lite developer setup ==="

# ─── Step 1: Prerequisites ───────────────────────────────────────────
step 1 "Checking prerequisites"

command -v node >/dev/null || fail "Node.js not found. Install: https://nodejs.org"
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
[ "${NODE_VERSION}" -ge 22 ] || fail "Node.js 22+ required, found v${NODE_VERSION}"
info "Node.js $(node -v)"

command -v pnpm >/dev/null || fail "pnpm not found. Install: npm i -g pnpm"
info "pnpm $(pnpm -v)"

command -v docker >/dev/null || fail "Docker not found. Install: https://docker.com"
docker info >/dev/null 2>&1 || fail "Docker daemon not running. Start Docker Desktop."
info "Docker $(docker --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"

# ─── Step 2: Dependencies ───────────────────────────────────────────
step 2 "Installing dependencies"

pnpm install --frozen-lockfile
info "Dependencies installed"

# ─── Step 3: Environment ────────────────────────────────────────────
step 3 "Setting up environment"

if [ -f apps/api/.env ]; then
  info "apps/api/.env already exists (skipping)"
else
  cp apps/api/.env.example apps/api/.env
  info "Created apps/api/.env from .env.example"
fi

if [ -f .env ]; then
  info ".env already exists (skipping)"
else
  cp .env.example .env
  info "Created .env from .env.example"
fi

# ─── Step 4: Infrastructure ─────────────────────────────────────────
step 4 "Starting infrastructure (Postgres + Redis)"

docker compose up -d db cache

echo "  Waiting for Postgres to be ready..."
for i in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U flagr -d flagr >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker compose exec -T db pg_isready -U flagr -d flagr >/dev/null 2>&1 \
  || fail "Postgres failed to start within 30 seconds"

info "Postgres ready on port ${DB_PORT:-5433}"
info "Redis ready on port ${REDIS_PORT:-6379}"

# ─── Step 5: Migrations ─────────────────────────────────────────────
step 5 "Running database migrations"

pnpm --filter @project/api exec tsx --env-file apps/api/.env apps/api/migrate.ts
info "Migrations complete"

echo ""
echo -e "${GREEN}=== Setup complete! ===${NC}"
echo ""
echo "  Start development:"
echo "    pnpm dev                    # API (:3000) + Web (:5173)"
echo ""
echo "  Or start individually:"
echo "    pnpm --filter @project/api dev         # API only"
echo "    pnpm --filter @project/api dev:worker  # Webhook worker"
echo "    pnpm --filter @project/web dev         # Web only"
echo ""
echo "  Seed dev data:"
echo "    pnpm tsx scripts/seed.ts"
echo ""
echo "  Verify everything:"
echo "    pnpm verify"
