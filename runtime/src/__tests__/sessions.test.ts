/**
 * What a front-door session and a worker session really load and may do,
 * asked of the Claude Code binary the SDK ships (not a model): each session
 * runs in a throwaway HOME against local fakes of the Messages API and
 * Linear (cli/probe-fakes.ts), so nothing leaves the machine and nothing is
 * billed. A Claude Code or SDK upgrade that changes any of it turns this red.
 * The checks a setup on Eve's mini needed (2026-09-24):
 *   - the front door's sandbox holds (cli/sandbox-probe.ts, which a person
 *     also runs on the mini as agentctl probe-sandbox): agentctl and
 *     trackerctl run outside it and reach Linear (a sandboxed Node fetch
 *     cannot: it ignores the sandbox's proxy), and every other command, one
 *     joined to them or with variables set in front of them included, gets
 *     no secret, no network, no ~/.agentd and no checkout (decision 8)
 *   - the front door on the agent profile is offered no Monday tools, and its
 *     plugin's server still connects
 *   - a worker loads the dev-tasks plugin exactly once, from pluginRoot, with
 *     the marketplace copy the front door uses installed beside it
 *   - the plugin's own guard fires in a worker, on every command form it
 *     covers (agentctl probe-hooks failed on the mini while hooks.json joined
 *     several rules in one `if` with `|`, which never matches)
 *   - agentctl probe-hooks --scripted, the free proof of that on a mini,
 *     passes on the SDK's binary and fails on hooks that do not fire
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
import { sdkOptions, type QueryFn } from "../worker/run.ts"
import { startFakeApi, type ToolCall } from "../cli/probe-fakes.ts"
import { probeFrontDoorSandbox } from "../cli/sandbox-probe.ts"
import { probeVerdict } from "../worker/probe.ts"
import { probeWorkerHooks, workerClaudePath } from "../cli/hooks-probe.ts"

const RUNTIME = fileURLToPath(new URL("../..", import.meta.url))
const CHECKOUT = dirname(RUNTIME)
const PLUGIN = join(CHECKOUT, "plugin")

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
  const cache = join(plugins, "cache", "dev-tasks-marketplace", "dev-tasks", "1.2.1")
  cpSync(PLUGIN, cache, { recursive: true, filter: (src) => !src.includes("node_modules") })
  writeFileSync(join(plugins, "known_marketplaces.json"), JSON.stringify({ "dev-tasks-marketplace": { source: { source: "directory", path: CHECKOUT }, installLocation: CHECKOUT, lastUpdated: now } }))
  writeFileSync(
    join(plugins, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "dev-tasks@dev-tasks-marketplace": [{ scope: "user", installPath: cache, version: "1.2.1", installedAt: now, lastUpdated: now }] } }),
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
  /** The tool results of a subagent's own calls (a message with a parent_tool_use_id). */
  subagentResults: string[]
  prompted: string[]
  /** Every message, as agentctl probe-hooks reads them. */
  messages: unknown[]
}

async function session(script: ToolCall[], options: (api: string) => Options, subagents: Record<string, ToolCall[]> = {}): Promise<Session> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk")
  const api = await startFakeApi(script, subagents)
  const out: Session = { init: null, results: [], subagentResults: [], prompted: [], messages: [] }
  const o = options(api.url)
  // Nobody is there to answer a prompt: record it and refuse, as the front door's --permission-prompts none would.
  o.canUseTool ??= async (name, input) => {
    out.prompted.push(`${name} ${JSON.stringify(input)}`)
    return { behavior: "deny", message: "no prompts in this test" }
  }
  try {
    for await (const m of query({ prompt: "go", options: o })) {
      out.messages.push(m)
      if (m.type === "system" && m.subtype === "init") out.init = m as unknown as Session["init"]
      if (m.type === "user" && Array.isArray(m.message.content)) {
        for (const c of m.message.content as Array<{ type: string; content?: unknown }>) {
          if (c.type !== "tool_result") continue
          const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content)
          out.results.push(text)
          if (m.parent_tool_use_id) out.subagentResults.push(text)
        }
      }
    }
  } finally {
    await api.close()
  }
  return out
}

