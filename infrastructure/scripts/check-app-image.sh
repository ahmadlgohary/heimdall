#!/usr/bin/env bash
# Checks a running production image (root Dockerfile): the API serves the web app.
#   ./infrastructure/scripts/check-app-image.sh http://localhost:8000
set -euo pipefail
BASE="${1:-http://localhost:8000}"
fail() { printf '\033[31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }
ok() { printf '  ok  %s\n' "$*"; }

for _ in $(seq 1 60); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "$BASE/health" | grep -q '"ok"' || fail "API not healthy at $BASE"
ok "/health"

index=$(curl -fsS -D /dev/stderr "$BASE/" 2>/tmp/check-app-headers)
grep -q '<div id="root">' <<<"$index" || fail "/ did not serve the web app"
grep -qi '^cache-control: no-cache' /tmp/check-app-headers || fail "index.html must not be cached"
ok "/ serves index.html (no-cache)"

for path in /dashboard /events/2b1f8f4e-1d1a-4a51-9c39-0b5f3c0d2f11 /settings/api-keys; do
  curl -fsS "$BASE$path" | grep -q '<div id="root">' || fail "$path did not serve the web app"
done
ok "client-side routes serve the app"

asset=$(grep -oE '/assets/[^"]+\.js' <<<"$index" | head -1)
[[ -n "$asset" ]] || fail "no script in index.html"
headers=$(curl -fsS -o /dev/null -D - -H 'Accept-Encoding: gzip' "$BASE$asset")
grep -qi 'cache-control: public, max-age=31536000, immutable' <<<"$headers" || fail "$asset not cached immutably"
grep -qi 'content-encoding: gzip' <<<"$headers" || fail "$asset not compressed"
ok "$asset cached for a year and gzipped"

[[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/assets/missing.js")" == 404 ]] || fail "missing asset should 404"
[[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/mockServiceWorker.js")" == 404 ]] || fail "dev-only file is served"
curl -s "$BASE/api/v1/nope" | grep -q '"NOT_FOUND"' || fail "unknown API path should be a JSON 404"
curl -fsS "$BASE/api/v1/demo" | grep -q '"enabled"' || fail "/api/v1/demo did not answer"
ok "API paths and missing files: JSON 404s; API answers"

jar=$(mktemp)
email="image-check-$RANDOM$RANDOM@example.com"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$email\",\"password\":\"Image-Check-Passw0rd\"}" "$BASE/api/v1/auth/register")" == 201 ]] \
  || fail "register failed"
[[ "$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" -X POST "$BASE/api/v1/auth/refresh")" == 200 ]] \
  || fail "same-origin session refresh failed"
rm -f "$jar"
ok "sign-up and session refresh work from the same origin"
printf '\033[32mProduction image serves the API and the web app.\033[0m\n'
