import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../config.ts"
import type { QueryFn } from "../../worker/run.ts"
import { probeWorkerHooks } from "../hooks-probe.ts"

const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/Users/eve/polads" }, pluginRoot: "/Users/eve/dev-tasks/plugin", slack: { allowedUsers: ["UNATE"] } })
const BINARY = "/Users/eve/dev-tasks/runtime/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"
const PLUGIN_BLOCK = "PreToolUse:Bash hook error: [/Users/eve/dev-tasks/plugin/hooks/bash-guard.sh]: BLOCKED: Destructive command detected: 'rm -rf'"
const REFUSED = [
  ...Array(6).fill(PLUGIN_BLOCK),
  "Workers never open or merge PRs. The launcher opens the PR and arms auto-merge.",
  "Workers never read or write ~/.config or .env files: this machine's secrets live there, and no task needs them.",
]

/** A session that answers each scripted command with the given result, as the binary would. */
function session(results: string[], plugins: unknown = [{ name: "dev-tasks", path: config.pluginRoot }]) {
  const seen: Options[] = []
  const query: QueryFn = (args) => {
    seen.push(args.options)
    return (async function* () {
      yield { type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY", plugins }
      for (const content of results) yield { type: "user", message: { content: [{ type: "tool_result", content }] } }
    })()
  }
  return { query, seen }
}

describe("probeWorkerHooks", () => {
  it("runs the worker's own options on the given binary, against the fake API, in a throwaway checkout and worktree", async () => {
    const s = session(REFUSED)
    const probe = await probeWorkerHooks({ query: s.query, config, claudePath: BINARY, now: () => new Date("2026-09-24T20:00:00.000Z") })
    expect(probe).toMatchObject({ at: "2026-09-24T20:00:00.000Z", kind: "scripted", ok: true, pluginHookFired: true, workerGuardFired: true, claudePath: BINARY })
    const o = s.seen[0]
    expect(o.pathToClaudeCodeExecutable).toBe(BINARY)
    expect(o.cwd).toMatch(/hooks-probe-[^/]+\/worktrees\/STEP-0-probe$/)
    // The worker's settings, read from the throwaway main checkout, never the mini's own.
    expect(o.projectConfigRoot).toMatch(/hooks-probe-[^/]+\/polads$/)
    expect(o.plugins).toEqual([{ type: "local", path: config.pluginRoot, skipMcpDiscovery: true }])
    expect(o.hooks?.PreToolUse?.length).toBeGreaterThan(0)
    expect(o.sandbox?.enabled).toBe(true)
    expect(o.outputFormat).toBeUndefined()
    // No login: a key only the loopback fake sees.
    expect(o.env).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-api03-PROBEONLY", ANTHROPIC_BASE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), DEV_TASKS_PROFILE: "agent" })
    expect(o.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN")
  })

  it("reports a guard as fired only when it refused every command it covers", async () => {
    const one = [...REFUSED]
    one[2] = "Exit code 128\nfatal: Unable to create '.git/index.lock': Operation not permitted"
    const probe = await probeWorkerHooks({ query: session(one).query, config, claudePath: BINARY, now: () => new Date() })
    expect(probe).toMatchObject({ ok: false, pluginHookFired: false, workerGuardFired: true })
    expect(probe.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["the plugin's guard refuses git clean -f"])
    const noWorker = await probeWorkerHooks({ query: session(REFUSED.slice(0, 7)).query, config, claudePath: BINARY, now: () => new Date() })
    expect(noWorker).toMatchObject({ ok: false, pluginHookFired: true, workerGuardFired: false })
  })

  it("fails when dev-tasks did not load exactly once from pluginRoot, though every guard fired", async () => {
    for (const plugins of [
      [{ name: "dev-tasks", path: config.pluginRoot }, { name: "dev-tasks", path: "/cache/dev-tasks" }],
      [{ name: "dev-tasks", path: "/cache/dev-tasks" }],
      [],
    ]) {
      const probe = await probeWorkerHooks({ query: session(REFUSED, plugins).query, config, claudePath: BINARY, now: () => new Date() })
      expect(probe, JSON.stringify(plugins)).toMatchObject({ ok: false, pluginHookFired: true, workerGuardFired: true })
      expect(probe.checks.find((c) => !c.ok)?.name).toBe("dev-tasks loaded once, from pluginRoot")
    }
  })

  it("fails on a secret in anything a command returned", async () => {
    const leaked = [...REFUSED]
    leaked[7] = "# PROBE_SECRET_4b8e2d\nLINEAR_API_KEY="
    const probe = await probeWorkerHooks({ query: session(leaked).query, config, claudePath: BINARY, now: () => new Date() })
    expect(probe.ok).toBe(false)
    expect(probe.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["the worker's guard refuses reading ~/.config", "no secret reached the session"])
  })
})
