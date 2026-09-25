/**
 * One browser session (WS5): a separate Agent SDK session whose only tools
 * are chrome-devtools-mcp's, connected to the Chrome the runtime launched.
 * Three things keep the browser on the allowlist: the MCP's own
 * --allowedUrlPattern (which also blocks requests a page makes), a
 * PreToolUse hook that refuses navigate_page and new_page off the list and
 * says why, and no script evaluation (--javascriptEvaluation=false). No
 * shell, no files, no web tools, no settings and no other MCP server.
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { AgentConfig } from "../config.ts"
import { runSession, type QueryFn, type SdkMessage } from "../worker/session.ts"
import { USERTEST_RESULT_SCHEMA, USERTEST_SYSTEM } from "./brief.ts"
import { parseUserTestResult, type UserTestResult } from "./result.ts"
import { isAllowedNavigation } from "./target.ts"

export const MCP_SERVER = "chrome-devtools"

/** evaluate_script, upload_file, heap and performance tools, extensions and PWAs are left out on purpose. */
export const CHROME_TOOLS = [
  "navigate_page",
  "new_page",
  "list_pages",
  "select_page",
  "close_page",
  "click",
  "hover",
  "fill",
  "fill_form",
  "type_text",
  "press_key",
  "drag",
  "handle_dialog",
  "wait_for",
  "take_screenshot",
  "take_snapshot",
  "resize_page",
  "emulate",
  "list_console_messages",
  "get_console_message",
  "list_network_requests",
  "get_network_request",
  "lighthouse_audit",
] as const

export const mcpTool = (name: string) => `mcp__${MCP_SERVER}__${name}`
const NAVIGATING = new Set([mcpTool("navigate_page"), mcpTool("new_page")])

export function chromeMcpArgs(o: { bin: string; port: number; patterns: readonly string[]; shotsDir: string }): string[] {
  return [
    o.bin,
    `--browserUrl=http://127.0.0.1:${o.port}`,
    ...o.patterns.map((p) => `--allowedUrlPattern=${p}`),
    "--javascriptEvaluation=false",
    "--usageStatistics=false",
    "--performanceCrux=false",
    "--redactNetworkHeaders=true",
    `--workspace=${o.shotsDir}`,
  ]
}

interface HookInputLike {
  hook_event_name: string
  tool_name?: string
  tool_input?: unknown
}

export function denyOffAllowlist(origins: readonly string[]) {
  return async (input: HookInputLike) => {
    if (input.hook_event_name !== "PreToolUse" || !input.tool_name || !NAVIGATING.has(input.tool_name)) return {}
    const args = (input.tool_input ?? {}) as { type?: unknown; url?: unknown }
    if (input.tool_name === mcpTool("navigate_page") && args.type !== undefined && args.type !== "url") return {}
    if (isAllowedNavigation(args.url, origins)) return {}
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: `Only ${origins.join(" and ")} may be opened in this test.`,
      },
    }
  }
}

export function userTestSdkOptions(o: {
  config: AgentConfig
  cwd: string
  mcpBin: string
  port: number
  patterns: readonly string[]
  origins: readonly string[]
  shotsDir: string
  env: Record<string, string>
  abortController: AbortController
}): Options {
  const u = o.config.usertest
  return {
    cwd: o.cwd,
    model: u.model,
    maxTurns: u.maxTurns,
    maxBudgetUsd: u.maxBudgetUsd,
    abortController: o.abortController,
    permissionMode: "default",
    allowedTools: CHROME_TOOLS.map(mcpTool),
    disallowedTools: ["Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "Task", "Skill", "TodoWrite"],
    canUseTool: async (toolName) => ({ behavior: "deny", message: `${toolName} is not part of the browser test.` }),
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {
      [MCP_SERVER]: {
        type: "stdio",
        command: process.execPath,
        args: chromeMcpArgs({ bin: o.mcpBin, port: o.port, patterns: o.patterns, shotsDir: o.shotsDir }),
        env: { PATH: process.env.PATH ?? "", CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1" },
      },
    },
    hooks: { PreToolUse: [{ hooks: [denyOffAllowlist(o.origins)] }] },
    env: o.env,
    systemPrompt: { type: "preset", preset: "claude_code", append: USERTEST_SYSTEM },
    outputFormat: { type: "json_schema", schema: USERTEST_RESULT_SCHEMA },
  }
}

export function mcpInitProblem(init: SdkMessage): string | null {
  const servers = Array.isArray(init.mcp_servers) ? (init.mcp_servers as Array<{ name?: string; status?: string }>) : []
  const ours = servers.find((s) => s.name === MCP_SERVER)
  return ours && (ours.status === "connected" || ours.status === "pending") ? null : `the browser tool did not start (${ours?.status ?? "missing"})`
}

export async function runBrowserSession(
  deps: { config: AgentConfig; query: QueryFn; mcpBin: string },
  s: { brief: string; cwd: string; port: number; origins: readonly string[]; patterns: readonly string[]; shotsDir: string; env: Record<string, string> },
): Promise<{ result: UserTestResult | null; costUsd: number | null; problem: string | null }> {
  const u = deps.config.usertest
  const options = userTestSdkOptions({ config: deps.config, cwd: s.cwd, mcpBin: deps.mcpBin, port: s.port, patterns: s.patterns, origins: s.origins, shotsDir: s.shotsDir, env: s.env, abortController: new AbortController() })
  const end = await runSession(deps.query, s.brief, options, u.wallClockMinutes, 0, mcpInitProblem)
  const cost = typeof end.result?.total_cost_usd === "number" ? end.result.total_cost_usd : null
  if (end.initProblem) return { result: null, costUsd: cost, problem: end.initProblem }
  if (end.abortedByClock) return { result: null, costUsd: cost, problem: `the browser test ran out of time (${u.wallClockMinutes} minutes)` }
  if (!end.result || end.result.subtype !== "success" || end.result.is_error) {
    return { result: null, costUsd: cost, problem: end.thrown ? "the browser test stopped unexpectedly" : "the browser test ended on an error" }
  }
  const parsed = parseUserTestResult(end.result.structured_output)
  return parsed ? { result: parsed, costUsd: cost, problem: null } : { result: null, costUsd: cost, problem: "the browser test ended without a readable report" }
}
