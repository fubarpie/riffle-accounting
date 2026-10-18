#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Smoke test: start the full compose stack from a given image and verify it.
#
#   scripts/smoke.sh <image-reference>
#
# Used by CI against the freshly built image, and usable locally.
set -euo pipefail

IMAGE="${1:?usage: scripts/smoke.sh <image-reference>}"
PORT="${RIFFLE_PORT:-38080}"
PROJECT="riffle-smoke-$$"

export RIFFLE_IMAGE="$IMAGE"
export RIFFLE_PORT="$PORT"
POSTGRES_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
export POSTGRES_PASSWORD

compose() { docker compose -p "$PROJECT" -f docker-compose.yml "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "::group::compose logs (smoke test failed)"
    compose logs --no-color --tail=200 || true
    echo "::endgroup::"
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

echo "Starting stack with image: $IMAGE"
# --wait blocks until every service with a healthcheck reports healthy.
compose up -d --wait --wait-timeout 120

echo "Checking API health..."
body="$(curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${PORT}/healthz")"
echo "  $body"
echo "$body" | grep -q '"status":"ok"' || { echo "unexpected /healthz body" >&2; exit 1; }
echo "$body" | grep -q '"service":"riffle-api"' || { echo "wrong service name" >&2; exit 1; }

echo "Checking web UI is served..."
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${PORT}/" | grep -qi "<title>Riffle</title>" \
  || { echo "web UI not served at /" >&2; exit 1; }

echo "Checking SPA fallback..."
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${PORT}/some/client/route" | grep -qi "<title>Riffle</title>" \
  || { echo "SPA fallback failed" >&2; exit 1; }

echo "Checking worker health (via container healthcheck)..."
worker_id="$(compose ps -q worker)"
worker_state="$(docker inspect --format '{{.State.Health.Status}}' "$worker_id")"
[ "$worker_state" = "healthy" ] || { echo "worker is $worker_state" >&2; exit 1; }

echo "Checking containers run as non-root..."
api_user="$(compose exec -T api id -u)"
[ "$api_user" != "0" ] || { echo "api runs as root" >&2; exit 1; }

echo "Smoke test passed."
