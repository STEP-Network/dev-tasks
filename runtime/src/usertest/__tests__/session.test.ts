import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../config.ts"
import type { QueryFn, SdkMessage } from "../../worker/session.ts"
import { USERTEST_RESULT_SCHEMA } from "../brief.ts"
import { CHROME_TOOLS, chromeMcpArgs, denyOffAllowlist, mcpInitProblem, mcpTool, runBrowserSession, userTestSdkOptions } from "../session.ts"

const ORIGINS = ["https://app-x.vercel.app", "https://staging.example.com"]
const deny = denyOffAllowlist(ORIGINS)
const call = (tool: string, input: unknown) => deny({ hook_event_name: "PreToolUse", tool_name: mcpTool(tool), tool_input: input })

describe("denyOffAllowlist", () => {
  it("lets the allowed origins open", async () => {
    expect(await call("navigate_page", { type: "url", url: "https://staging.example.com/da" })).toEqual({})
    expect(await call("new_page", { url: "https://app-x.vercel.app/" })).toEqual({})
  })

  it("lets back, forward and reload through without a URL", async () => {
    expect(await call("navigate_page", { type: "back" })).toEqual({})
  })

  it("denies everything else, look-alikes included", async () => {
    for (const url of ["https://staging.example.com.evil.example/", "http://staging.example.com/", "https://staging.example.com@evil.example/", "https://example.com/", "javascript:alert(1)"]) {
      const r = (await call("navigate_page", { type: "url", url })) as { hookSpecificOutput?: { permissionDecision?: string } }
      expect(r.hookSpecificOutput?.permissionDecision).toBe("deny")
      const n = (await call("new_page", { url })) as { hookSpecificOutput?: { permissionDecision?: string } }
      expect(n.hookSpecificOutput?.permissionDecision).toBe("deny")
    }
  })

  it("checks a navigate_page with no type, which the browser tool reads as a URL", async () => {
    const r = (await call("navigate_page", { url: "https://example.com/" })) as { hookSpecificOutput?: { permissionDecision?: string } }
    expect(r.hookSpecificOutput?.permissionDecision).toBe("deny")
  })

  it("refuses extra request headers, which the test never needs", async () => {
    const r = (await call("emulate", { extraHttpHeaders: '{"x-forwarded-for":"1.2.3.4"}' })) as { hookSpecificOutput?: { permissionDecision?: string } }
    expect(r.hookSpecificOutput?.permissionDecision).toBe("deny")
    expect(await call("emulate", { viewport: "390x844x3,mobile,touch" })).toEqual({})
  })

  it("ignores tools that do not navigate", async () => {
    expect(await call("click", { uid: "1" })).toEqual({})
  })
})

describe("chromeMcpArgs", () => {
  it("connects to our Chrome, allowlists, and turns off scripts and usage statistics", () => {
    const args = chromeMcpArgs({ bin: "/mcp.js", port: 9333, patterns: ["https://s.example.com/*"], shotsDir: "/shots" })
    expect(args).toEqual([
      "/mcp.js",
      "--browserUrl=http://127.0.0.1:9333",
      "--allowedUrlPattern=https://s.example.com/*",
      "--javascriptEvaluation=false",
      "--usageStatistics=false",
      "--performanceCrux=false",
      "--redactNetworkHeaders=true",
      "--categoryPerformance=false",
      "--categoryMemory=false",
      "--no-page-id-routing",
      "--workspace=/shots",
    ])
  })
})

