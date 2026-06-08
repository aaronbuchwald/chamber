#!/usr/bin/env bash
#
# Bring up the whole Chamber MCP stack behind one agentgateway endpoint:
#   - nutrition / notes / todo HTTP APIs (ports 8080 / 8081 / 8082)
#   - agentgateway federating all of them + the Obsidian MCP server on :3000/mcp
#
# Usage:   ./start.sh                 (re-running is safe; it restarts cleanly, in the foreground)
#          ./start.sh --bg            (start/restart the whole stack detached in the background)
#          ./start.sh --app nutrition (bounce just one app server; leaves the gateway/MCP running)
#          ./start.sh --stop          (stop everything)
#
# Prereqs:
#   - .env present with OBSIDIAN_API_KEY (copy from .env.example)
#   - Node 22 available (better-sqlite3's native module is built for it)
#   - agentgateway binary at /tmp/agentgateway (or set AGENTGATEWAY_BIN)
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORTS="3000,8080,8081,8082"

stop_all() {
  # IMPORTANT: -sTCP:LISTEN restricts the match to *listening* (server) sockets. Without it,
  # `lsof -ti:PORT` also returns CLIENTS with an established connection to that port — including
  # the agent/editor connected to the MCP gateway on :3000 — and `kill` would take them down too.
  # shellcheck disable=SC2046
  lsof -ti:"$PORTS" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
}

# Launch one app's HTTP server detached (own log; nohup'd so it survives this script exiting).
start_app() { # $1=name  $2=port
  ( cd "apps/$1" && PORT="$2" nohup node node_modules/.bin/tsx src/http.ts >"/tmp/chamber-$1.log" 2>&1 & )
}

# Wait until $1 ("free"|"up") for a given port. Condition-based, so it's as fast as the server is.
wait_port_free() { for _ in $(seq 1 50); do lsof -ti:"$1" -sTCP:LISTEN >/dev/null 2>&1 || return 0; sleep 0.1; done; }
wait_port_up()   { for _ in $(seq 1 80); do curl -sf "localhost:$1/" >/dev/null 2>&1 && return 0; sleep 0.1; done; }

if [[ "${1:-}" == "--stop" ]]; then
  stop_all
  echo "Stopped all Chamber services (ports $PORTS)."
  exit 0
fi

# --- background mode: re-exec this script fully detached, then return immediately ----
# Detaches into its own process group with no inherited fds, so it survives the caller
# exiting (terminal, CI step, or an agent's tool call) without taking anything down with it.
if [[ "${1:-}" == "--bg" ]]; then
  nohup "$0" "${@:2}" >/tmp/chamber-start.log 2>&1 </dev/null &
  disown 2>/dev/null || true
  echo "Chamber starting in the background (pid $!). Logs: /tmp/chamber-start.log"
  echo "Tail with:  tail -f /tmp/chamber-start.log"
  exit 0
fi

# --- load secrets/config from .env (gitignored) -----------------------------
if [[ -f .env ]]; then
  set -a; source ./.env; set +a
else
  echo "WARNING: no .env found — copy .env.example to .env and set OBSIDIAN_API_KEY." >&2
fi

# --- pin Node 22 via nvm if available (better-sqlite3 ABI) -------------------
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi
echo "Using node $(node -v)"
case "$(node -v)" in
  v22.*) ;;
  *) echo "WARNING: Node 22 expected (got $(node -v)); nutrition's better-sqlite3 may fail to load." >&2 ;;
esac

# --- single-app restart: bounce one app server only, leaving the gateway (and the live MCP
# --- connection on :3000) untouched. For UI/behavior changes that don't alter tool *schemas*;
# --- schema changes still need a full restart so the gateway re-reads each app's OpenAPI.
if [[ "${1:-}" == "--app" ]]; then
  case "${2:-}" in
    nutrition) APP_PORT=8080 ;;
    notes)     APP_PORT=8081 ;;
    todo)      APP_PORT=8082 ;;
    *) echo "usage: ./start.sh --app {nutrition|notes|todo}" >&2; exit 1 ;;
  esac
  lsof -ti:"$APP_PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  wait_port_free "$APP_PORT"
  start_app "$2" "$APP_PORT"
  wait_port_up "$APP_PORT"
  echo "Restarted $2 on :$APP_PORT (gateway/MCP on :3000 left running)."
  exit 0
fi

GW="${AGENTGATEWAY_BIN:-/tmp/agentgateway}"
if [[ ! -x "$GW" ]]; then
  echo "ERROR: agentgateway binary not found/executable at $GW (set AGENTGATEWAY_BIN)." >&2
  exit 1
fi

# --- restart cleanly ---------------------------------------------------------
stop_all
wait_port_free "$PORTS"   # proceed the instant the ports release (no fixed sleep)

# --- start the three app HTTP APIs -------------------------------------------
start_app nutrition 8080
start_app notes     8081
start_app todo      8082

# --- wait for health, then snapshot each OpenAPI spec the gateway reads -------
for p in 8080 8081 8082; do wait_port_up "$p"; done
curl -s localhost:8080/openapi.json > apps/nutrition/openapi.json
curl -s localhost:8081/openapi.json > apps/notes/openapi.json
curl -s localhost:8082/openapi.json > apps/todo/openapi.json

# --- start the gateway (inherits OBSIDIAN_API_KEY from this shell's env) ------
if [[ -z "${OBSIDIAN_API_KEY:-}" ]]; then
  echo "WARNING: OBSIDIAN_API_KEY not set — the obsidian_* tools will fail until it is." >&2
fi
nohup "$GW" -f agentgateway-all.yaml >/tmp/chamber-gateway.log 2>&1 &
for _ in $(seq 1 80); do curl -s -o /dev/null "localhost:3000/" 2>/dev/null && break; sleep 0.1; done

echo
echo "Chamber is up. MCP endpoint:  http://localhost:3000/mcp"
echo "Nutrition UI:  http://localhost:8080/"
echo "Backends:  nutrition :8080  notes :8081  todo :8082"
echo "Logs:      /tmp/chamber-{nutrition,notes,todo,gateway}.log"
echo
echo "Connect Claude Code (one time):"
echo "  claude mcp add --transport http chamber http://localhost:3000/mcp"
echo "Stop everything:  ./start.sh --stop"
