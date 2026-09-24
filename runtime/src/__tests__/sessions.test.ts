/**
 * What a front-door session and a worker session really load and may do,
 * asked of the Claude Code binary the SDK ships (not a model): each session
 * runs in a throwaway HOME against a local fake of the Messages API
 * (fakeapi.ts), so nothing leaves the machine and nothing is billed. The
 * checks a setup on Eve's mini needed (2026-09-24):
 *   - the front door's settings deny the Read tool on the secrets (decision 8),
 *     yet trackerctl, run through Bash, still reads the Linear key, and
 *     nothing reads the Slack tokens
 *   - the front door on the agent profile is offered no Monday tools, and its
 *     plugin's server still connects
 *   - a worker loads the dev-tasks plugin exactly once, from pluginRoot, with
 *     the marketplace copy the front door uses installed beside it
 * macOS only: the sandbox is macOS's, and the binary is the darwin package's.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, chmodSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../config.ts"
import { sdkOptions } from "../worker/run.ts"
import { startFakeApi, type ToolCall } from "./fakeapi.ts"

const RUNTIME = fileURLToPath(new URL("../..", import.meta.url))
const CHECKOUT = dirname(RUNTIME)
const PLUGIN = join(CHECKOUT, "plugin")
const LOADER = join(RUNTIME, "node_modules", "tsx", "dist", "loader.mjs")

function binaryAvailable(): boolean {
  if (process.platform !== "darwin") return false
  try {
    createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-darwin-${process.arch}/package.json`)
    return true
  } catch {
    return false
  }
}

/** A HOME with the agent profile and both secrets files, as a mini has them. */
function miniHome(tag: string): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `sessions-${tag}-`)))
  mkdirSync(join(home, ".claude"), { recursive: true })
  writeFileSync(join(home, ".claude", "dev-tasks-profile.json"), '{ "profile": "agent", "devSurface": "preview", "mini": "eve" }\n')
  for (const [file, body] of [
    [".config/linear/.env", "LINEAR_API_KEY=lin_api_SESSIONTEST\n"],
    [".config/agentd/slack.env", "SLACK_BOT_TOKEN=xoxb-SESSIONTEST\nSLACK_APP_TOKEN=xapp-SESSIONTEST\n"],
  ]) {
    mkdirSync(dirname(join(home, file)), { recursive: true })
    writeFileSync(join(home, file), body)
    chmodSync(join(home, file), 0o600)
  }
  return home
}

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  execFileSync("git", ["init", "-q", "-b", "staging", dir])
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "-q", "--allow-empty", "-m", "base"])
  return dir
}

/** The plugin installed for the front door as the runbook does it: this checkout as a directory marketplace. */
function installMarketplace(home: string): void {
  const now = new Date().toISOString()
  const plugins = join(home, ".claude", "plugins")
  const cache = join(plugins, "cache", "dev-tasks-marketplace", "dev-tasks", "1.2.0")
  cpSync(PLUGIN, cache, { recursive: true, filter: (src) => !src.includes("node_modules") })
  writeFileSync(join(plugins, "known_marketplaces.json"), JSON.stringify({ "dev-tasks-marketplace": { source: { source: "directory", path: CHECKOUT }, installLocation: CHECKOUT, lastUpdated: now } }))
  writeFileSync(
    join(plugins, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "dev-tasks@dev-tasks-marketplace": [{ scope: "user", installPath: cache, version: "1.2.0", installedAt: now, lastUpdated: now }] } }),
  )
}

/** templates/claude-settings.json as install.sh renders it into ~/.claude/settings.json. */
function frontDoorSettings(home: string, repo: string): { sandbox: { network: { allowedDomains: string[] } } } {
  const text = readFileSync(join(RUNTIME, "templates", "claude-settings.json"), "utf8").replaceAll("__AGENTD_HOME__", join(home, ".agentd")).replaceAll("__REPO__", repo)
  return JSON.parse(text)
}

function env(home: string, api: string): Record<string, string> {
  return {
    HOME: home,
    USER: process.env.USER ?? "agent",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: tmpdir(),
    // A key the fake accepts. The real API is never asked: the base URL is the fake's.
    ANTHROPIC_API_KEY: "sk-ant-api03-SESSIONTEST",
    ANTHROPIC_BASE_URL: api,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  }
}

interface Session {
  init: { plugins?: Array<{ name: string; path: string; source?: string }>; mcp_servers?: Array<{ name: string; status: string }>; tools?: string[] } | null
  results: string[]
  prompted: string[]
}

async function session(script: ToolCall[], options: (api: string) => Options): Promise<Session> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk")
  const api = await startFakeApi(script)
  const out: Session = { init: null, results: [], prompted: [] }
  const o = options(api.url)
  // Nobody is there to answer a prompt: record it and refuse, as the front door's --permission-prompts none would.
  o.canUseTool ??= async (name, input) => {
    out.prompted.push(`${name} ${JSON.stringify(input)}`)
    return { behavior: "deny", message: "no prompts in this test" }
  }
  try {
    for await (const m of query({ prompt: "go", options: o })) {
      if (m.type === "system" && m.subtype === "init") out.init = m as unknown as Session["init"]
      if (m.type === "user" && Array.isArray(m.message.content)) {
        for (const c of m.message.content as Array<{ type: string; content?: unknown }>) {
          if (c.type === "tool_result") out.results.push(typeof c.content === "string" ? c.content : JSON.stringify(c.content))
        }
      }
    }
  } finally {
    await api.close()
  }
  return out
}

