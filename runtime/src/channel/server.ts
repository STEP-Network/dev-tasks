/**
 * The Slack channel's MCP server (channel/channel.ts), over stdio. The
 * dev-tasks plugin declares it (plugin/.mcp.json, through
 * plugin/scripts/slack-channel.mjs), and agentd starts the front door with
 * `--channels plugin:dev-tasks@dev-tasks-marketplace` when the mini's
 * managed settings approve it (runbook section 1). It is a channel only in a
 * session agentd started that way, which it marks AGENTD_FRONT_DOOR=1 and
 * AGENTD_CHANNEL=1: in any other session on the mini it declares nothing and
 * pushes nothing.
 *
 * It has no tools, and it never asks to relay permission prompts
 * (claude/channel/permission): the front door acts through agentctl alone,
 * under its settings and sandbox as they are.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { agentPaths, loadConfig, type AgentConfig, type AgentPaths } from "../config.ts"
import { CHANNEL_INSTRUCTIONS, SlackChannel } from "./channel.ts"

const PASS_MS = 2_000

export interface ChannelServerOptions {
  paths: AgentPaths
  config: AgentConfig
  now: () => Date
  /** AGENTD_FRONT_DOOR=1 and AGENTD_CHANNEL=1: the front door's own session, started with --channels. */
  live: boolean
  pid: number
}

/** The server, and the channel it drives once the session has initialised. */
export function createChannelServer(o: ChannelServerOptions): { server: Server; start: () => void; stop: () => void } {
  const server = new Server(
    { name: "slack", version: "1.0.0" },
    {
      capabilities: { tools: {}, ...(o.live ? { experimental: { "claude/channel": {} } } : {}) },
      ...(o.live ? { instructions: CHANNEL_INSTRUCTIONS } : {}),
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
  let timer: NodeJS.Timeout | null = null
  let busy = false
  const start = () => {
    if (!o.live || timer) return
    const channel = new SlackChannel({
      paths: o.paths,
      config: o.config,
      now: o.now,
      pid: o.pid,
      notify: (n) => server.notification(n),
    })
    const pass = async () => {
      if (busy) return
      busy = true
      try {
        await channel.pass()
      } catch (error) {
        process.stderr.write(`slack channel: ${error instanceof Error ? error.message : String(error)}\n`)
      } finally {
        busy = false
      }
    }
    void pass()
    timer = setInterval(() => void pass(), PASS_MS)
  }
  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }
  server.oninitialized = start
  server.onclose = stop
  return { server, start, stop }
}

if (process.argv[1]?.endsWith("channel/server.ts")) {
  const paths = agentPaths()
  const { server, stop } = createChannelServer({
    paths,
    config: loadConfig(paths),
    now: () => new Date(),
    live: process.env.AGENTD_FRONT_DOOR === "1" && process.env.AGENTD_CHANNEL === "1",
    pid: process.pid,
  })
  const transport = new StdioServerTransport()
  // The session went away: so does the channel, and its heartbeat goes stale.
  process.stdin.on("end", () => {
    stop()
    process.exit(0)
  })
  server.connect(transport).catch((error) => {
    process.stderr.write(`slack channel: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
