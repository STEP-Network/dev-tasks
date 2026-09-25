/**
 * The Slack channel end to end (STEP-3293), as the front door's session runs
 * it: the dev-tasks plugin's launcher (plugin/scripts/slack-channel.mjs),
 * spawned as Claude Code spawns an MCP server, speaking MCP over stdio to a
 * client that stands in for the session. A person's reply goes through the
 * bridge into the inbox, reaches the session as a channel event, and is
 * handled the way the front door handles it: an agentctl call that records
 * the decision and acks the message. Nothing here reaches Slack, Linear or a
 * model.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Notification } from "@modelcontextprotocol/sdk/types.js"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema, type AgentPaths } from "../../config.ts"
import { listNew } from "../../fsq.ts"
import { run } from "../../cli/agentctl.ts"
import { handleEnvelope, type BridgeDeps } from "../../slack/bridge.ts"
import { saveThread } from "../../threads.ts"
import { tickPath } from "../../tick.ts"
import { fakeExec, fakeTracker, issue } from "../../__tests__/fakes.ts"
import { readChannelState } from "../state.ts"

const LAUNCHER = fileURLToPath(new URL("../../../../plugin/scripts/slack-channel.mjs", import.meta.url))
const SERVER = fileURLToPath(new URL("../server.ts", import.meta.url))
const LOADER = fileURLToPath(new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url))
const CONFIG = { mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] } }
const QUESTION = "Should the notice show the publication date or the signing date?\n\nMy recommendation: use the publication date. Reply yes to go with it, or tell me what you want instead."

let root = ""
let paths: AgentPaths
const clients: Client[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentd-channel-"))
  process.env.AGENTD_HOME = join(root, ".agentd")
  paths = agentPaths(root)
  mkdirSync(paths.state, { recursive: true })
  writeFileSync(paths.config, JSON.stringify(CONFIG))
  // The thread Eve asked her question in, as the outbox saved it.
  saveThread(paths, { issue: "STEP-7", channelId: "CQ", ts: "1700.1", permalink: null, createdAt: "2026-09-25T09:00:00.000Z", lastQuestionAt: "2026-09-25T09:00:00.000Z", lastQuestion: QUESTION })
  // The front door woke up a minute ago: it is up, so the bridge leaves the words to it.
  writeFileSync(tickPath(paths), JSON.stringify({ at: new Date(Date.now() - 60_000).toISOString() }))
})
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {})
  delete process.env.AGENTD_HOME
})

/**
 * A session, with the launcher as Claude Code starts it: the front door
 * started with --channels (agentd marks it AGENTD_FRONT_DOOR=1 and
 * AGENTD_CHANNEL=1), the front door started without (the managed settings do
 * not approve it, or config.json turns it off), or any other session.
 */
async function session(kind: "channel" | "front door without the channel" | "another session"): Promise<{ client: Client; events: Notification[] }> {
  const events: Notification[] = []
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: root, AGENTD_HOME: paths.root }
  if (kind !== "another session") env.AGENTD_FRONT_DOOR = "1"
  if (kind === "channel") env.AGENTD_CHANNEL = "1"
  const client = new Client({ name: "front-door", version: "1.0.0" })
  client.fallbackNotificationHandler = async (n) => void events.push(n)
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [LAUNCHER], env, stderr: "ignore" }))
  clients.push(client)
  return { client, events }
}

const until = async (what: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 50))
  }
}

function bridge(): { deps: BridgeDeps; fake: ReturnType<typeof fakeTracker> } {
  const fake = fakeTracker([issue({ id: "STEP-7", state: "On hold", labels: ["polads", "agent-ready", "awaiting-answer"], description: "## Goal\n\nFix it." })])
  const deps: BridgeDeps = {
    paths,
    config: ConfigSchema.parse(CONFIG),
    tracker: fake.tracker,
    web: {
      async postMessage() {
        return { ts: "1.1" }
      },
      async permalink(channel, ts) {
        return `https://step.slack.com/archives/${channel}/p${ts.replace(".", "")}`
      },
      async react() {},
      async userName(id) {
        return id === "UNATE" ? "Nate" : id
      },
    },
    classifyContext: {
      teamId: "T1", botUserId: "UBOT", otherAgentBots: [], allowedUsers: ["UNATE"],
      channels: { agents: "CAG", questions: "CQ", intake: "CIN", releases: "CREL" },
      issueForThread: (channel, ts) => (channel === "CQ" && ts === "1700.1" ? "STEP-7" : null),
    },
    log: { info() {}, warn() {}, error() {} },
    now: () => new Date(),
    busy: new Set(),
  }
  return { deps, fake }
}
const reply = (ts: string, text: string) => ({ team_id: "T1", event: { type: "message", user: "UNATE", channel: "CQ", ts, thread_ts: "1700.1", text } })

