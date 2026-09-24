/**
 * What a front-door session and a worker session really load and may do,
 * asked of the Claude Code binary the SDK ships (not a model): each session
 * runs in a throwaway HOME against a local fake of the Messages API
 * (fakeapi.ts), so nothing leaves the machine and nothing is billed. Linear
 * is a fake on loopback too (DEV_TASKS_LINEAR_ENDPOINT). The
 * checks a setup on Eve's mini needed (2026-09-24):
 *   - the front door's agentctl and trackerctl run outside its sandbox, so
 *     they read the Linear key and reach Linear (a sandboxed Node fetch cannot:
 *     it ignores the sandbox's proxy), while every other command, a compound
 *     one with them included, stays inside: no secret, no write to ~/.agentd,
 *     no network, and the Read tool is denied the secrets too (decision 8)
 *   - the front door on the agent profile is offered no Monday tools, and its
 *     plugin's server still connects
 *   - a worker loads the dev-tasks plugin exactly once, from pluginRoot, with
 *     the marketplace copy the front door uses installed beside it
 * macOS only: the sandbox is macOS's, and the binary is the darwin package's.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../config.ts"
import { sdkOptions } from "../worker/run.ts"
import { startFakeApi, startFakeLinear, type ToolCall } from "./fakeapi.ts"

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

/**
 * templates/claude-settings.json as install.sh renders it into
 * ~/.agentd/front-door-settings.json, which agentd passes with --settings (the
 * SDK's `settings` option is the same flag). Returns the file's path.
 */
