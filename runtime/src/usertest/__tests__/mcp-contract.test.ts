/**
 * The pinned chrome-devtools-mcp, started with the arguments the browser test
 * gives it, as a contract: which tools it offers, and the arguments they take.
 * A fake cannot see a new default in the real package (1.9.0 made a pageId
 * required on every page tool unless --no-page-id-routing, STEP-3328), so this
 * starts the real one. It only lists the tools, which needs no browser.
 */
import { tmpdir } from "node:os"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CHROME_DEVTOOLS_MCP_VERSION, chromeDevtoolsMcp } from "../mcp.ts"
import { CHROME_TOOLS, chromeMcpArgs } from "../session.ts"

type InputSchema = { properties?: Record<string, unknown>; required?: string[] }

let client: Client | null = null
let tools = new Map<string, InputSchema>()

beforeAll(async () => {
  const { bin, version } = chromeDevtoolsMcp()
  expect(version).toBe(CHROME_DEVTOOLS_MCP_VERSION)
  client = new Client({ name: "usertest-contract", version: "1.0.0" })
  // Nothing listens on port 9: listing the tools never connects to a browser.
  const args = chromeMcpArgs({ bin, port: 9, patterns: ["https://staging.example.com/*"], shotsDir: tmpdir() })
  await client.connect(new StdioClientTransport({ command: process.execPath, args, env: { PATH: process.env.PATH ?? "", CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1" }, stderr: "ignore" }))
  tools = new Map((await client.listTools()).tools.map((t) => [t.name, t.inputSchema as InputSchema]))
}, 60_000)

afterAll(async () => {
  await client?.close()
})

describe("the pinned chrome-devtools-mcp, as the browser test starts it (STEP-3328)", () => {
  it("asks no tool for a pageId, except the two whose subject is a page: one agent drives one browser", () => {
    const needPageId = [...tools].filter(([, schema]) => (schema.required ?? []).includes("pageId")).map(([name]) => name)
    expect(needPageId.sort()).toEqual(["close_page", "select_page"])
  })

  it("takes navigate_page's and new_page's URL where the navigation hook reads it, and never a script", () => {
    const navigate = tools.get("navigate_page")
    expect(Object.keys(navigate?.properties ?? {})).toEqual(expect.arrayContaining(["type", "url"]))
    expect(navigate?.required ?? []).toEqual([])
    // --javascriptEvaluation=false: no script runs before a page's own.
    expect(navigate?.properties).not.toHaveProperty("initScript")
    expect(tools.get("new_page")?.required).toEqual(["url"])
    expect(tools.get("emulate")?.properties).toHaveProperty("extraHttpHeaders")
  })

  it("offers every tool the session allows, and no new one nobody has looked at", () => {
    const offered = [...tools.keys()].sort()
    expect(CHROME_TOOLS.filter((name) => !tools.has(name))).toEqual([])
    // Left out on purpose (session.ts). A tool a later version adds must be looked at before it is allowed, or listed here.
    expect(offered.filter((name) => !(CHROME_TOOLS as readonly string[]).includes(name))).toEqual(["upload_file"])
    expect(offered).not.toContain("evaluate_script")
  })
})