describe("userTestSdkOptions", () => {
  const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["U0EXAMPLE"] } })
  const o = userTestSdkOptions({ config, cwd: "/run", mcpBin: "/mcp.js", port: 9333, patterns: [], origins: ORIGINS, shotsDir: "/shots", env: {}, abortController: new AbortController() })

  it("allows only the browser tools, never script evaluation or file upload", () => {
    expect(o.allowedTools).toEqual(CHROME_TOOLS.map(mcpTool))
    expect(CHROME_TOOLS).not.toContain("evaluate_script")
    expect(CHROME_TOOLS).not.toContain("upload_file")
  })

  it("takes away the shell, files, the web, agents and skills, and loads no settings or other MCP", () => {
    for (const tool of ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch", "Agent", "Task", "Skill"]) expect(o.disallowedTools).toContain(tool)
    expect(o.settingSources).toEqual([])
    expect(o.strictMcpConfig).toBe(true)
    expect(Object.keys(o.mcpServers ?? {})).toEqual(["chrome-devtools"])
  })

  it("denies any tool it was not given, and runs the allowlist before each browser tool", async () => {
    const signal = new AbortController().signal
    expect(await o.canUseTool!("Bash", {}, { signal, suggestions: [] } as never)).toMatchObject({ behavior: "deny" })
    const hook = o.hooks?.PreToolUse?.[0]?.hooks[0]
    const r = await hook!({ hook_event_name: "PreToolUse", tool_name: mcpTool("navigate_page"), tool_input: { type: "url", url: "https://example.com/" } } as never, undefined, { signal })
    expect(r).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
  })

  it("starts the browser tool with an empty environment but PATH, and a home and temp folder in the run, and asks for the report's shape", () => {
    const server = o.mcpServers?.["chrome-devtools"] as { command?: string; args?: string[]; env?: Record<string, string> }
    // The CLI would hand a stdio server its own environment: env -i clears it.
    expect(server.command).toBe("/usr/bin/env")
    expect(server.args?.slice(0, 7)).toEqual(["-i", `PATH=${process.env.PATH ?? ""}`, "HOME=/run", "TMPDIR=/run/tmp", "CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1", process.execPath, "/mcp.js"])
    expect(server.env).toBeUndefined()
    expect(o.outputFormat).toEqual({ type: "json_schema", schema: USERTEST_RESULT_SCHEMA })
  })
})

describe("mcpInitProblem", () => {
  it("accepts a connected or starting browser tool, and stops on a failed or missing one", () => {
    expect(mcpInitProblem({ type: "system", subtype: "init", mcp_servers: [{ name: "chrome-devtools", status: "connected" }] })).toBeNull()
    expect(mcpInitProblem({ type: "system", subtype: "init", mcp_servers: [{ name: "chrome-devtools", status: "failed" }] })).toMatch(/did not start/)
    expect(mcpInitProblem({ type: "system", subtype: "init", mcp_servers: [] })).toMatch(/did not start/)
  })

  it("lets a browser tool that is still starting through", () => {
    expect(mcpInitProblem({ type: "system", subtype: "init", mcp_servers: [{ name: "chrome-devtools", status: "pending" }] })).toBeNull()
    expect(mcpInitProblem({ type: "system", subtype: "init", mcp_servers: [{ name: "other", status: "connected" }] })).toBe("the browser tool did not start (missing)")
  })
})

describe("runBrowserSession", () => {
  const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["U0EXAMPLE"] } })
  const INIT: SdkMessage = { type: "system", subtype: "init", apiKeySource: "none", plugins: [], mcp_servers: [{ name: "chrome-devtools", status: "connected" }] }
  const done = (over: Record<string, unknown> = {}): SdkMessage => ({ type: "result", subtype: "success", total_cost_usd: 0.8, ...over })
  const queryOf = (messages: SdkMessage[]): QueryFn =>
    async function* () {
      for (const m of messages) yield m
    }
  const run = (messages: SdkMessage[]) =>
    runBrowserSession({ config, query: queryOf(messages), mcpBin: "/mcp.js" }, { brief: "go", cwd: mkdtempSync(join(tmpdir(), "ut-session-")), port: 9333, origins: ORIGINS, patterns: [], shotsDir: "/shots", env: {} })
  const report = { status: "pass", summary: "Fine.", journeys: [], findings: [], screenshots: [], notWalked: [] }

  it("makes the browser tool's temp folder in the run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ut-session-"))
    await runBrowserSession({ config, query: queryOf([INIT, done({ structured_output: report })]), mcpBin: "/mcp.js" }, { brief: "go", cwd, port: 9333, origins: ORIGINS, patterns: [], shotsDir: "/shots", env: {} })
    expect(existsSync(join(cwd, "tmp"))).toBe(true)
  })

  it("returns the report and its cost when the session ends with a readable one", async () => {
    expect(await run([INIT, done({ structured_output: report })])).toEqual({ result: report, costUsd: 0.8, problem: null })
  })

  it("says in plain words why there is no report", async () => {
    expect((await run([{ ...INIT, mcp_servers: [{ name: "chrome-devtools", status: "failed" }] }, done({ structured_output: report })])).problem).toBe("the browser tool did not start (failed)")
    expect((await run([{ ...INIT, plugins: [{ name: "dev-tasks" }] }, done({ structured_output: report })])).problem).toBe("the browser test started with the dev-tasks plugin loaded, which it must not")
    expect((await run([INIT, done({ subtype: "error_max_turns", is_error: true })])).problem).toBe("the browser test ended on an error")
    expect((await run([INIT, done({ structured_output: { status: "pass" } })])).problem).toBe("the browser test ended without a readable report")
  })
})