function frontDoorSettings(home: string, repo: string): string {
  const text = readFileSync(join(RUNTIME, "templates", "claude-settings.json"), "utf8").replaceAll("__AGENTD_HOME__", join(home, ".agentd")).replaceAll("__REPO__", repo)
  const path = join(home, ".agentd", "front-door-settings.json")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
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
  it("runs the front door's agentctl and trackerctl outside its sandbox and against Linear, and keeps everything else from the secrets and ~/.agentd", async () => {
    const home = miniHome("frontdoor")
    const repo = gitRepo(join(home, "polads"))
    writeFileSync(join(repo, "brief.md"), "## Goal\nA brief.\n")
    mkdirSync(join(repo, ".claude"), { recursive: true })
    writeFileSync(join(repo, ".claude", "project-config.json"), JSON.stringify({ tracker: { provider: "linear" } }))
    const agentd = join(home, ".agentd")
    // The two commands as install.sh writes them.
    mkdirSync(join(agentd, "bin"), { recursive: true })
    for (const [name, script] of [
      ["agentctl", join(RUNTIME, "src", "cli", "agentctl.ts")],
      ["trackerctl", join(PLUGIN, "scripts", "trackerctl.ts")],
    ]) {
      writeFileSync(join(agentd, "bin", name), `#!/bin/bash\nexec "${process.execPath}" --import "${LOADER}" "${script}" "$@"\n`)
      chmodSync(join(agentd, "bin", name), 0o755)
    }
    writeFileSync(join(agentd, "config.json"), JSON.stringify({ mini: "eve", repo: { path: repo }, pluginRoot: PLUGIN, slack: { allowedUsers: ["UNATE"] } }))
    writeFileSync(join(agentd, "PAUSE"), JSON.stringify({ at: "2026-09-24T12:00:00.000Z", reason: "a person" }))
    mkdirSync(join(home, ".front-door"), { recursive: true })
    // The template exactly as install.sh renders it, passed as agentd passes it.
    const settings = frontDoorSettings(home, repo)
    const linear = await startFakeLinear()
    try {
      const s = await session(
        [
          { name: "Bash", input: { command: "~/.agentd/bin/trackerctl ready --limit 3", description: "the queue" } },
          { name: "Bash", input: { command: "~/.agentd/bin/agentctl job submit --issue STEP-5", description: "queue a job" } },
          { name: "Bash", input: { command: "cat > ~/.front-door/reply.md <<'REPLY'\nThey wrote $(touch ~/pwned) here.\nREPLY", description: "a reply, as a file" } },
          // Quoted words, as the skills write them, keep it one simple command.
          { name: "Bash", input: { command: '~/.agentd/bin/agentctl slack post --channel "agents" --text-file ~/.front-door/reply.md', description: "post it" } },
          { name: "Read", input: { file_path: join(home, ".config", "linear", ".env") } },
          { name: "Read", input: { file_path: join(home, ".config", "agentd", "slack.env") } },
          { name: "Bash", input: { command: "cat ~/.config/linear/.env | wc -c", description: "the key" } },
          { name: "Bash", input: { command: "~/.agentd/bin/agentctl tick && cat ~/.config/linear/.env", description: "the key, after agentctl" } },
          { name: "Bash", input: { command: "~/.agentd/bin/trackerctl ready; cat ~/.config/linear/.env", description: "the key, after trackerctl" } },
          { name: "Bash", input: { command: '~/.agentd/bin/trackerctl create --title "$(cat ~/.config/linear/.env)"', description: "the key, as a title" } },
          { name: "Bash", input: { command: "~/.agentd/bin/trackerctl update STEP-1 --description-file ~/.config/linear/.env", description: "the key, as a brief" } },
          { name: "Bash", input: { command: `echo '{}' > ${join(agentd, "config.json")}`, description: "agentd's config" } },
          { name: "Bash", input: { command: "rm ~/.agentd/PAUSE", description: "a person's pause" } },
          { name: "Bash", input: { command: "~/.agentd/bin/agentctl resume", description: "lift the pause" } },
          { name: "Bash", input: { command: `curl -s -m 5 -o /dev/null -w '%{http_code}' ${linear.url}`, description: "the network" } },
          { name: "Bash", input: { command: `echo x > ${join(repo, "brief.md")}`, description: "the checkout" } },
        ],
        (api) => ({
          cwd: repo,
          env: { ...env(home, api), DEV_TASKS_LINEAR_ENDPOINT: linear.url, AGENTD_FRONT_DOOR: "1" },
          settings,
          settingSources: ["user", "project"],
          permissionMode: "default",
          maxTurns: 20,
        }),
      )
      const [ready, submit, , post, readKey, readSlack, catKey, afterAgentctl, afterTrackerctl, subst, secretBrief, config, pause, resume, network, checkout] =
        s.results
      // Outside the sandbox: the key read, a real round trip to Linear (here a fake on loopback), ~/.agentd written.
      expect(ready).toBe("[]")
      expect(submit).toMatch(/"issue":"STEP-5"/)
      expect(existsSync(join(agentd, "jobs", "pending"))).toBe(true)
      // People's words go through a file, as written: no shell expanded them.
      expect(post).toMatch(/"queued"/)
      expect(existsSync(join(home, "pwned"))).toBe(false)
      expect(readdirSync(join(agentd, "outbox", "new")).map((f) => JSON.parse(readFileSync(join(agentd, "outbox", "new", f), "utf8")).text)).toEqual([
        "They wrote $(touch ~/pwned) here.",
      ])
      // Inside it: no secret, no ~/.agentd, no checkout, no network.
      expect(readKey).toMatch(/denied by your permission settings/)
      expect(readSlack).toMatch(/denied by your permission settings/)
      expect(catKey).toMatch(/not permitted/i)
      // A compound command or a substitution is not one of the two commands: all of it runs sandboxed.
      // agentctl tick fails on its first write to ~/.agentd, so the cat never runs.
      expect(afterAgentctl).toMatch(/operation not permitted/i)
      expect(afterTrackerctl).toMatch(/could not be read/)
      expect(afterTrackerctl).toMatch(/cat: .*Operation not permitted/)
      expect(subst).toMatch(/Operation not permitted/)
      expect(subst).not.toMatch(/"id":/)
      expect(secretBrief).toMatch(/looks like a secrets file/)
      expect(config).toMatch(/not permitted|denied/i)
      expect(readFileSync(join(agentd, "config.json"), "utf8")).toContain('"mini":"eve"')
      expect(pause).toMatch(/not permitted|denied/i)
      expect(existsSync(join(agentd, "PAUSE"))).toBe(true)
      expect(resume).toMatch(/denied|for a person on the mini/)
      expect(network).toMatch(/\b000$/)
      expect(checkout).toMatch(/not permitted|denied/i)
      expect(readFileSync(join(repo, "brief.md"), "utf8")).toBe("## Goal\nA brief.\n")
      // Linear heard from the one ready that ran outside, with the key, and never saw the key in a body.
      expect(linear.requests).toHaveLength(1)
      expect(linear.requests[0].body).toContain("issues(")
      expect(linear.requests[0]).toMatchObject({ authorization: "lin_api_SESSIONTEST" })
      expect(linear.requests.map((r) => r.body).join("\n")).not.toMatch(/SESSIONTEST/)
      expect(s.results.join("\n")).not.toMatch(/SESSIONTEST/)
      expect(s.prompted).toEqual([])
    } finally {
      await linear.close()
    }
  }, 90_000)

  it("offers the front door no Monday tools on the agent profile, and still connects the plugin's server", async () => {
    const home = miniHome("mcp")
    const repo = gitRepo(join(home, "polads"))
    installMarketplace(home)
    const settings = frontDoorSettings(home, repo)
    const s = await session([], (api) => ({ cwd: repo, env: env(home, api), settings, settingSources: ["user", "project"], permissionMode: "default", maxTurns: 2 }))
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