describe.skipIf(!binaryAvailable())("sessions, as the Claude Code binary runs them", () => {
  it("holds the front door's sandbox: agentctl probe-sandbox passes on the SDK's own binary", async () => {
    // The same probe a person runs on the mini with the front door's binary
    // (sandbox-probe.ts): the two commands reach Linear and ~/.agentd outside
    // the sandbox, and nothing joined to them, set in front of them or run
    // beside them reaches a secret, the network, ~/.agentd or the checkout.
    const { query } = await import("@anthropic-ai/claude-agent-sdk")
    const probe = await probeFrontDoorSandbox({ query: query as unknown as QueryFn, runtime: RUNTIME, plugin: PLUGIN, now: () => new Date() })
    expect(probe.checks.filter((c) => !c.ok)).toEqual([])
    expect(probe.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "trackerctl reaches Linear, outside the sandbox",
        "agentctl joined with && runs sandboxed",
        "trackerctl joined with ; runs sandboxed",
        "trackerctl piped runs sandboxed",
        "a substitution runs sandboxed",
        "NODE_OPTIONS in front of agentctl reaches nothing",
        "a Linear endpoint and key in front of agentctl reach nothing",
        "no injected code ran outside the sandbox",
        "no secret reached the session",
      ]),
    )
    expect(probe.ok).toBe(true)
  }, 120_000)

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

  it("fires the plugin's own guard in a worker, on every command form it covers, as agentctl probe-hooks checks", async () => {
    const home = miniHome("guard")
    const repo = gitRepo(join(home, "polads"))
    const worktree = gitRepo(join(home, "worktree"))
    const config = ConfigSchema.parse({ mini: "eve", repo: { path: repo }, pluginRoot: PLUGIN, slack: { allowedUsers: ["UNATE"] } })
    // One per `if` rule gate (a) acts on, a compound command, and a push, which
    // gate (c) refuses first here: this throwaway repository has no pre-push marker.
    const commands: Array<[string, string]> = [
      ["git reset --hard HEAD", "Destructive command detected: 'git reset --hard'"],
      ["rm -rf build", "Destructive command detected: 'rm -rf'"],
      ["git clean -fd", "Destructive command detected: 'git clean -f'"],
      ["git branch -D old", "Destructive command detected: 'git branch -D'"],
      ["git checkout .", "Destructive command detected: 'git checkout \\.'"],
      ["git status && git reset --hard HEAD", "Destructive command detected: 'git reset --hard'"],
      ["git push --force origin feature", "Destructive command detected: 'git push --force'"],
      ["git push origin staging", "hooks/bash-guard.sh]: BLOCKED: "],
    ]
    const s = await session(
      commands.map(([command]) => ({ name: "Bash", input: { command, description: "guard" } })),
      (api) => {
        const o = sdkOptions({ config, cwd: worktree, model: "sonnet", abortController: new AbortController(), rules: "test", pnpmStore: null, env: {}, home })
        o.env = { ...env(home, api), DEV_TASKS_PROFILE: "agent" }
        delete o.outputFormat
        return o
      },
    )
    expect(s.results).toHaveLength(commands.length)
    commands.forEach(([command, block], i) => expect(s.results[i], command).toContain(block))
    expect(probeVerdict(s.messages)).toMatchObject({ pluginHookFired: true, loadedPlugins: expect.arrayContaining(["dev-tasks"]) })
  }, 120_000)

  describe("worker.fanOut (STEP-3367): what a subagent, a teammate and a workflow's agent may do", () => {
    const MARK = "FANOUT_PROBE_7c1e"
    const bash = (command: string): ToolCall => ({ name: "Bash", input: { command, description: "probe" } })
    function workerOptions(home: string, repo: string, worktree: string, fanOut: boolean, asked: string[] = []) {
      return (api: string) => {
        const config = ConfigSchema.parse({ mini: "eve", repo: { path: repo }, pluginRoot: PLUGIN, slack: { allowedUsers: ["UNATE"] }, worker: { fanOut } })
        const o = sdkOptions({ config, cwd: worktree, model: "sonnet", abortController: new AbortController(), rules: "test", pnpmStore: null, env: {}, home })
        o.env = { ...o.env, ...env(home, api), DEV_TASKS_PROFILE: "agent" }
        delete o.outputFormat
        const inner = o.canUseTool!
        o.canUseTool = async (name, input, opts) => {
          asked.push(name)
          return inner(name, input, opts)
        }
        return o
      }
    }

    /**
     * A worker whose main loop hands MARK to a subagent, a teammate or a
     * workflow's agent, then waits for it. What that agent tries: a write
     * inside the worktree; a write outside it and a read of ~/.config no
     * guard can see (the sandbox); ~/.config and gh pr create (the worker's
     * own guard, an in-process SDK hook); git reset --hard and a push to
     * main (the plugin's guard); and SendMessage to a stranger (refused) and
     * to "main", its own lead (allowed).
     */
    async function fannedOut(start: (mark: string) => ToolCall) {
      const home = miniHome("fanout")
      const repo = gitRepo(join(home, "polads"))
      const worktree = gitRepo(join(home, "worktree"))
      const asked: string[] = []
      const s = await session(
        // The main loop waits for a background agent: a plain sleep, which the sandbox allows without a prompt.
        [start(MARK), bash("sleep 10")],
        workerOptions(home, repo, worktree, true, asked),
        {
          [MARK]: [
            bash(`touch ${worktree}/inside.txt && echo WROTE_INSIDE`),
            bash(`touch ${home}/escaped.txt; echo AFTER_ESCAPE`),
            // A read no guard can see: the path is base64 in a script the agent writes and runs as a plain command.
            {
              name: "Write",
              input: {
                file_path: join(worktree, "read.py"),
                content: "import base64, os\nprint(open(os.path.expanduser('~') + base64.b64decode('Ly5jb25maWcvbGluZWFyLy5lbnY=').decode()).read())\n",
              },
            },
            bash("python3 read.py; echo AFTER_READ"),
            bash("cat ~/.config/linear/.env"),
            bash("git reset --hard HEAD"),
            bash("git push origin main"),
            bash("gh pr create --fill"),
            { name: "SendMessage", input: { to: "wt-stranger [a1b2c3]", summary: "probe", message: "hello" } },
            { name: "SendMessage", input: { to: "main", summary: "probe", message: "done" } },
          ],
        },
      )
      // A workflow's agents stream nothing to the SDK: their results are in the transcript its launch names.
      const transcript = s.results.join("\n").match(/Transcript dir: (\S+)/)?.[1]
      const results = transcript ? transcriptResults(transcript) : s.subagentResults
      return { results, asked, inside: existsSync(join(worktree, "inside.txt")), escaped: existsSync(join(home, "escaped.txt")), all: s.results }
    }

    function transcriptResults(dir: string): string[] {
      const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f))
      return files.flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            const m = JSON.parse(line) as { message?: { content?: unknown } }
            const content = Array.isArray(m.message?.content) ? (m.message!.content as Array<{ type?: string; content?: unknown }>) : []
            return content.filter((c) => c.type === "tool_result").map((c) => (typeof c.content === "string" ? c.content : JSON.stringify(c.content)))
          }),
      )
    }

    function held(r: Awaited<ReturnType<typeof fannedOut>>) {
      expect(r.results[0]).toContain("WROTE_INSIDE")
      expect(r.results[1]).toContain("Operation not permitted")
      expect(r.results[3]).toMatch(/Operation not permitted|PermissionError/)
      expect(r.results[3]).toContain("AFTER_READ")
      expect(r.results[4]).toContain("Workers never read or write ~/.config")
      expect(r.results[5]).toContain("Destructive command detected: 'git reset --hard'")
      expect(r.results[6]).toContain("hooks/bash-guard.sh]: BLOCKED: ")
      expect(r.results[7]).toContain("Workers never open or merge PRs")
      expect(r.results[8]).toContain("SendMessage reaches only the subagents and teammates this worker started")
      expect(r.results[9]).not.toContain("SendMessage reaches only")
      expect([r.inside, r.escaped]).toEqual([true, false])
      // No prompt was needed or asked: the Workflow tool is allowed, the rest is the sandbox's.
      expect(r.asked).toEqual([])
      expect(r.all.join("\n")).not.toContain("lin_api_SESSIONTEST")
    }

    it("holds a subagent, in the foreground and in the background", async () => {
      held(await fannedOut((m) => ({ name: "Agent", input: { description: "probe", prompt: m, subagent_type: "general-purpose", run_in_background: false } })))
      held(await fannedOut((m) => ({ name: "Agent", input: { description: "probe", prompt: m, subagent_type: "general-purpose" } })))
    }, 180_000)

    it("holds a named teammate: agent teams run in this process", async () => {
      held(await fannedOut((m) => ({ name: "Agent", input: { description: "probe", prompt: m, subagent_type: "general-purpose", name: "mate" } })))
    }, 120_000)

    it("holds a dynamic workflow's agents, and runs the Workflow tool without a prompt", async () => {
      const script = `export const meta = { name: "probe", description: "probe", phases: [] }\nawait agent(${JSON.stringify(MARK)})\n`
      held(await fannedOut(() => ({ name: "Workflow", input: { script } })))
    }, 120_000)

    it("refuses a subagent a worktree of its own or the cloud (isolation), and the worker a peer it did not start", async () => {
      const home = miniHome("isolation")
      const repo = gitRepo(join(home, "polads"))
      const worktree = gitRepo(join(home, "worktree"))
      const asked: string[] = []
      const s = await session(
        [
          { name: "Agent", input: { description: "probe", prompt: MARK, subagent_type: "general-purpose", isolation: "worktree", run_in_background: false } },
          { name: "Agent", input: { description: "probe", prompt: MARK, subagent_type: "general-purpose", isolation: "remote" } },
          { name: "SendMessage", input: { to: "wt-front-door [9f9f9f]", summary: "probe", message: "hello" } },
        ],
        workerOptions(home, repo, worktree, true, asked),
        { [MARK]: [bash("pwd; echo ISOLATED_RAN")] },
      )
      expect(s.results[0]).toContain("isolation (worktree) is refused")
      expect(s.results[1]).toContain("isolation (remote) is refused")
      expect(s.results[2]).toContain("SendMessage reaches only the subagents and teammates this worker started")
      expect(s.results.join("\n")).not.toContain("ISOLATED_RAN")
      expect(existsSync(join(repo, ".claude", "worktrees"))).toBe(false)
      expect(asked).toEqual([])
    }, 120_000)

    it("delivers no other session's message to a worker: crossSessionInbound refuse, where accept would", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk")
      // A peer on this machine lists the sessions it can reach, then messages the worker by the name it found.
      const peer = async (home: string) => {
        const api = await startFakeApi([
          { name: "ListAgents", input: {} },
          { name: "SendMessage", input: (last) => ({ to: last.match(/Peer sessions[^\n]*\n\s*(\S+ \[[a-z0-9]+\])/)?.[1] ?? "nobody", summary: "probe", message: "PEER_PROBE_MSG_77" }) },
        ])
        const cwd = join(home, "peer")
        mkdirSync(cwd, { recursive: true })
        const results: string[] = []
        try {
          for await (const m of query({ prompt: "go", options: { cwd, env: env(home, api.url), permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true, maxTurns: 5 } })) {
            if (m.type === "user" && Array.isArray(m.message.content)) for (const c of m.message.content as Array<{ type: string; content?: unknown }>) if (c.type === "tool_result") results.push(JSON.stringify(c.content))
          }
        } finally {
          await api.close()
        }
        return results
      }
      const reached = async (inbound: "accept" | "refuse" | null) => {
        const home = miniHome("peer")
        const repo = gitRepo(join(home, "polads"))
        const worktree = gitRepo(join(home, "worktree"))
        const api = await startFakeApi([bash("sleep 20")])
        const o = workerOptions(home, repo, worktree, false)(api.url)
        if (inbound) (o.settings as { crossSessionInbound?: string }).crossSessionInbound = inbound
        const worker = (async () => {
          for await (const _ of query({ prompt: "go", options: o })) {
            // Read to the end.
          }
        })()
        await new Promise((resolve) => setTimeout(resolve, 5000))
        const sent = await peer(home)
        await worker
        await api.close()
        return { sent: sent.join("\n"), reached: api.bodies.some((b) => b.includes("PEER_PROBE_MSG_77")) }
      }
      // The control: with accept, the peer's message reaches the worker's model.
      const accept = await reached("accept")
      expect(accept.sent).toContain("success")
      expect(accept.reached).toBe(true)
      // The worker's own options: refused.
      const own = await reached(null)
      expect(own.sent).toContain("success")
      expect(own.reached).toBe(false)
    }, 180_000)

    it("offers a worker fan-out only on worker.fanOut, and never another session's names, a later prompt, another worktree, the web or skills", async () => {
      const home = miniHome("tools")
      const repo = gitRepo(join(home, "polads"))
      const worktree = gitRepo(join(home, "worktree"))
      const tools = async (fanOut: boolean) => (await session([], workerOptions(home, repo, worktree, fanOut))).init?.tools ?? []
      const never = ["ListAgents", "CronCreate", "ScheduleWakeup", "EnterWorktree", "ExitWorktree", "WebFetch", "WebSearch", "Skill"]
      const off = await tools(false)
      for (const tool of ["Task", "Agent", "Workflow", "SendMessage", ...never]) expect(off, tool).not.toContain(tool)
      const on = await tools(true)
      for (const tool of ["Task", "Workflow", "SendMessage"]) expect(on, tool).toContain(tool)
      for (const tool of never) expect(on, tool).not.toContain(tool)
    }, 120_000)
  })

  it("proves the worker's hooks for free: agentctl probe-hooks --scripted passes on the binary workers run", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk")
    const binary = workerClaudePath()
    expect(binary).toMatch(/claude-agent-sdk-darwin-[a-z0-9]+\/claude$/)
    const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/unused" }, pluginRoot: PLUGIN, slack: { allowedUsers: ["UNATE"] } })
    const probe = await probeWorkerHooks({ query: query as unknown as QueryFn, config, claudePath: binary!, now: () => new Date() })
    expect(probe.checks.filter((c) => !c.ok)).toEqual([])
    expect(probe).toMatchObject({ kind: "scripted", ok: true, pluginHookFired: true, workerGuardFired: true, claudePath: binary })
  }, 120_000)

  it("fails agentctl probe-hooks --scripted on the hooks.json Eve's mini had, whose guard never fired", async () => {
    // The plugin as it was before 1.2.1: bash-guard's rules joined with `|` in one `if`.
    // (Since 1.3.9 it runs on every Bash command, with no `if`: the rules are the ones it had then.)
    const OLD_RULES = ["* --no-verify *", "*--force*", "rm -rf *", "git reset --hard *", "git checkout .", "git checkout -- *", "git clean -f*", "git branch -D*", "git commit *", "git push *"]
    const old = realpathSync(mkdtempSync(join(tmpdir(), "old-plugin-")))
    for (const part of [".claude-plugin", "hooks"]) cpSync(join(PLUGIN, part), join(old, part), { recursive: true })
    const hooksJson = join(old, "hooks", "hooks.json")
    const hooks = JSON.parse(readFileSync(hooksJson, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string; if?: string }> }>> }
    for (const group of hooks.hooks.PreToolUse) {
      const guard = group.hooks.filter((h) => h.command.endsWith("/bash-guard.sh"))
      if (!guard.length) continue
      group.hooks = [...group.hooks.filter((h) => !guard.includes(h)), { ...guard[0], if: `Bash(${OLD_RULES.join("|")})` }]
    }
    writeFileSync(hooksJson, JSON.stringify(hooks))
    const { query } = await import("@anthropic-ai/claude-agent-sdk")
    const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/unused" }, pluginRoot: old, slack: { allowedUsers: ["UNATE"] } })
    const probe = await probeWorkerHooks({ query: query as unknown as QueryFn, config, claudePath: workerClaudePath()!, now: () => new Date() })
    expect(probe).toMatchObject({ ok: false, pluginHookFired: false, workerGuardFired: true })
  }, 120_000)
})
