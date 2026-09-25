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
  ok: boolean
  detail: string
}

interface ToolResult {
  isError?: boolean
  content?: Array<{ type: string; text?: string }>
}

const OTHER_SITE = "https://example.com/"

/** The browser tool answers a blocked navigation in text, not as an error: only its own "Successfully navigated" counts as opened. */
export function judgeNavigation(url: string, result: ToolResult, want: "opens" | "refused"): { ok: boolean; detail: string } {
  const text = (result.content ?? [])
    .map((c) => c.text ?? "")
    .join(" ")
    .trim()
  const opened = !result.isError && text.includes(`Successfully navigated to ${url}`)
  if (want === "opens") return opened ? { ok: true, detail: "opened" } : { ok: false, detail: text || "no answer" }
  return opened ? { ok: false, detail: "it opened" } : { ok: true, detail: `refused: ${text || "an error"}` }
}

export function formatBrowserProbe(checks: readonly ProbeCheck[]): { text: string; ok: boolean } {
  const ok = checks.every((c) => c.ok)
  const verdict = ok ? "the browser opens staging and nothing else" : "the browser's allowlist does NOT hold: keep the browser test off"
  return { ok, text: [...checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`), verdict].join("\n") }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function probeBrowser(config: AgentConfig): Promise<ProbeCheck[]> {
  const u = config.usertest
  if (!u.stagingOrigin) return [{ name: "the browser test's config", ok: false, detail: "usertest.stagingOrigin is not set in config.json" }]
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
    const go = async (url: string) => (await client!.callTool({ name: "navigate_page", arguments: { type: "url", url } })) as ToolResult
    const staging = judgeNavigation(u.stagingOrigin, await go(u.stagingOrigin), "opens")
    const other = judgeNavigation(OTHER_SITE, await go(OTHER_SITE), "refused")
    return [
      { name: `${u.stagingOrigin} opens`, ...staging },
      { name: `${OTHER_SITE} is refused`, ...other },
    ]
  } catch (error) {
    return [{ name: "the browser test's browser", ok: false, detail: message(error) }]
  } finally {
    await client?.close().catch(() => {})
    await chrome?.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}
