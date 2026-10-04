#!/bin/sh
# Run the server test suite locally against a throwaway Postgres, with coverage.
# The server runs inside the test process (--preload ./index.ts), so coverage
# includes server code. Nothing here touches any other container or database.
#
#   sh sandbox/tests/run-local.sh [name] [bun test args…]
#     name   prefix for the image/network/containers (default: wrencov), so several
#            runs can happen side by side
#   e.g.  sh sandbox/tests/run-local.sh wrencov tests/integration/events.test.ts
#
# Run from the sources root (the folder that holds sandbox/, db/, auth/ …). The image
# is rebuilt only when server code changes; tests/ is mounted, so editing tests needs
# no rebuild. Set REBUILD=1 to force a build. Port 4000 inside the container only.
set -e
NAME=${1:-wrencov}; [ $# -gt 0 ] && shift
IMG="wren:$NAME"
export MSYS_NO_PATHCONV=1
ROOT=$(pwd)
case "$ROOT" in /[a-zA-Z]/*) ROOT="$(echo "$ROOT" | cut -c2 | tr a-z A-Z):$(echo "$ROOT" | cut -c3-)";; esac

if [ -n "$REBUILD" ] || ! docker image inspect "$IMG" >/dev/null 2>&1; then
  docker build -q -f sandbox/Dockerfile -t "$IMG" . >/dev/null
fi
docker rm -f "$NAME-db" >/dev/null 2>&1 || true
docker network create "$NAME-net" >/dev/null 2>&1 || true
docker run -d --rm --name "$NAME-db" --network "$NAME-net" \
  -e POSTGRES_USER=wren -e POSTGRES_PASSWORD=wren -e POSTGRES_DB=wren postgres:17-alpine >/dev/null
for i in $(seq 1 30); do docker exec "$NAME-db" pg_isready -U wren >/dev/null 2>&1 && break; sleep 1; done; sleep 2

docker run --rm --network "$NAME-net" \
  -v "$ROOT/sandbox/tests:/app/tests" \
  -e DATABASE_URL="postgres://wren:wren@$NAME-db:5432/wren" \
  -e BETTER_AUTH_SECRET=test-secret-test-secret-test-secret \
  -e BETTER_AUTH_URL=http://localhost:4000 \
  -e CACHE_PURGE_BACKEND=noop \
  -e WREN_OPERATORS=ops@landing.test \
  -e WREN_WEBHOOK_ALLOW_HOSTS=localhost \
  -e WEBHOOK_BATCH_WINDOW_MS=500 \
  -w /app "$IMG" sh -c "bun test --coverage --preload ./index.ts ${*:-tests/integration} 2>&1" || STATUS=$?

docker rm -f "$NAME-db" >/dev/null 2>&1 || true
docker network rm "$NAME-net" >/dev/null 2>&1 || true
exit ${STATUS:-0}
