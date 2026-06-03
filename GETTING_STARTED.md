# Getting Started — Chamber MCP stack behind agentgateway

This brings up all three prototype apps (**nutrition**, **notes**, **todo**) plus an
**Obsidian** MCP server behind a single [agentgateway](https://agentgateway.dev)
endpoint, so one MCP connection exposes every tool.

```
Claude Code ──HTTP MCP──▶ agentgateway :3000/mcp ─┬─ nutrition  (OpenAPI → :8080)
                                                  ├─ notes      (OpenAPI → :8081)
                                                  ├─ todo       (OpenAPI → :8082)
                                                  └─ obsidian   (stdio: obsidian-mcp-server → Local REST API)
```

## Prerequisites

1. **Node 22** (the nutrition app's `better-sqlite3` native module is built for it).
   With `nvm`: `nvm install 22`. `start.sh` selects it automatically if `nvm` is present.
2. **Per-app deps installed** (once):
   ```bash
   ( cd packages/appkit && npm install )
   ( cd apps/nutrition  && npm install )   # also builds better-sqlite3
   ( cd apps/notes      && npm install )
   ( cd apps/todo       && npm install )
   # macOS: if better-sqlite3 fails to build, run `xcode-select --install` first.
   # If you switch Node versions later: ( cd apps/nutrition && npm rebuild better-sqlite3 )
   ```
3. **agentgateway binary** at `/tmp/agentgateway` (or set `AGENTGATEWAY_BIN`):
   ```bash
   curl -fL -o /tmp/agentgateway \
     https://github.com/agentgateway/agentgateway/releases/download/v1.3.0-alpha.1/agentgateway-darwin-arm64
   chmod +x /tmp/agentgateway
   # Linux: use the agentgateway-linux-amd64 asset instead.
   ```

## Configure secrets

Secrets live in `.env` (gitignored). Copy the template and fill it in:

```bash
cp .env.example .env
# then edit .env and set OBSIDIAN_API_KEY=...
```

`OBSIDIAN_API_KEY` comes from the Obsidian **Local REST API** plugin (see below).
`start.sh` loads `.env` into the gateway's environment, and agentgateway passes it
through to the spawned Obsidian process — **the key is never written into any
version-controlled file** (`agentgateway-all.yaml` is intentionally key-free).

## Obsidian setup (for the `obsidian_*` tools)

The Obsidian server talks to a vault through the Local REST API plugin, so the
exposed vault is **whichever vault has the plugin enabled** — enable it in exactly
one vault.

1. Open the vault you want to expose in Obsidian.
2. **Settings → Community plugins** → (disable Restricted Mode) → **Browse** →
   install & enable **"Local REST API"**.
3. In the plugin settings: enable the **Non-encrypted (HTTP) server** (port `27123`,
   which matches `agentgateway-all.yaml`) and **copy the API Key** into your `.env`.
   - Prefer HTTPS? Set `OBSIDIAN_BASE_URL: "https://127.0.0.1:27124"` in
     `agentgateway-all.yaml` (SSL verification is already off for the self-signed cert).
4. Obsidian must stay **running with that vault open** for the `obsidian_*` tools to work.

## Run everything (single command)

```bash
./start.sh
```

This stops anything on the stack's ports, starts the three HTTP APIs, regenerates
their OpenAPI specs, and starts the gateway. Re-running it restarts cleanly.
Stop everything with `./start.sh --stop`.

## Connect Claude Code

One-time registration (the gateway is one HTTP MCP server fronting everything):

```bash
claude mcp add --transport http chamber http://localhost:3000/mcp
claude            # then /mcp to confirm "chamber" is connected
```

You should see 24 tools: `nutrition_*` (3), `notes_*` (5), `todo_*` (4),
`obsidian_obsidian_*` (12). Try: *"list the notes in my Obsidian vault"*,
*"log a meal of chicken and broccoli"*, *"add a todo to buy milk"*.

To refresh tools after a gateway restart: run `/mcp` → reconnect `chamber`.

## Troubleshooting

- **`obsidian_*` tools error** → Obsidian isn't running, the vault with the plugin
  isn't open, or `OBSIDIAN_API_KEY` in `.env` is wrong/stale. Check
  `/tmp/chamber-gateway.log`.
- **First obsidian call after a restart is slow** → the gateway cold-starts the
  `npx obsidian-mcp-server` subprocess on the first request; later calls are fast.
- **nutrition fails with a `NODE_MODULE_VERSION` / bindings error** → you're not on
  Node 22. Run `nvm use 22` then `( cd apps/nutrition && npm rebuild better-sqlite3 )`.
- **Reset demo state** → `rm -f apps/nutrition/nutrition.db* ; rm -rf apps/notes/vault ; rm -f apps/todo/todos.md`

## Security notes

- The real `OBSIDIAN_API_KEY` lives only in `.env` (gitignored) and in the running
  process environment — never in `agentgateway-all.yaml` or any tracked file.
- The Local REST API binds to localhost only. Rotate the key in the plugin settings
  if it's ever exposed.