describe("the Slack channel into the front door (STEP-3293)", () => {
  it("delivers a person's reply into the session as a channel event, and a yes records the recommendation itself, once", async () => {
    const { client, events } = await session("channel")
    // A channel, and nothing more: no tools, and no relay of permission prompts.
    expect(client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} })
    expect((await client.listTools()).tools).toEqual([])
    await until(() => readChannelState(paths) !== null)

    const { deps, fake } = bridge()
    await handleEnvelope(deps, reply("1700.5", "yes"))
    await until(() => events.length === 1)
    expect(events[0]).toMatchObject({
      method: "notifications/claude/channel",
      params: {
        content: "yes",
        meta: expect.objectContaining({ key: "msg:CQ:1700.5", kind: "reply", issue: "STEP-7", channel: "CQ", thread_ts: "1700.1", ts: "1700.5", user: "Nate", question: QUESTION }),
      },
    })
    // The front door was there: the bridge said nothing and recorded nothing.
    expect(listNew(paths.outbox)).toEqual([])
    expect(fake.called("updateIssue")).toEqual([])

    // The front door reads it as a yes to its recommendation.
    const printed: string[] = []
    expect(await run(["decide", "--key", "msg:CQ:1700.5", "--agree"], (l) => void printed.push(l), { tracker: () => fake.tracker, exec: fakeExec().exec, now: () => new Date(), env: {}, isTTY: () => false })).toBe(0)
    expect(fake.issues.get("STEP-7")).toMatchObject({ state: "Ready", labels: ["polads", "agent-ready"] })
    expect(fake.issues.get("STEP-7")!.description).toContain(
      '**Nate** ([Slack](https://step.slack.com/archives/CQ/p17005)): Nate agreed with the recommendation: use the publication date. (Their words: "yes")',
    )
    expect(listNew(paths.inbox)).toEqual([])
    expect(listNew<{ kind: string; text?: string }>(paths.outbox).map((e) => e.payload)).toEqual([
      expect.objectContaining({ kind: "reply", threadTs: "1700.1", text: "Thanks, Nate. I added your decision to STEP-7: use the publication date. It goes back to Ready. Nothing needed from you." }),
      expect.objectContaining({ kind: "react", name: "white_check_mark" }),
    ])
    // Handled: never pushed again.
    await new Promise((r) => setTimeout(r, 2_500))
    expect(events).toHaveLength(1)
  }, 30_000)

  it("pushes again, after a restart, a message the front door never closed", async () => {
    const first = await session("channel")
    const { deps } = bridge()
    await handleEnvelope(deps, reply("1700.6", "what do you recommend?"))
    await until(() => first.events.length === 1)
    await first.client.close()
    const second = await session("channel")
    await until(() => second.events.length === 1)
    expect((second.events[0].params as { meta: Record<string, string> }).meta.key).toBe("msg:CQ:1700.6")
    // A question back is answered in the thread and acked: then it stops.
    await run(["ack", "msg:CQ:1700.6"], () => {}, { env: {}, isTTY: () => false })
    await new Promise((r) => setTimeout(r, 2_500))
    expect(second.events).toHaveLength(1)
  }, 30_000)

  it("is no channel from the runtime's own server either without AGENTD_CHANNEL, however it is started (STEP-3293 review)", async () => {
    // The launcher checks first, and the server checks again: neither alone opens the channel.
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: root, AGENTD_HOME: paths.root, AGENTD_FRONT_DOOR: "1" }
    const client = new Client({ name: "front-door", version: "1.0.0" })
    const events: Notification[] = []
    client.fallbackNotificationHandler = async (n) => void events.push(n)
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", LOADER, SERVER], env, stderr: "ignore" }))
    clients.push(client)
    expect(client.getServerVersion()).toEqual({ name: "slack", version: "1.0.0" })
    expect(client.getServerCapabilities()?.experimental).toBeUndefined()
    const { deps } = bridge()
    await handleEnvelope(deps, reply("1700.8", "what do you recommend?"))
    await new Promise((r) => setTimeout(r, 2_500))
    expect(events).toEqual([])
    expect(readChannelState(paths)).toBeNull()
  }, 30_000)

  for (const kind of ["front door without the channel", "another session"] as const) {
    it(`is no channel in ${kind === "another session" ? "any other session on the mini" : "a front door started without --channels"}: no capability, and nothing pushed (STEP-3293 review)`, async () => {
      const { client, events } = await session(kind)
      // The launcher never starts the runtime's server there: the quiet one answers.
      expect(client.getServerVersion()).toEqual({ name: "slack", version: "idle" })
      expect(client.getServerCapabilities()?.experimental).toBeUndefined()
      const { deps } = bridge()
      await handleEnvelope(deps, reply("1700.7", "what do you recommend?"))
      await new Promise((r) => setTimeout(r, 2_500))
      expect(events).toEqual([])
      expect(readChannelState(paths)).toBeNull()
    }, 30_000)
  }
})
