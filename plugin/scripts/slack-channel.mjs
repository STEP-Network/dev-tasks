#!/usr/bin/env node
// The Slack channel into an agent mini's front door (STEP-3293). The plugin
// declares it (.mcp.json) for every session that loads the plugin, so it
// starts the runtime's channel server (runtime/src/channel/server.ts) only
// where that is the front door: a dev-tasks checkout with its runtime beside
// this plugin, and AGENTD_FRONT_DOOR=1, which agentd sets on the front door's
// session alone. Anywhere else (a laptop, a person's own session on the mini)
// it is a quiet MCP server with nothing in it, so no session lists a failed one.

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const runtime = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "runtime")
const server = join(runtime, "src", "channel", "server.ts")
const loader = join(runtime, "node_modules", "tsx", "dist", "loader.mjs")

if (process.env.AGENTD_FRONT_DOOR === "1" && existsSync(server) && existsSync(loader)) {
  const child = spawn(process.execPath, ["--import", loader, server], { stdio: "inherit" })
  child.on("exit", (code) => process.exit(code ?? 0))
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal))
} else {
  // JSON-RPC over stdio, one message per line: an MCP server with no tools and no channel.
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  createInterface({ input: process.stdin }).on("line", (line) => {
    let request
    try {
      request = JSON.parse(line)
    } catch {
      return
    }
    if (request.id === undefined || request.id === null) return
    if (request.method === "initialize") {
      send({ id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: {}, serverInfo: { name: "slack", version: "idle" } } })
    } else if (request.method === "tools/list") {
      send({ id: request.id, result: { tools: [] } })
    } else if (request.method === "ping") {
      send({ id: request.id, result: {} })
    } else {
      send({ id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } })
    }
  })
}
