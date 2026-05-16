/**
 * Hosted MCP HTTP endpoint — Vercel Edge Function.
 *
 * Companion to the stdio MCP at `src/server.ts`. Both transports register
 * the same 38 tools via `registerAllTools` from `src/register-tools.ts`.
 *
 * - **Stdio (server.ts)**: for Claude Code CLI / Claude Desktop Local.
 *   Runs as a child process spawned by .mcp.json.
 * - **HTTP (this file)**: for Claude Desktop Cloud / claude.ai / Codex Cloud.
 *   Deploys to Vercel; cloud-based agents POST JSON-RPC to the deployed URL.
 *
 * Stateless: each request creates a fresh server + transport. No session
 * persistence — every JSON-RPC call is self-contained.
 *
 * Auth: MONDAY_API_KEY must be set as a Vercel environment variable.
 * The Monday client reads it via process.env (Edge runtime exposes env vars
 * the same way as Node).
 *
 * Deploy: see docs/hosted-mcp-deploy.md at repo root.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerAllTools } from "../src/register-tools.ts";

export const config = { runtime: "edge" };

export default async function handler(request: Request): Promise<Response> {
  const server = new McpServer({
    name: "monday-tasks",
    version: "0.4.0",
  });
  registerAllTools(server);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: fresh transport per request
  });
  await server.connect(transport);
  return await transport.handleRequest(request);
}
