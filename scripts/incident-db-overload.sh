#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# INCIDENT SIMULATION: Database connection pool exhaustion (SEV2)
#
# Scenario: rapid flag toggles overwhelm DB while a long-running
# query (simulated migration) holds an exclusive lock on deliveries.
#
# Prerequisites:
#   docker compose up -d db cache
#   pnpm --filter @project/api dev        (terminal 1)
#   pnpm --filter @project/api dev:worker  (terminal 2)
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

BASE="${BASE_URL:-http://localhost:3000/api/v1}"
API_KEY="${API_KEY:-change-me-in-production}"
HEADERS=(-H "Content-Type: application/json" -H "X-Api-Key: $API_KEY")

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  INCIDENT SIMULATION: Database Overload (SEV2)"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo -e "${YELLOW}Scenario:${NC}"
echo "  1. 100 rapid flag toggles saturate the DB connection pool"
echo "  2. A long-running table lock simulates a slow migration"
echo "  3. API latency spikes, webhook deliveries stall"
echo ""

# ── Phase 1: Pre-flight check ───────────────────────────────────────────

echo -e "${GREEN}[Phase 1]${NC} Pre-flight check..."
if ! curl -sf "$BASE/../health" > /dev/null 2>&1; then
  echo -e "${RED}FAIL:${NC} API not reachable at $BASE/../health"
  echo "Start the API first: pnpm --filter @project/api dev"
  exit 1
fi
echo "  API is up."

# Record baseline metrics
echo "  Collecting baseline metrics..."
BASELINE_LATENCY=$(curl -sf "http://localhost:3000/metrics" 2>/dev/null | grep 'http_request_duration_seconds_count' | head -1 || echo "N/A")
echo "  Baseline request count: ${BASELINE_LATENCY:-none}"
echo ""

# ── Phase 2: Create test data ───────────────────────────────────────────

echo -e "${GREEN}[Phase 2]${NC} Creating test flags..."
for i in $(seq 0 9); do
  curl -sf -X POST "$BASE/flags" \
    "${HEADERS[@]}" \
    -d "{\"key\":\"incident-db-$i\",\"name\":\"Incident DB Test $i\"}" > /dev/null 2>&1 || true
done
echo "  Created 10 test flags (incident-db-0 through incident-db-9)"
echo ""

# ── Phase 3: Simulate database lock ─────────────────────────────────────

echo -e "${GREEN}[Phase 3]${NC} Simulating database lock (30-second exclusive lock)..."
echo "  This represents a slow migration or long-running admin query."
docker compose exec -T db psql -U app -d flagsmith -c "
  BEGIN;
  LOCK TABLE webhook_deliveries IN ACCESS EXCLUSIVE MODE NOWAIT;
  SELECT pg_sleep(30);
  COMMIT;
" > /dev/null 2>&1 &
LOCK_PID=$!
echo "  Lock process started (PID: $LOCK_PID)"
echo ""

# ── Phase 4: Flood with requests ────────────────────────────────────────

echo -e "${GREEN}[Phase 4]${NC} Firing 100 rapid flag toggles..."
echo "  (10 flags × 10 toggles each, all concurrent)"
START_TIME=$(date +%s)

for round in $(seq 1 10); do
  for i in $(seq 0 9); do
    enabled=$( [ $((round % 2)) -eq 0 ] && echo "true" || echo "false" )
    curl -sf -X PUT "$BASE/flags/incident-db-$i" \
      "${HEADERS[@]}" \
      -d "{\"enabled\":$enabled}" > /dev/null 2>&1 &
  done
done
wait

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
echo "  100 toggles fired in ${DURATION}s"
echo ""

# ── Phase 5: Observe ────────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════════════════"
echo -e "  ${RED}INCIDENT ACTIVE${NC} — Begin your investigation"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Your tasks:"
echo ""
echo "  1. DETECT: Check Grafana (http://localhost:3001) for latency spike"
echo "     → Look at: p95 Latency panel, Error Rate panel"
echo ""
echo "  2. TRIAGE: Run these commands:"
echo "     pnpm cli health"
echo "     pnpm cli metrics"
echo "     docker compose logs --tail=50 api"
echo ""
echo "  3. DIAGNOSE: Find the lock:"
echo "     docker compose exec db psql -U app -d flagsmith -c \\"
echo "       \"SELECT pid, query, state, wait_event_type FROM pg_stat_activity WHERE state != 'idle';\""
echo ""
echo "  4. MITIGATE: Kill the lock:"
echo "     docker compose exec db psql -U app -d flagsmith -c \\"
echo "       \"SELECT pg_terminate_backend(<pid>);\""
echo ""
echo "  5. VERIFY: Confirm recovery:"
echo "     pnpm cli health"
echo "     curl -w '\\nLatency: %{time_total}s\\n' $BASE/../health"
echo ""
echo "  6. POSTMORTEM: Document in docs/incidents/001-db-overload.md"
echo ""
echo -e "${YELLOW}Lock will auto-release in ~30 seconds if not killed manually.${NC}"
echo ""

# Wait for lock to finish
wait $LOCK_PID 2>/dev/null || true

echo -e "${GREEN}Lock released.${NC} Check if deliveries recovered."
echo ""

# ── Cleanup ─────────────────────────────────────────────────────────────

echo "To clean up test data:"
echo "  for i in \$(seq 0 9); do"
echo "    curl -sf -X DELETE \"$BASE/flags/incident-db-\$i\" ${HEADERS[*]} > /dev/null"
echo "  done"
