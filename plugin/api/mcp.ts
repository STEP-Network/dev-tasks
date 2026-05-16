/**
 * Hosted MCP HTTP endpoint — Vercel Node Function.
 *
 * Companion to the stdio MCP at `src/server.ts`. Both transports register
 * the same 38 tools via `registerAllTools` from `src/register-tools.ts`.
 *
 * - **Stdio (server.ts)**: for Claude Code CLI / Claude Desktop Local.
 * - **HTTP (this file)**: for Claude Desktop Cloud / claude.ai / Codex Cloud.
 *
 * Stateless: each request creates a fresh server + transport. No session
 * persistence — every JSON-RPC call is self-contained.
 *
 * Auth: MONDAY_API_KEY must be set as a Vercel environment variable.
 *
 * Runtime: Node.js (default for .ts files in api/). The MCP SDK uses Node
 * built-ins internally; Edge runtime can't support it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerAllTools } from "../src/register-tools.ts";

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse
): Promise<void> {
  const server = new McpServer({
    name: "monday-tasks",
    version: "0.5.0",
  });
  registerAllTools(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: fresh transport per request
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
