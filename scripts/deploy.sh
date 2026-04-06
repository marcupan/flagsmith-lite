#!/bin/bash
set -euo pipefail

# ─── Deploy script for flagsmith-lite ──────────────────────────────────
# Usage: ./scripts/deploy.sh <environment> <version>
#   environment: staging | production
#   version:     semver tag (e.g., v0.2.0) or git SHA
#
# This script:
#   1. Validates pre-deploy conditions (clean git, CI green, env valid)
#   2. Tags the deployment-study in git
#   3. Builds and tags a Docker image
#   4. Deploys via docker compose (local/staging) or Railway (production)
#   5. Runs post-deploy health check
#   6. Logs the deployment-study to deployments.log
#
# Rollback: ./scripts/rollback.sh <environment> <previous-version>

ENVIRONMENT=${1:?"Usage: deploy.sh <environment> <version>"}
VERSION=${2:?"Usage: deploy.sh <environment> <version>"}
TIMESTAMP=$(date -u +%Y%m%d%H%M%S)
GIT_SHA=$(git rev-parse --short HEAD)
DEPLOY_TAG="deploy-${ENVIRONMENT}-${TIMESTAMP}-${VERSION}"
IMAGE_TAG="flagsmith-lite:${VERSION}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPLOY_LOG="${PROJECT_ROOT}/deployments.log"

# ─── Colors ────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()  { echo -e "\n${GREEN}=== [$1/6] $2 ===${NC}"; }

# ─── Validation ────────────────────────────────────────────────────────
if [[ "${ENVIRONMENT}" != "staging" && "${ENVIRONMENT}" != "production" ]]; then
  error "Environment must be 'staging' or 'production', got '${ENVIRONMENT}'"
  exit 1
fi

# ─── Step 1: Pre-deploy checks ────────────────────────────────────────
step 1 "Pre-deploy checks"

# Check for uncommitted changes
if ! git diff --quiet HEAD 2>/dev/null; then
  error "Working tree has uncommitted changes. Commit or stash before deploying."
  exit 1
fi

# Check we're on main for production
if [[ "${ENVIRONMENT}" == "production" ]]; then
  CURRENT_BRANCH=$(git branch --show-current)
  if [[ "${CURRENT_BRANCH}" != "main" ]]; then
    error "Production deploys must be from 'main' branch, currently on '${CURRENT_BRANCH}'"
    exit 1
  fi
fi

# Verify local build passes
info "Running pnpm verify..."
if ! pnpm verify > /dev/null 2>&1; then
  error "pnpm verify failed. Fix issues before deploying."
  exit 1
fi
info "Pre-deploy checks passed"

# ─── Step 2: Tag deployment-study ───────────────────────────────────────────
step 2 "Tagging deployment"

git tag "${DEPLOY_TAG}"
info "Created git tag: ${DEPLOY_TAG}"

# ─── Step 3: Build Docker image ──────────────────────────────────────
step 3 "Building Docker image"

docker build \
  -f "${PROJECT_ROOT}/apps/api/Dockerfile" \
  -t "${IMAGE_TAG}" \
  -t "flagsmith-lite:latest" \
  "${PROJECT_ROOT}"

info "Built image: ${IMAGE_TAG}"

# ─── Step 4: Deploy ──────────────────────────────────────────────────
step 4 "Deploying to ${ENVIRONMENT}"

if [[ "${ENVIRONMENT}" == "staging" ]]; then
  # Local Docker Compose deploy (staging = local stack)
  cd "${PROJECT_ROOT}"

  # Export version for compose to use
  export IMAGE_TAG

  info "Restarting api and worker services..."
  docker compose up -d --no-deps api worker

  info "Deployed via Docker Compose"
elif [[ "${ENVIRONMENT}" == "production" ]]; then
  # Railway deploy (if configured)
  if command -v railway &> /dev/null; then
    info "Deploying to Railway..."
    railway up --detach
    info "Railway deploy initiated"
  else
    warn "Railway CLI not installed. Skipping remote deploy."
    warn "Install with: npm i -g @railway/cli"
    warn "Or deploy manually: push to main triggers Railway auto-deploy"
  fi
fi

# ─── Step 5: Post-deploy health check ────────────────────────────────
step 5 "Health check"

HEALTH_URL="http://localhost:3000/health"
HEALTHY=false

for i in $(seq 1 15); do
  if curl -sf "${HEALTH_URL}" > /dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  info "Waiting for health... (attempt ${i}/15)"
  sleep 2
done

if ${HEALTHY}; then
  info "Health check passed"
else
  error "Health check failed after 30s"
  error "Consider rolling back: ./scripts/rollback.sh ${ENVIRONMENT} <previous-version>"
  exit 1
fi

# ─── Step 6: Record deployment-study ───────────────────────────────────────
step 6 "Recording deployment"

# Create log file with header if it doesn't exist
if [[ ! -f "${DEPLOY_LOG}" ]]; then
  echo "# Deployment Log" > "${DEPLOY_LOG}"
  echo "# timestamp | environment | version | user | git-sha | status" >> "${DEPLOY_LOG}"
fi

echo "${TIMESTAMP} | ${ENVIRONMENT} | ${VERSION} | ${USER:-unknown} | ${GIT_SHA} | success" >> "${DEPLOY_LOG}"

info "Deployment recorded in deployments.log"

echo ""
echo -e "${GREEN}=== Deploy complete ===${NC}"
echo "  Environment: ${ENVIRONMENT}"
echo "  Version:     ${VERSION}"
echo "  Git SHA:     ${GIT_SHA}"
echo "  Git tag:     ${DEPLOY_TAG}"
echo "  Image:       ${IMAGE_TAG}"
echo ""
echo "  Rollback:    ./scripts/rollback.sh ${ENVIRONMENT} <previous-version>"
