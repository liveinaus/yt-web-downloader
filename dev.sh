#!/usr/bin/env bash

# ── Configurable host / ports ─────────────────────────────────────────────────
BACKEND_HOST=${BACKEND_HOST:-localhost}
BACKEND_PORT=${BACKEND_PORT:-3033}
FRONTEND_HOST=${FRONTEND_HOST:-localhost}
FRONTEND_PORT=${FRONTEND_PORT:-54444}

# Services always bind to 0.0.0.0; BACKEND_HOST/FRONTEND_HOST are display/proxy names only
PROXY_HOST=127.0.0.1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── .env setup ────────────────────────────────────────────────────────────────
if [ ! -f server/.env ]; then
  cp server/env.example server/.env
  echo ""
  echo "Created server/.env from server/env.example."
  echo ""
fi

# The server refuses to boot on an empty or publicly-known JWT_SECRET, so
# generate a random one for local dev if the current value is missing/placeholder.
if ! grep -q "^JWT_SECRET=." server/.env 2>/dev/null \
   || grep -qE "^JWT_SECRET=(change-me-in-production|changeme|secret)$" server/.env 2>/dev/null; then
  SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  if grep -q "^JWT_SECRET=" server/.env 2>/dev/null; then
    sed "s|^JWT_SECRET=.*|JWT_SECRET=${SECRET}|" server/.env > server/.env.tmp && mv server/.env.tmp server/.env
  else
    printf 'JWT_SECRET=%s\n' "$SECRET" >> server/.env
  fi
  echo "Generated a random JWT_SECRET in server/.env for local development."
  echo ""
fi

if grep -q "^ADMIN_PASSWORD=changeme$" server/.env 2>/dev/null; then
  echo ""
  echo "NOTE: server/.env uses the default ADMIN_PASSWORD (changeme)."
  echo "      You'll be prompted to change it on first login; set a real one for deployment."
  echo ""
fi

# ── Dependencies ──────────────────────────────────────────────────────────────
echo "Installing dependencies..."
npm install --no-audit || true

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo ""
  echo "NOTE: yt-dlp was not found on PATH. Downloads will fail until it is"
  echo "      installed (https://github.com/yt-dlp/yt-dlp) or its path is set in Settings."
  echo ""
fi

# ── Cleanup on exit ───────────────────────────────────────────────────────────
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  echo ""
  echo "Stopping..."
  [ -n "$BACKEND_PID" ]  && kill "$BACKEND_PID"  2>/dev/null || true
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait
}
trap cleanup EXIT INT TERM

# ── Kill any existing processes on configured ports ───────────────────────────
kill_port() {
  local PORT=$1
  local PIDS
  PIDS=$(ss -tlnp "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+')
  [ -z "$PIDS" ] && return 0
  echo "Killing existing process(es) on port $PORT: $PIDS"
  kill -9 $PIDS 2>/dev/null || true
  sleep 0.5
}

for PORT in $BACKEND_PORT $FRONTEND_PORT; do
  kill_port "$PORT"
done

# ── Start services ────────────────────────────────────────────────────────────
echo ""
echo "  Backend:  http://${BACKEND_HOST}:${BACKEND_PORT}"
echo "  Frontend: http://${FRONTEND_HOST}:${FRONTEND_PORT}"
echo ""
echo "Press Ctrl+C to stop both."
echo ""

(PORT=$BACKEND_PORT npm run dev -w server) &
BACKEND_PID=$!

printf "Waiting for backend"
until (echo > /dev/tcp/127.0.0.1/$BACKEND_PORT) 2>/dev/null; do
  printf "."
  sleep 1
done
echo " ready"

(BACKEND_HOST=$PROXY_HOST BACKEND_PORT=$BACKEND_PORT npm run dev -w client -- --host 0.0.0.0 --port "$FRONTEND_PORT" --strictPort) &
FRONTEND_PID=$!

wait
