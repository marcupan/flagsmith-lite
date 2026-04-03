#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# INCIDENT SIMULATION: Webhook consumer outage (SEV3)
#
# Scenario: all registered webhook consumers become unreachable.
# Deliveries accumulate, circuit breaker opens, dead letters grow.
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
DIM='\033[2m'
NC='\033[0m'

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  INCIDENT SIMULATION: Consumer Outage (SEV3)"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo -e "${YELLOW}Scenario:${NC}"
echo "  1. Register subscription pointing to unreachable URL"
echo "  2. Toggle 20 flags to generate deliveries"
echo "  3. All deliveries fail → circuit breaker opens → dead letters"
echo ""

# ── Phase 1: Pre-flight check ───────────────────────────────────────────

echo -e "${GREEN}[Phase 1]${NC} Pre-flight check..."
if ! curl -sf "$BASE/../health" > /dev/null 2>&1; then
  echo -e "${RED}FAIL:${NC} API not reachable at $BASE/../health"
  echo "Start the API first: pnpm --filter @project/api dev"
  exit 1
fi
echo "  API is up."
echo ""

# ── Phase 2: Create test flags ──────────────────────────────────────────

echo -e "${GREEN}[Phase 2]${NC} Creating 20 test flags..."
for i in $(seq 0 19); do
  curl -sf -X POST "$BASE/flags" \
    "${HEADERS[@]}" \
    -d "{\"key\":\"incident-co-$i\",\"name\":\"Consumer Outage $i\"}" > /dev/null 2>&1 || true
done
echo "  Created 20 flags (incident-co-0 through incident-co-19)"
echo ""

# ── Phase 3: Register unreachable consumer ──────────────────────────────

echo -e "${GREEN}[Phase 3]${NC} Registering webhook subscription to unreachable URL..."
# Port 19899 has nothing listening — every delivery attempt will ECONNREFUSED
SUB_RESPONSE=$(curl -sf -X POST "$BASE/webhooks" \
  "${HEADERS[@]}" \
  -d '{"url":"http://localhost:19899/dead-consumer","events":["flag.toggled"],"secret":"incident-test-secret"}' 2>&1 || echo '{"id":"unknown"}')
SUB_ID=$(echo "$SUB_RESPONSE" | grep -o '"id":[0-9]*' | grep -o '[0-9]*' || echo "unknown")
echo "  Subscription ID: $SUB_ID → http://localhost:19899/dead-consumer"
echo ""

# ── Phase 4: Generate deliveries ────────────────────────────────────────

echo -e "${GREEN}[Phase 4]${NC} Toggling 20 flags to generate webhook deliveries..."
for i in $(seq 0 19); do
  curl -sf -X PUT "$BASE/flags/incident-co-$i" \
    "${HEADERS[@]}" \
    -d '{"enabled":true}' > /dev/null 2>&1 &
done
wait
echo "  20 flag toggles fired. Deliveries enqueued."
echo ""

# ── Phase 5: Observe ────────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════════════════"
echo -e "  ${RED}INCIDENT ACTIVE${NC} — Consumer is down, deliveries failing"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Your tasks:"
echo ""
echo "  1. DETECT: Watch the circuit breaker and queue depth"
echo "     pnpm cli metrics"
echo "     ${DIM}# Look for: webhook_queue_depth, circuit_breaker_state, webhook_deliveries_total{state=\"dead\"}${NC}"
echo ""
echo "  2. MONITOR: Watch delivery states over time"
echo "     docker compose exec db psql -U app -d flagsmith -c \\"
echo "       \"SELECT state, count(*) FROM webhook_deliveries GROUP BY state ORDER BY state;\""
echo ""
echo "  3. OBSERVE: Watch circuit breaker in logs"
echo "     docker compose logs --tail=100 api 2>&1 | grep -i circuit"
echo ""
echo "  4. WAIT: Let retries exhaust (~60s for all 5 attempts with backoff)"
echo "     ${DIM}# Watch dead letters accumulate${NC}"
echo ""
echo "  5. SIMULATE RECOVERY: Register a working consumer"
echo "     ${DIM}# Start a mock consumer on port 19899:${NC}"
echo "     node -e \"require('http').createServer((_,r)=>{r.writeHead(200);r.end('{\\\"ok\\\":true}')}).listen(19899)\""
echo ""
echo "  6. REPLAY: Replay dead deliveries via admin API"
echo "     ${DIM}# List dead deliveries:${NC}"
echo "     docker compose exec db psql -U app -d flagsmith -c \\"
echo "       \"SELECT id, flag_key, state, attempts FROM webhook_deliveries WHERE state = 'dead';\""
echo "     ${DIM}# Replay via API:${NC}"
echo "     curl -X POST \"$BASE/../admin/deliveries/<id>/replay\" ${HEADERS[*]}"
echo ""
echo "  7. POSTMORTEM: Document in docs/incidents/002-consumer-outage.md"
echo ""
echo -e "${YELLOW}Tip: Run 'pnpm cli metrics' every 30s to track delivery state changes.${NC}"
echo ""

# ── Cleanup instructions ────────────────────────────────────────────────

echo "To clean up test data after investigation:"
echo "  curl -sf -X DELETE \"$BASE/webhooks/$SUB_ID\" ${HEADERS[*]}"
echo "  for i in \$(seq 0 19); do"
echo "    curl -sf -X DELETE \"$BASE/flags/incident-co-\$i\" ${HEADERS[*]} > /dev/null"
echo "  done"
