import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./register-tools.js";
const server = new McpServer({
    name: "dev-tasks",
    version: "0.13.0",
});
registerAllTools(server);
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[dev-tasks] connected (stdio), 38 tools registered\n`);
