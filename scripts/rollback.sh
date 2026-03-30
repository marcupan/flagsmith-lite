#!/bin/bash
set -euo pipefail

# ─── Rollback script for flagsmith-lite ────────────────────────────────
# Usage: ./scripts/rollback.sh <environment> <previous-version>
#   environment:      staging | production
#   previous-version: version tag to roll back to (e.g., v0.1.0)
#
# This script:
#   1. Confirms the rollback with the operator (interactive)
#   2. Verifies the target image exists locally
#   3. Redeploys the previous version
#   4. Runs post-rollback health check
#   5. Logs the rollback to deployments.log
#
# This is a MANUAL operation. Automated rollback would require:
#   - Health check thresholds (error rate > 5% for 2 min)
#   - Canary traffic shifting (not yet implemented)
#   - Automated alerting (Phase 3.2)

ENVIRONMENT=${1:?"Usage: rollback.sh <environment> <previous-version>"}
PREVIOUS_VERSION=${2:?"Usage: rollback.sh <environment> <previous-version>"}
TIMESTAMP=$(date -u +%Y%m%d%H%M%S)
GIT_SHA=$(git rev-parse --short HEAD)
IMAGE_TAG="flagsmith-lite:${PREVIOUS_VERSION}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPLOY_LOG="${PROJECT_ROOT}/deployments.log"

# ─── Colors ────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ─── Validation ────────────────────────────────────────────────────────
if [[ "${ENVIRONMENT}" != "staging" && "${ENVIRONMENT}" != "production" ]]; then
  error "Environment must be 'staging' or 'production', got '${ENVIRONMENT}'"
  exit 1
fi

# ─── Step 1: Confirmation ─────────────────────────────────────────────
echo ""
echo -e "${YELLOW}╔══════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║           ROLLBACK CONFIRMATION              ║${NC}"
echo -e "${YELLOW}╠══════════════════════════════════════════════╣${NC}"
echo -e "${YELLOW}║${NC}  Environment:  ${ENVIRONMENT}"
echo -e "${YELLOW}║${NC}  Rolling back to: ${PREVIOUS_VERSION}"
echo -e "${YELLOW}║${NC}  Image tag:   ${IMAGE_TAG}"
echo -e "${YELLOW}╚══════════════════════════════════════════════╝${NC}"
echo ""

# Non-interactive mode (for CI or piped input)
if [[ ! -t 0 ]]; then
  warn "Non-interactive mode detected. Use CONFIRM=yes to skip prompt."
  if [[ "${CONFIRM:-}" != "yes" ]]; then
    error "Rollback requires confirmation. Set CONFIRM=yes or run interactively."
    exit 1
  fi
else
  read -r -p "Type 'rollback' to confirm: " RESPONSE
  if [[ "${RESPONSE}" != "rollback" ]]; then
    info "Rollback cancelled."
    exit 0
  fi
fi

# ─── Step 2: Verify target image exists ───────────────────────────────
info "Checking for image ${IMAGE_TAG}..."

if ! docker image inspect "${IMAGE_TAG}" > /dev/null 2>&1; then
  error "Image '${IMAGE_TAG}' not found locally."
  error "Available images:"
  docker images flagsmith-lite --format "  {{.Tag}}" 2>/dev/null || true
  echo ""
  error "Either rebuild the image or choose a different version."
  exit 1
fi

info "Image found: ${IMAGE_TAG}"

# ─── Step 3: Redeploy previous version ───────────────────────────────
info "Rolling back ${ENVIRONMENT} to ${PREVIOUS_VERSION}..."

if [[ "${ENVIRONMENT}" == "staging" ]]; then
  cd "${PROJECT_ROOT}"

  # Tag the rollback target as latest so compose picks it up
  docker tag "${IMAGE_TAG}" "flagsmith-lite:latest"

  info "Restarting api and worker services with ${PREVIOUS_VERSION}..."
  docker compose up -d --no-deps api worker

  info "Docker Compose services restarted"
elif [[ "${ENVIRONMENT}" == "production" ]]; then
  if command -v railway &> /dev/null; then
    # Railway rollback: redeploy from the tagged commit
    DEPLOY_TAGS=$(git tag -l "deploy-production-*-${PREVIOUS_VERSION}" | tail -1)
    if [[ -n "${DEPLOY_TAGS}" ]]; then
      info "Found deploy tag: ${DEPLOY_TAGS}"
      info "Checking out tagged commit for Railway deploy..."
      git checkout "${DEPLOY_TAGS}" --detach
      railway up --detach
      git checkout -
      info "Railway rollback initiated"
    else
      warn "No deploy tag found for ${PREVIOUS_VERSION}."
      warn "Deploy manually via Railway dashboard."
    fi
  else
    warn "Railway CLI not installed. Roll back via Railway dashboard."
  fi
fi

# ─── Step 4: Post-rollback health check ──────────────────────────────
info "Running post-rollback health check..."

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
  info "Health check passed after rollback"
else
  error "Health check FAILED after rollback!"
  error "Manual intervention required. Check docker logs:"
  error "  docker compose logs api worker"
  exit 1
fi

# ─── Step 5: Record rollback ─────────────────────────────────────────
if [[ ! -f "${DEPLOY_LOG}" ]]; then
  echo "# Deployment Log" > "${DEPLOY_LOG}"
  echo "# timestamp | environment | version | user | git-sha | status" >> "${DEPLOY_LOG}"
fi

echo "${TIMESTAMP} | ${ENVIRONMENT} | ${PREVIOUS_VERSION} | ${USER:-unknown} | ${GIT_SHA} | rollback" >> "${DEPLOY_LOG}"

echo ""
echo -e "${GREEN}=== Rollback complete ===${NC}"
echo "  Environment:   ${ENVIRONMENT}"
echo "  Rolled back to: ${PREVIOUS_VERSION}"
echo "  Recorded in:   deployments.log"
