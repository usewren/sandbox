#!/bin/sh
# Run the wren.js browser tests in headless Chrome against a throwaway WREN server,
# then print JS coverage of wren.js. Nothing here touches any other container,
# database or port.
#
#   sh sandbox/tests/browser/run-local.sh [node --test args…]
#   e.g.  sh sandbox/tests/browser/run-local.sh --test-name-pattern="wren-doc"
#
# What it does:
#   1. builds the server image (sandbox/Dockerfile) if missing, or when REBUILD=1
#   2. starts Postgres + WREN as $NAME-db / $NAME-app on network $NAME-net, with this
#      working tree's adminui2/ and sandbox/public/wren.js mounted over the copies in the
#      image (UI edits need no rebuild), published on localhost:$PORT
#   3. runs *.test.mjs with node's test runner, then the coverage report
#   4. removes the containers and network (KEEP=1 leaves them running)
#
# Environment:
#   NAME=wrenD  PORT=4801   container prefix and host port
#   REBUILD=1               rebuild the image
#   KEEP=1                  keep the server running afterwards
#   WREN_URL=http://…       use an already running throwaway server instead (no Docker);
#                           (pages are hosted in a public tree of a fresh test org)
#   BUGS=1                  also run the skipped "BUG: …" tests (they fail until fixed)
#   CHROME_PATH=…           Chrome/Chromium executable
# Needs: Docker, Node 20+, Chrome. Run from anywhere.
set -e
TESTS=$(cd "$(dirname "$0")" && pwd)
SOURCES=$(cd "$TESTS/../../.." && pwd)
NAME=${NAME:-wrenD}
PORT=${PORT:-4801}
export MSYS_NO_PATHCONV=1

# Docker on Windows (Git Bash) wants W:/… instead of /w/… for paths
hostpath() { case "$1" in /[a-zA-Z]/*) echo "$(echo "$1" | cut -c2 | tr a-z A-Z):$(echo "$1" | cut -c3-)";; *) echo "$1";; esac; }

cleanup() {
  [ -n "$KEEP" ] && { echo "Server kept running at $WREN_URL ($NAME-app, $NAME-db, $NAME-net)"; return; }
  docker rm -fv "$NAME-app" "$NAME-db" >/dev/null 2>&1 || true
  docker network rm "$NAME-net" >/dev/null 2>&1 || true
}

if [ -z "$WREN_URL" ]; then
  case "$PORT" in 4000|5432) echo "Refusing port $PORT (reserved for the live instance)"; exit 1;; esac
  IMG="wren:$NAME"
  if [ -n "$REBUILD" ] || ! docker image inspect "$IMG" >/dev/null 2>&1; then
    echo "Building $IMG …"
    docker build -q -f "$(hostpath "$SOURCES/sandbox/Dockerfile")" -t "$IMG" "$(hostpath "$SOURCES")" >/dev/null
  fi
  trap cleanup EXIT
  docker rm -fv "$NAME-app" "$NAME-db" >/dev/null 2>&1 || true
  docker network create "$NAME-net" >/dev/null 2>&1 || true
  docker run -d --rm --name "$NAME-db" --network "$NAME-net" \
    -e POSTGRES_USER=wren -e POSTGRES_PASSWORD=wren -e POSTGRES_DB=wren postgres:17-alpine >/dev/null
  for i in $(seq 1 30); do docker exec "$NAME-db" pg_isready -U wren >/dev/null 2>&1 && break; sleep 1; done; sleep 2
  WREN_URL="http://localhost:$PORT"
  docker run -d --rm --name "$NAME-app" --network "$NAME-net" -p "$PORT:4000" \
    -v "$(hostpath "$SOURCES/adminui2"):/app/public/admin:ro" \
    -v "$(hostpath "$SOURCES/sandbox/public/wren.js"):/app/public/wren.js:ro" \
    -e DATABASE_URL="postgres://wren:wren@$NAME-db:5432/wren" \
    -e BETTER_AUTH_SECRET=test-secret-test-secret-test-secret \
    -e BETTER_AUTH_URL="$WREN_URL" \
    -e CACHE_PURGE_BACKEND=noop "$IMG" >/dev/null
  for i in $(seq 1 60); do curl -sf "$WREN_URL/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -sf "$WREN_URL/health" >/dev/null || { docker logs "$NAME-app" | tail -30; exit 1; }
  export WREN_DB_CONTAINER="$NAME-db"
fi
export WREN_URL

cd "$TESTS"
[ -d node_modules/puppeteer-core ] || npm ci --silent
rm -rf coverage/raw
FILES="*.test.mjs"
if [ -n "$BUGS" ]; then
  # Un-skipped copies of the files with BUG tests, running only those tests
  for f in $(grep -l 'test\.skip("BUG' *.test.mjs); do
    sed 's/test\.skip("BUG/test("BUG/' "$f" > "zz-bugs-$f"
  done
  FILES="zz-bugs-*.test.mjs"
  set -- --test-name-pattern="^BUG" "$@"
fi
STATUS=0
node --test --test-concurrency=2 "$@" "$FILES" || STATUS=$?
rm -f zz-bugs-*.test.mjs
node lib/coverage-report.mjs
[ -d coverage/screenshots ] && echo "Screenshots: $TESTS/coverage/screenshots"
exit $STATUS
