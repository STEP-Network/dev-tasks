/**
 * agentctl probe-browser (WS5): the browser's allowlist on the real Chrome,
 * with no model. The pinned chrome-devtools-mcp, started as the browser test
 * starts it, must open staging and refuse any other site. It spends nothing
 * and changes nothing.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { AgentConfig } from "../config.ts"
import { launchChrome, type ChromeHandle } from "./chrome.ts"
import { chromeDevtoolsMcp } from "./mcp.ts"
import { chromeMcpArgs } from "./session.ts"
import { allowedUrlPatterns } from "./target.ts"

export interface ProbeCheck {
  name: string
  /** opens: staging must open. refused: another site must not. setup: Chrome or the browser tool. */
  kind: "opens" | "refused" | "setup"
  ok: boolean
  detail: string
}

interface ToolResult {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
}

const OTHER_SITE = "https://example.com/"
const OPENED = "it opened"

/**
 * How the pinned chrome-devtools-mcp (1.9.0) says its --allowedUrlPattern
 * stopped a navigation: puppeteer's goto refuses the URL, and navigate_page
 * answers "Unable to navigate in the selected page: Navigation to <url> is
 * blocked by blocklist/allowlist rules." Only these words prove the allowlist
 * held (STEP-3328: a refused argument once passed for a refusal).
 */
export const allowlistRefusal = (url: string) => `Navigation to ${url} is blocked by blocklist/allowlist rules`

/** The browser tool answers a navigation in text: only its own "Successfully navigated" is opened, and only the allowlist's own words are refused. */
export function judgeNavigation(url: string, result: ToolResult, want: "opens" | "refused"): { ok: boolean; detail: string } {
  const text = (result.content ?? [])
    .map((c) => c.text ?? "")
    .join(" ")
    .trim()
  const opened = !result.isError && text.includes(`Successfully navigated to ${url}`)
  if (want === "opens") return opened ? { ok: true, detail: "opened" } : { ok: false, detail: text || "no answer" }
  if (opened) return { ok: false, detail: OPENED }
  return text.includes(allowlistRefusal(url)) ? { ok: true, detail: `refused: ${text}` } : { ok: false, detail: `not refused by the allowlist, it failed another way: ${text || "no answer"}` }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** One navigation. A call the browser tool throws on (its arguments refused, the tool gone) proves nothing either way. */
export async function tryNavigation(url: string, want: "opens" | "refused", call: (url: string) => Promise<ToolResult>): Promise<{ ok: boolean; detail: string }> {
  try {
    return judgeNavigation(url, await call(url), want)
  } catch (error) {
    return { ok: false, detail: `the browser tool failed: ${message(error)}` }
  }
}

export function formatBrowserProbe(checks: readonly ProbeCheck[]): { text: string; ok: boolean } {
  const ok = checks.every((c) => c.ok)
  const verdict = ok
    ? "the browser opens staging and nothing else"
    : checks.some((c) => c.kind === "refused" && c.detail === OPENED)
      ? "the browser's allowlist does NOT hold: keep the browser test off"
      : checks.some((c) => c.kind === "opens" && !c.ok)
        ? "staging did not open, so the allowlist is not proven: keep the browser test off until this passes"
        : checks.some((c) => c.kind === "refused" && !c.ok)
          ? "the other site was not refused by the allowlist itself, so the allowlist is not proven: keep the browser test off until this passes"
          : "the browser did not start, so the allowlist is not proven: keep the browser test off until this passes"
  return { ok, text: [...checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`), verdict].join("\n") }
}

export async function probeBrowser(config: AgentConfig): Promise<ProbeCheck[]> {
  const u = config.usertest
  if (!u.stagingOrigin) return [{ name: "the browser test's config", kind: "setup", ok: false, detail: "usertest.stagingOrigin is not set in config.json" }]
  const dir = mkdtempSync(join(tmpdir(), "probe-browser-"))
  const shotsDir = join(dir, "shots")
  mkdirSync(shotsDir)
  let chrome: ChromeHandle | null = null
  let client: Client | null = null
  try {
    chrome = await launchChrome({ chromePath: u.chromePath, profileDir: join(dir, "profile"), headless: u.headless, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) })
    const args = chromeMcpArgs({ bin: chromeDevtoolsMcp().bin, port: chrome.port, patterns: allowedUrlPatterns([u.stagingOrigin], u.extraAllowedUrlPatterns), shotsDir })
    client = new Client({ name: "agentctl-probe-browser", version: "1.0.0" })
    await client.connect(new StdioClientTransport({ command: process.execPath, args, env: { PATH: process.env.PATH ?? "", CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1" }, stderr: "ignore" }))
    // Each call on its own, with the arguments the session's model sends: a failed staging call still leaves the other site's check.
    const navigate = async (url: string) => (await client!.callTool({ name: "navigate_page", arguments: { type: "url", url } })) as ToolResult
    const newPage = async (url: string) => (await client!.callTool({ name: "new_page", arguments: { url } })) as ToolResult
    return [
      { name: `${u.stagingOrigin} opens`, kind: "opens", ...(await tryNavigation(u.stagingOrigin, "opens", navigate)) },
      { name: `${OTHER_SITE} is refused`, kind: "refused", ...(await tryNavigation(OTHER_SITE, "refused", navigate)) },
      // The other tool that opens a page: the allowlist must hold there too.
      { name: `${OTHER_SITE} is refused in a new page`, kind: "refused", ...(await tryNavigation(OTHER_SITE, "refused", newPage)) },
    ]
  } catch (error) {
    return [{ name: "the browser test's browser", kind: "setup", ok: false, detail: message(error) }]
  } finally {
    await client?.close().catch(() => {})
    await chrome?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}
