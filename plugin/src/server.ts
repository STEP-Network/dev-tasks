import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerAllTools } from "./register-tools.ts";

/**
 * This machine's profile, from the plugin's one reader (hooks/lib/profile.sh,
 * beside dist/ and src/ alike). A reader that cannot run at all counts as a
 * laptop, which keeps the tools: that is what this server did before it asked.
 */
function machineProfile(): string {
  const reader = fileURLToPath(new URL("../hooks/lib/profile.sh", import.meta.url));
  try {
    return execFileSync("bash", [reader, "get", "profile"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "human";
  }
}

const server = new McpServer({
  name: "dev-tasks",
  version: "0.13.0",
});

// The Monday tools are for people. An agent mini has no Monday key, and
// Monday is read-only for agents, so on the agent profile the server offers
// no tools at all. It still connects, with an empty list, so Claude Code
// shows no failed server.
const agent = machineProfile() === "agent";
if (agent) {
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
} else {
  registerAllTools(server);
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  agent ? `[dev-tasks] connected (stdio), 0 tools registered (agent profile)\n` : `[dev-tasks] connected (stdio), 47 tools registered\n`,
);
