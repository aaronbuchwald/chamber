#!/usr/bin/env bash
#
# Bring up the whole Chamber MCP stack behind one agentgateway endpoint:
#   - nutrition / notes / todo HTTP APIs (ports 8080 / 8081 / 8082)
#   - agentgateway federating all of them + the Obsidian MCP server on :3000/mcp
#
# Usage:   ./start.sh            (re-running is safe; it restarts cleanly)
#          ./start.sh --stop     (stop everything)
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
  # shellcheck disable=SC2046
  lsof -ti:"$PORTS" 2>/dev/null | xargs kill 2>/dev/null || true
}

if [[ "${1:-}" == "--stop" ]]; then
  stop_all
  echo "Stopped all Chamber services (ports $PORTS)."
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

GW="${AGENTGATEWAY_BIN:-/tmp/agentgateway}"
if [[ ! -x "$GW" ]]; then
  echo "ERROR: agentgateway binary not found/executable at $GW (set AGENTGATEWAY_BIN)." >&2
  exit 1
fi

# --- restart cleanly ---------------------------------------------------------
stop_all
sleep 1

# --- start the three app HTTP APIs -------------------------------------------
( cd apps/nutrition && PORT=8080 nohup node node_modules/.bin/tsx src/http.ts >/tmp/chamber-nutrition.log 2>&1 & )
( cd apps/notes     && PORT=8081 nohup node node_modules/.bin/tsx src/http.ts >/tmp/chamber-notes.log     2>&1 & )
( cd apps/todo      && PORT=8082 nohup node node_modules/.bin/tsx src/http.ts >/tmp/chamber-todo.log      2>&1 & )

# --- wait for health, then snapshot each OpenAPI spec the gateway reads -------
for p in 8080 8081 8082; do
  for _ in $(seq 1 40); do curl -sf "localhost:$p/" >/dev/null 2>&1 && break; sleep 0.25; done
done
curl -s localhost:8080/openapi.json > apps/nutrition/openapi.json
curl -s localhost:8081/openapi.json > apps/notes/openapi.json
curl -s localhost:8082/openapi.json > apps/todo/openapi.json

# --- start the gateway (inherits OBSIDIAN_API_KEY from this shell's env) ------
if [[ -z "${OBSIDIAN_API_KEY:-}" ]]; then
  echo "WARNING: OBSIDIAN_API_KEY not set — the obsidian_* tools will fail until it is." >&2
fi
nohup "$GW" -f agentgateway-all.yaml >/tmp/chamber-gateway.log 2>&1 &
sleep 4

echo
echo "Chamber is up. MCP endpoint:  http://localhost:3000/mcp"
echo "Nutrition UI:  http://localhost:8080/"
echo "Backends:  nutrition :8080  notes :8081  todo :8082"
echo "Logs:      /tmp/chamber-{nutrition,notes,todo,gateway}.log"
echo
echo "Connect Claude Code (one time):"
echo "  claude mcp add --transport http chamber http://localhost:3000/mcp"
echo "Stop everything:  ./start.sh --stop"