describe.skipIf(!binaryAvailable())("sessions, as the Claude Code binary runs them", () => {
  it("lets the front door's trackerctl read the Linear key, and nothing read a secret into the session", async () => {
    const home = miniHome("frontdoor")
    const repo = gitRepo(join(home, "polads"))
    writeFileSync(join(repo, "brief.md"), "## Goal\nA brief.\n")
    mkdirSync(join(repo, ".claude"), { recursive: true })
    writeFileSync(join(repo, ".claude", "project-config.json"), JSON.stringify({ tracker: { provider: "linear" } }))
    const settings = frontDoorSettings(home, repo)
    // The only change from the template: Linear is left out of the network, so
    // nothing leaves the machine. What is checked here is file access.
    settings.sandbox.network.allowedDomains = []
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings))
    const trackerctl = `node --import ${LOADER} ${join(PLUGIN, "scripts", "trackerctl.ts")}`
    const agentctl = `node --import ${LOADER} ${join(RUNTIME, "src", "cli", "agentctl.ts")}`
    mkdirSync(join(home, ".agentd"), { recursive: true })
    const s = await session(
      [
        { name: "Bash", input: { command: `cd ${repo} && ${trackerctl} whoami`, description: "who am I" } },
        { name: "Read", input: { file_path: join(home, ".config", "linear", ".env") } },
        { name: "Read", input: { file_path: join(home, ".config", "agentd", "slack.env") } },
        { name: "Bash", input: { command: "cat ~/.config/agentd/slack.env | wc -c", description: "slack tokens" } },
        { name: "Bash", input: { command: `cd ${repo} && ${trackerctl} update STEP-1 --description-file ~/.config/linear/.env`, description: "a secrets file as a brief" } },
        { name: "Bash", input: { command: `${agentctl} job submit --issue STEP-5`, description: "queue a job" } },
        { name: "Bash", input: { command: `echo x > ${join(repo, "brief.md")}`, description: "write in the checkout" } },
      ],
      (api) => ({ cwd: repo, env: env(home, api), settingSources: ["user", "project"], permissionMode: "default", maxTurns: 12 }),
    )
    const [whoami, readKey, readSlack, catSlack, secretBrief, submit, write] = s.results
    // The key was read: trackerctl went on to the network, which this test closes.
    expect(whoami).toMatch(/fetch failed/)
    expect(whoami).not.toMatch(/could not be read/)
    expect(readKey).toMatch(/denied by your permission settings/)
    expect(readSlack).toMatch(/denied by your permission settings/)
    expect(catSlack).toMatch(/Operation not permitted|denied/)
    // Decision 8. The sandbox lets trackerctl read the Linear key, so trackerctl
    // itself is what keeps the key out of an issue: its refusal, not a denial.
    expect(secretBrief).toMatch(/looks like a secrets file/)
    expect(submit).toMatch(/"issue":"STEP-5"/)
    expect(existsSync(join(home, ".agentd", "jobs", "pending"))).toBe(true)
    expect(write).toMatch(/denied|not permitted/i)
    expect(readFileSync(join(repo, "brief.md"), "utf8")).toBe("## Goal\nA brief.\n")
    expect(s.results.join("\n")).not.toMatch(/SESSIONTEST/)
    expect(s.prompted).toEqual([])
  }, 90_000)

  it("offers the front door no Monday tools on the agent profile, and still connects the plugin's server", async () => {
    const home = miniHome("mcp")
    const repo = gitRepo(join(home, "polads"))
    installMarketplace(home)
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(frontDoorSettings(home, repo)))
    const s = await session([], (api) => ({ cwd: repo, env: env(home, api), settingSources: ["user", "project"], permissionMode: "default", maxTurns: 2 }))
    expect(s.init?.plugins?.filter((p) => p.name === "dev-tasks")).toEqual([expect.objectContaining({ source: "dev-tasks@dev-tasks-marketplace" })])
    expect(s.init?.mcp_servers).toContainEqual(expect.objectContaining({ name: "plugin:dev-tasks:dev-tasks", status: "connected" }))
    expect(s.init?.tools?.filter((t) => t.startsWith("mcp__"))).toEqual([])
  }, 90_000)

  it("loads the dev-tasks plugin once in a worker, from pluginRoot, with the front door's marketplace copy installed", async () => {
    const home = miniHome("worker")
    const repo = gitRepo(join(home, "polads"))
    // PolAds enables the marketplace plugin in its project settings, which the worker loads (projectConfigRoot).
    mkdirSync(join(repo, ".claude"), { recursive: true })
    writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "dev-tasks@dev-tasks-marketplace": true } }))
    installMarketplace(home)
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(frontDoorSettings(home, repo)))
    const worktree = gitRepo(join(home, "worktree"))
    const config = ConfigSchema.parse({ mini: "eve", repo: { path: repo }, pluginRoot: PLUGIN, slack: { allowedUsers: ["UNATE"] } })
    const s = await session([], (api) => {
      const o = sdkOptions({ config, cwd: worktree, model: "sonnet", abortController: new AbortController(), rules: "test", pnpmStore: null, env: {}, home })
      // The worker's own environment, but for the fake API's.
      o.env = { ...env(home, api), DEV_TASKS_PROFILE: "agent" }
      delete o.outputFormat
      return o
    })
    expect(s.init?.plugins?.filter((p) => p.name === "dev-tasks")).toEqual([expect.objectContaining({ path: PLUGIN, source: "dev-tasks@inline" })])
    // skipMcpDiscovery: the worker starts no plugin server at all.
    expect(s.init?.mcp_servers ?? []).toEqual([])
  }, 90_000)
})
