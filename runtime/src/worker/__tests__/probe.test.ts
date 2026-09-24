import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../config.ts"
import { fakeExec } from "../../__tests__/fakes.ts"
import { PROBE_PROMPT, probeHooks, probeVerdict } from "../probe.ts"
import type { QueryFn, SdkMessage } from "../run.ts"

const INIT: SdkMessage = { type: "system", subtype: "init", apiKeySource: "none", plugins: [{ name: "dev-tasks", path: "/p" }] }
const PLUGIN_BLOCK: SdkMessage = { type: "user", message: { content: [{ type: "tool_result", content: "BLOCKED: Destructive command detected: 'git reset --hard'" }] } }
const WORKER_BLOCK: SdkMessage = { type: "user", message: { content: [{ type: "tool_result", content: "Workers never push. The launcher pushes your commits after you report." }] } }

describe("probeVerdict", () => {
  it("finds both block messages, the loaded plugins and what the session bills in its messages", () => {
    expect(probeVerdict([INIT, PLUGIN_BLOCK, WORKER_BLOCK])).toEqual({ pluginHookFired: true, workerGuardFired: true, loadedPlugins: ["dev-tasks"], apiKeySource: "none" })
  })

  it("reports what did not fire", () => {
    expect(probeVerdict([{ type: "result", subtype: "success" }])).toEqual({ pluginHookFired: false, workerGuardFired: false, loadedPlugins: [], apiKeySource: null })
  })
})

describe("probeHooks", () => {
  const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/Users/eve/polads" }, pluginRoot: "/Users/eve/dev-tasks/plugin", slack: { allowedUsers: ["UNATE"] } })

  it("runs the two forbidden commands in a throwaway repository, capped, with no report schema, and reads the verdict", async () => {
    const f = fakeExec()
    const seen: Array<{ prompt: string; options: Options }> = []
    const query: QueryFn = (args) => {
      seen.push(args)
      return (async function* () {
        yield INIT
        yield PLUGIN_BLOCK
        yield WORKER_BLOCK
      })()
    }
    expect(await probeHooks({ query, config, exec: f.exec, claudeToken: null, home: "/Users/eve" })).toEqual({
      pluginHookFired: true, workerGuardFired: true, loadedPlugins: ["dev-tasks"], apiKeySource: "none",
    })
    expect(f.lines()[0]).toMatch(/^git --no-replace-objects -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false init -b staging \S*hook-probe-/)
    expect(seen[0].prompt).toBe(PROBE_PROMPT)
    // The worker's own settings, the main checkout's project config included, capped.
    expect(seen[0].options).toMatchObject({ maxTurns: 8, maxBudgetUsd: 1, cwd: expect.stringMatching(/hook-probe-/), projectConfigRoot: "/Users/eve/polads" })
    expect(seen[0].options.outputFormat).toBeUndefined()
  })

  it("reports nothing fired when the session fails", async () => {
    const query: QueryFn = () =>
      (async function* () {
        yield* []
        throw new Error("spawn claude ENOENT")
      })()
    expect(await probeHooks({ query, config, exec: fakeExec().exec, claudeToken: null, home: "/Users/eve" })).toEqual({
      pluginHookFired: false, workerGuardFired: false, loadedPlugins: [], apiKeySource: null,
    })
  })
})
