# Deploying the hosted MCP to Vercel

The plugin's stdio MCP (`plugin/src/server.ts`) works for Claude Code (CLI) and Claude Desktop Local — surfaces that can spawn child processes. For cloud-based surfaces (Claude Desktop Cloud, claude.ai integrations, Codex Cloud), you need a hosted HTTP endpoint. This guide deploys one to Vercel.

Both transports share the same 38 tools via `plugin/src/register-tools.ts`. No duplication; one source of truth.

## Prerequisites

- Vercel account + the `step-network/dev-tasks-mcp` repo connected
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

You should get a JSON-RPC response with `result.serverInfo.name = "monday-tasks"` and `result.protocolVersion`.

A `tools/list` call should return 38 tools:

```sh
curl -X POST https://<your-project>.vercel.app/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## Connect from claude.ai (or other cloud Claudes)

1. **Settings → Integrations → Add MCP server**
2. **Name**: `monday-tasks` (or similar)
3. **URL**: `https://<your-project>.vercel.app/api/mcp`
4. **Authentication**: none (MONDAY_API_KEY is server-side; clients have full access through it)

Claude.ai will probe the URL, list the tools, and surface them as `mcp__claude_ai_<integration-name>__<tool>` in chats.

## Auth model — important

This endpoint is **unauthenticated from the client side**. Anyone who knows the URL can call the tools with full MONDAY_API_KEY-scope permissions. This is fine for:

- Personal use (don't share the URL)
- Internal use behind a private claude.ai workspace

This is **not** fine for public exposure. If you need per-user auth, add a bearer-token check in `plugin/api/mcp.ts`:

```ts
const auth = request.headers.get("authorization");
if (auth !== `Bearer ${process.env.MCP_BEARER_TOKEN}`) {
  return new Response("Unauthorized", { status: 401 });
}
```

…and add `MCP_BEARER_TOKEN` to the Vercel env vars + your claude.ai integration config.

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
