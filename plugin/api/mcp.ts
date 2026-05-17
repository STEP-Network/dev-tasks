/**
 * Hosted MCP HTTP endpoint — Vercel Node Function.
 *
 * Companion to the stdio MCP at `src/server.ts`. Both transports register
 * the same 38 tools via `registerAllTools` from `src/register-tools.ts`.
 *
 * - **Stdio (server.ts)**: for Claude Code CLI / Claude Desktop Local.
 *   Reads MONDAY_API_KEY from the parent shell.
 * - **HTTP (this file)**: for Claude Desktop Cloud / claude.ai / Codex Cloud.
 *   Reads the Monday token per-request from `Authorization: Bearer <token>`.
 *   Falls back to MONDAY_API_KEY env var if no header (handy for single-user
 *   or admin deployments).
 *
 * Stateless: each request creates a fresh server + transport. Per-user auth
 * via AsyncLocalStorage — the token lives in request-scoped memory only
 * for the duration of the call, never logged, never persisted.
 *
 * Runtime: Node.js. The MCP SDK uses Node built-ins; Edge runtime can't
 * support it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerAllTools } from "../src/register-tools.ts";
import { mondayAuthContext } from "../src/auth-context.ts";

export default async function handler(
  req: IncomingMessage & { body?: unknown; headers: IncomingMessage["headers"] },
  res: ServerResponse,
): Promise<void> {
  // 1. Resolve the Monday auth for this request.
  //    Per-request Bearer token > env var fallback.
  const authHeader = req.headers.authorization;
  const bearer =
    typeof authHeader === "string"
      ? authHeader.replace(/^Bearer\s+/i, "").trim()
      : undefined;
  const apiKey = bearer || process.env.MONDAY_API_KEY;

  if (!apiKey) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message:
            "Missing Monday auth. Send Authorization: Bearer <monday-token> on this request, " +
            "or configure MONDAY_API_KEY in the server environment as a fallback.",
        },
        id: null,
      }),
    );
    return;
  }

  // 2. Wrap the rest of the handler in the auth context so every Monday
  //    query inside this request uses the per-request token.
  await mondayAuthContext.run({ apiKey }, async () => {
    const server = new McpServer({
      name: "dev-tasks",
      version: "0.8.12",
    });
    registerAllTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: fresh transport per request
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
}
