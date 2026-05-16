import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./register-tools.ts";

const server = new McpServer({
  name: "monday-tasks",
  version: "0.6.0",
});

registerAllTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[monday-tasks] connected (stdio), 38 tools registered\n`);
