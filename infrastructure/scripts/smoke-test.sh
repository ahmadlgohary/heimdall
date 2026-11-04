#!/usr/bin/env bash
# End-to-end check of a running docker compose stack (make smoke / CI):
#   frontend proxy -> API -> PostgreSQL + storage + outbox -> RabbitMQ -> worker -> receiver
# Exits non-zero on the first failure.
set -euo pipefail

# pick up port overrides from the repo's .env, like docker compose does
ENV_FILE="$(dirname "$0")/../../.env"
if [[ -f "$ENV_FILE" ]]; then
  for var in FRONTEND_PORT API_PORT MOCK_RECEIVER_PORT; do
    value=$(grep -E "^${var}=" "$ENV_FILE" | cut -d= -f2- || true)
    [[ -n "$value" && -z "${!var:-}" ]] && export "$var=$value"
  done
fi

FRONTEND="${FRONTEND_URL_SMOKE:-http://localhost:${FRONTEND_PORT:-8080}}"
API="${API_URL_SMOKE:-http://localhost:${API_PORT:-8000}}"
RECEIVER="${RECEIVER_URL_SMOKE:-http://localhost:${MOCK_RECEIVER_PORT:-9000}}"
TIMEOUT="${SMOKE_TIMEOUT:-90}"

step() { printf '\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

wait_for() { # wait_for <description> <command...>
  local what="$1"; shift
  local deadline=$((SECONDS + TIMEOUT))
  until "$@" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || fail "timed out waiting for $what"
    sleep 2
  done
}

ready() { curl -fsS "$API/ready" | jq -e '.status == "ready" and .checks.live_processes.worker >= 1 and .checks.live_processes.publisher >= 1'; }

step "Waiting for the stack (API ready, worker and publisher heartbeating)"
wait_for "API readiness" ready
wait_for "frontend" curl -fsS "$FRONTEND/"
wait_for "mock receiver" curl -fsS "$RECEIVER/requests"

step "Frontend serves the app and proxies /api"
curl -fsS "$FRONTEND/" | grep -q '<div id="root">' || fail "frontend did not serve index.html"
code=$(curl -s -o /dev/null -w '%{http_code}' "$FRONTEND/api/v1/auth/me")
[[ "$code" == "401" ]] || fail "expected 401 from proxied /api/v1/auth/me, got $code"

step "Registering a user through the frontend proxy"
email="smoke-$(date +%s)-$RANDOM@example.com"
token=$(curl -fsS -X POST "$FRONTEND/api/v1/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$email\",\"password\":\"SmokeTest-Passw0rd\"}" | jq -er .access_token)
auth=(-H "Authorization: Bearer $token")

step "Creating an endpoint that points at the mock receiver"
endpoint=$(curl -fsS -X POST "$API/api/v1/endpoints" "${auth[@]}" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke test","url":"http://mock-receiver:9000/hooks/ok"}')
endpoint_id=$(jq -er .id <<<"$endpoint")
jq -e '.signing_secret | startswith("whsec_")' <<<"$endpoint" >/dev/null || fail "no signing secret returned"

step "Creating an API key"
api_key=$(curl -fsS -X POST "$API/api/v1/api-keys" "${auth[@]}" -H 'Content-Type: application/json' \
  -d '{"name":"smoke"}' | jq -er .key)

step "Ingesting an event"
resp=$(curl -fsS -w '\n%{http_code}' -X POST "$API/api/v1/ingest/$endpoint_id" \
  -H "Authorization: Bearer $api_key" -H 'Content-Type: application/json' -H "Idempotency-Key: smoke-$RANDOM" \
  -d '{"event_type":"order.created","data":{"order_id":"ORD-1001","amount":129.99}}')
[[ "$(tail -n1 <<<"$resp")" == "202" ]] || fail "ingest did not return 202: $resp"
event_id=$(head -n1 <<<"$resp" | jq -er .event_id)

step "Waiting for delivery (outbox -> RabbitMQ -> worker -> receiver)"
delivered() { curl -fsS "$API/api/v1/events/$event_id" "${auth[@]}" | jq -e '.status == "delivered"'; }
wait_for "event $event_id to be delivered" delivered

step "Checking the receiver got one signed request"
curl -fsS "$RECEIVER/requests" | jq -e --arg id "$event_id" \
  '[.[] | select(.event_id == $id)] | length == 1 and .[0].signature_present and .[0].attempt == "1"' >/dev/null \
  || fail "receiver did not record a signed delivery for $event_id"

step "Checking the attempt and stored payload through the API"
curl -fsS "$API/api/v1/events/$event_id/payload" "${auth[@]}" | jq -e --arg id "$event_id" \
  '.id == $id and .data.order_id == "ORD-1001"' >/dev/null || fail "payload mismatch"
curl -fsS "$API/api/v1/dashboard/stats?range=24h" "${auth[@]}" | jq -e '.successful_deliveries == 1' >/dev/null \
  || fail "dashboard stats did not count the delivery"

printf '\033[32mSmoke test passed: event %s delivered end to end.\033[0m\n' "$event_id"
