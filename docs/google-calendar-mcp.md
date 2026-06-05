# Add the Google Calendar MCP server to Claude Code

Complete, from-scratch setup for Google's **official remote** Calendar MCP server
(`https://calendarmcp.googleapis.com/mcp/v1`) as a standalone MCP server in Claude
Code — including every gotcha hit during initial setup.

> **Read-only caveat:** Despite Google's docs implying otherwise, this server requests
> the **full read/write** Calendar scope set at authorization time. It cannot guarantee
> read-only. If you need a hard read-only guarantee, use a dedicated read-only server
> (one that requests only `calendar.readonly`) against the standard Google Calendar API
> instead — see [True read-only](#true-read-only) at the end.

## 1. Google Cloud project + enable BOTH APIs

In the [Google Cloud Console](https://console.cloud.google.com):

1. Create or select a project (note its **project number**, e.g. `714186570154`).
2. **APIs & Services → Enable APIs** — enable **both**:
   - **Google Calendar API** (`calendar-json.googleapis.com`)
   - **Calendar MCP API** (`calendarmcp.googleapis.com`) — *easy to miss; the MCP
     server is fronted by this separate API. Calls 403 with `The caller does not have
     permission` until it's enabled and fully propagated.*
3. Attach a **billing account** to the project (new Google APIs often reject calls
   without one).
4. After enabling, allow **up to ~30 min to propagate** before expecting calls to work.

## 2. OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. **Internal** if all users are in your Google Workspace org (no verification needed).
   **External** otherwise (add yourself as a **test user**; sensitive Calendar scopes
   require Google verification before public/external use).
3. The server requests the full read/write scope set at auth time regardless of what you
   configure here.

## 3. Create the OAuth client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. **Application type: Web application**.
3. **Authorized redirect URI**: `http://localhost:8080/callback`
   - ⚠️ **Not** `https://claude.ai/api/mcp/auth_callback` (that's for Claude.ai web).
     Claude Code CLI uses a **localhost loopback**, and the port must match
     `--callback-port` below.
4. Save the **Client ID** and **Client Secret**.

## 4. Store secrets (gitignored)

Confirm `.env` is gitignored (`git check-ignore .env`), then add:

```bash
GOOGLE_CALENDAR_CLIENT_ID=your-id.apps.googleusercontent.com
GOOGLE_CALENDAR_CLIENT_SECRET=GOCSPX-xxxxxxxx
GOOGLE_CALENDAR_CALLBACK_PORT=8080
```

Keep placeholders (no real secret) in the committed `.env.example`.

## 5. Register the server with Claude Code

One-shot command that loads `.env` and keeps the secret out of shell history:

```bash
set -a && . ./.env && set +a && \
MCP_CLIENT_SECRET="$GOOGLE_CALENDAR_CLIENT_SECRET" \
claude mcp add --transport http \
  --scope local \
  --client-id "$GOOGLE_CALENDAR_CLIENT_ID" \
  --client-secret \
  --callback-port "$GOOGLE_CALENDAR_CALLBACK_PORT" \
  google-calendar \
  https://calendarmcp.googleapis.com/mcp/v1
```

- `--scope local` = private to you, this project only.
  (`user` = all your projects; `project` = committed to `.mcp.json` for the team.)
- Explicit `--client-id`/`--client-secret` are required: Google's server does **not**
  support Claude Code's automatic Dynamic Client Registration (DCR).

Verify registration:

```bash
claude mcp get google-calendar   # OAuth: client_id/secret configured, callback_port 8080
```

## 6. Authenticate (interactive)

- New `claude` session → `/mcp` → select **google-calendar** → browser opens.
- **Accept all scopes** — granular un-checking can make the MCP API 403 with
  `The caller does not have permission`.
- The `localhost:8080` callback completes automatically → status flips to **✓ Connected**.

## 7. Verify it works

```bash
claude mcp get google-calendar   # Status: ✓ Connected
```

Then ask, e.g., *"What's on my calendar today?"* (uses the `list_events` tool).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| JSON error: *"Calendar MCP API has not been used… or it is disabled"* | `calendarmcp.googleapis.com` not enabled | Enable it (step 1.2) |
| `The caller does not have permission` (persists) | API enablement still propagating, **or** no billing, **or** preview allowlist gating | Wait 15–30 min; confirm the overview page says **"Manage"** (not "Enable"); check billing; re-auth for a fresh token |
| Browser redirect error | redirect URI ≠ callback port | Match `http://localhost:<port>/callback` (step 3) to `--callback-port` (step 5) |

## Where secrets live

- `~/.claude.json`: only the URL, client ID, callback port, and server name — **no secret**.
- **Client secret + OAuth tokens**: macOS **Keychain** (Credential Manager on Windows,
  `pass`/keyring on Linux). Refresh tokens are handled automatically.

## True read-only

Google's official server requests read/write, so it can't guarantee read-only. For a
hard read-only guarantee, use a dedicated read-only MCP server (one that requests only
`https://www.googleapis.com/auth/calendar.readonly`) against the standard Google Calendar
API. This also sidesteps the `calendarmcp.googleapis.com` preview-gating issues entirely.
