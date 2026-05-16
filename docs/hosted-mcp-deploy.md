# Deploying the hosted MCP to Vercel

The plugin's stdio MCP (`plugin/src/server.ts`) works for Claude Code (CLI) and Claude Desktop Local — surfaces that can spawn child processes. For cloud-based surfaces (Claude Desktop Cloud, claude.ai integrations, Codex Cloud), you need a hosted HTTP endpoint. This guide deploys one to Vercel.

Both transports share the same 38 tools via `plugin/src/register-tools.ts`. No duplication; one source of truth.

## Prerequisites

- Vercel account + the `step-network/dev-tasks` repo connected
- A `MONDAY_API_KEY` with read+write access to your Monday workspace

## One-time setup

1. **In the Vercel dashboard** for this project → **Settings → General**:
   - **Root Directory**: `plugin`
   - **Build Command**: `npm run build` (auto-detected from `plugin/package.json`)
   - **Install Command**: `npm install`
   - **Output Directory**: `dist`
   - **Framework Preset**: `Other`

2. **Settings → Environment Variables**:
   - Add `MONDAY_API_KEY` for Production (and Preview, if you want preview-URL access too)

3. **Deploy** (Vercel will auto-deploy on push to `main`):
   - The Edge function at `plugin/api/mcp.ts` becomes available at `https://<your-project>.vercel.app/api/mcp`

## Verify the deploy

```sh
curl -X POST https://<your-project>.vercel.app/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

You should get a JSON-RPC response with `result.serverInfo.name = "dev-tasks"` and `result.protocolVersion`.

A `tools/list` call should return 38 tools:

```sh
curl -X POST https://<your-project>.vercel.app/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## Connect from claude.ai (or other cloud Claudes)

Each user needs their own Monday personal API token. The token is sent on every MCP request as a Bearer header — the server uses it to authenticate to Monday, so every change in Monday is attributed to **that specific user**, not a shared service account.

### Step 1 — Generate a Monday personal token

In Monday: **Profile (top-right) → Developers → API → My access tokens → Generate**

Copy the token. Treat it like a password.

### Step 2 — Configure the claude.ai integration

1. claude.ai → **Settings → Integrations → Add MCP server**
2. **Name**: `dev-tasks` (or similar)
3. **URL**: `https://<your-project>.vercel.app/api/mcp`
4. **Custom headers**: `Authorization: Bearer <your-monday-token>`

claude.ai will probe the URL with that header, list the tools, and surface them as `mcp__claude_ai_<integration-name>__<tool>` in chats. From that point: every action through these tools is attributed to **your** Monday account.

### Verify with curl

```sh
curl -X POST https://<your-project>.vercel.app/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer <your-monday-token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

A request **without** the `Authorization` header returns a `401` JSON-RPC error unless `MONDAY_API_KEY` is set server-side (fallback for single-user/admin deployments — see below).

## Auth model

The hosted endpoint uses **per-request Bearer tokens** with a server-side **env-var fallback**.

| Request | Behavior |
|---|---|
| `Authorization: Bearer <token>` | Token is the Monday API key for THIS request only. Monday attributes all changes to the token's owner. The token is never logged, never stored. |
| no header, `MONDAY_API_KEY` set on Vercel | Falls back to the shared env-var key. Useful for single-user deployments or an "admin" shared key. All actions attributed to the env-var key's owner. |
| no header, no env var | Returns 401 JSON-RPC error. |

### Why per-user is better than shared

- Monday's audit trail shows the real actor (not a single service account)
- Tokens can be revoked per-user without affecting others
- Token compromise has bounded blast radius (one user's permissions, not "everyone")
- No central token rotation ceremony — each user manages their own

### Implementation

Server-side per-request isolation via `AsyncLocalStorage`:

1. `plugin/api/mcp.ts` parses the Bearer header, calls `mondayAuthContext.run({ apiKey }, ...)` for the rest of the request
2. `plugin/src/monday-client.ts` reads `mondayAuthContext.getStore()?.apiKey ?? process.env.MONDAY_API_KEY` on every Monday API call
3. Tools never see the token directly — no risk of accidental logging

Concurrent requests get separate ALS frames, so no cross-request token leakage.

## Architecture

```
Cloud surface (claude.ai)            Local surface (Claude Code CLI)
        │                                       │
        │ HTTPS POST JSON-RPC                   │ stdio JSON-RPC
        ▼                                       ▼
plugin/api/mcp.ts                       plugin/src/server.ts
        │                                       │
        └──────────────┬────────────────────────┘
                       │
                       ▼
              plugin/src/register-tools.ts
                       │
                       ▼
              plugin/src/tools/*.ts (38 tools)
```

Same code, two transports. The Edge function spins up a fresh server + transport per request (stateless); the stdio entry maintains a long-running process.

## Cost note

Vercel Edge functions on the Hobby plan: 100k invocations/month free. Each MCP request is one invocation. For typical agent usage, well within free tier.
