/**
 * dist/server.js is what `.mcp.json` starts, and a marketplace install runs it
 * from plugin/ as committed: no node_modules, no install or build step. When
 * it was tsc's output it imported @modelcontextprotocol/sdk and zod by package
 * name, so a GitHub install died on start and Claude Code showed "Failed to
 * reconnect to plugin: CONNECTION_CLOSED" (STEP-3155). A checkout never saw
 * it, because a checkout has node_modules.
 *
 * So these tests start the committed dist/server.js from a copy of plugin/
 * without node_modules, list and call its tools there, and check that an npm
 * install run in that copy anyway would not try to build. They also check
 * that the committed bundle is the one the build makes from src/ now, and
 * that it leaves nothing for Node to resolve at run time.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { bundleServer, LICENSE_PATH, PLUGIN_ROOT, SERVER_PATH } from "../../scripts/bundle-server.ts"

// What the server says it registered and what tools/list returns must both
// match the tools src/register-tools.ts registers.
const REGISTERED = readFileSync(join(PLUGIN_ROOT, "src", "register-tools.ts"), "utf8").match(/\bserver\.tool\(/g)?.length ?? 0

// Long enough for a cold start on a loaded machine, short enough to fail a
// server that hangs instead of exiting.
const KILL_AFTER_MS = 4_000

let root: string
let plugin: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dev-tasks-install-"))
  plugin = join(root, "dev-tasks")
  cpSync(PLUGIN_ROOT, plugin, { recursive: true, filter: (source) => basename(source) !== "node_modules" })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

// The server the way .mcp.json starts it, inheriting nothing that could hand
// it a package (NODE_PATH, a NODE_OPTIONS loader) or a tracker key
// (MONDAY_API_KEY, or a key file under the real HOME): no call it makes can
// reach Monday.
function startServer() {
  const child = spawn(process.execPath, [join(plugin, "dist", "server.js")], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: root },
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS)
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk))
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk))
  const exited = once(child, "close").then(([code, signal]) => {
    clearTimeout(timer)
    return { code, signal, stdout, stderr }
  })
  return { child, exited }
}

describe("the bundled MCP server, installed without node_modules", () => {
  it("has no node_modules to resolve a package from, in the copy or above it", () => {
    // Node looks for packages in every ancestor directory, so one up the
    // path would let an unbundled server pass the tests below.
    for (let dir = plugin; ; dir = dirname(dir)) {
      expect(existsSync(join(dir, "node_modules")), `${dir}/node_modules`).toBe(false)
      if (dirname(dir) === dir) break
    }
  })

  it("starts with stdin closed, says how many tools it registered, and exits cleanly", async () => {
    const { child, exited } = startServer()
    child.stdin.end()

    const { code, signal, stdout, stderr } = await exited
    expect(stderr).toBe(`[dev-tasks] connected (stdio), ${REGISTERED} tools registered\n`)
    expect({ code, signal }).toEqual({ code: 0, signal: null })
    expect(stdout).toBe("")
  }, 10_000)

  it("lists every registered tool to an MCP client, and runs one", async () => {
    const { child, exited } = startServer()
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
    send({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "server-bundle.test", version: "0" } },
    })
    send({ method: "notifications/initialized" })
    send({ id: 2, method: "tools/list" })
    // A call runs code that starting and listing never reach: argument
    // validation, a tool, the Monday client. With no key anywhere it stops
    // at the key check, before any request.
    send({ id: 3, method: "tools/call", params: { name: "getTask", arguments: { itemId: 1 } } })
    // Close stdin once the last reply is whole, as a client that is done would.
    let pending = ""
    child.stdout.on("data", (chunk: string) => {
      const lines = (pending + chunk).split("\n")
      pending = lines.pop() ?? ""
      if (lines.some((line) => JSON.parse(line).id === 3)) child.stdin.end()
    })

    const { code, signal, stdout, stderr } = await exited
    expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: `[dev-tasks] connected (stdio), ${REGISTERED} tools registered\n` })
    const replies = new Map(stdout.trim().split("\n").map((line) => JSON.parse(line)).map((reply) => [reply.id, reply]))
    expect(replies.get(1)?.result?.serverInfo?.name).toBe("dev-tasks")
    const names: string[] = replies.get(2)?.result?.tools?.map((tool: { name: string }) => tool.name) ?? []
    expect(names).toHaveLength(REGISTERED)
    expect(new Set(names).size).toBe(REGISTERED)
    // getTask reports its own failure as text: "# Error ... Failed to fetch task: No Monday auth: ...".
    expect(replies.get(3)?.result?.content?.[0]?.text).toMatch(/Failed to fetch task: No Monday auth/)
  }, 10_000)

  it("has no npm script an install would run, should someone run one in it", () => {
    // It needs no npm step, and one run there anyway must not build: 1.1.1's
    // `prepare` ran `npm run build`, so `npm ci --omit=dev` in an installed
    // copy failed on the missing tsc.
    const { scripts = {} } = JSON.parse(readFileSync(join(plugin, "package.json"), "utf8")) as { scripts?: Record<string, string> }
    const onInstall = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"]
    expect(Object.keys(scripts).filter((name) => onInstall.includes(name))).toEqual([])
  })
})

describe("the committed bundle", () => {
  it("is what `npm run build` makes from src/ now", async () => {
    // dist/ is committed and the bundle is a megabyte nobody reviews by eye:
    // this is what says it matches the source. The build bundles whatever is
    // in node_modules, so on a failure run `npm ci && npm run build` (not the
    // build alone) and commit dist/.
    const { server, licenses } = await bundleServer()
    expect(readFileSync(SERVER_PATH, "utf8") === server, "dist/server.js is stale: run `npm ci && npm run build`").toBe(true)
    expect(readFileSync(LICENSE_PATH, "utf8")).toBe(licenses)
  }, 30_000)

  it("leaves Node nothing to resolve while the server runs", () => {
    // esbuild, without a warning, turns a require() in a CommonJS package
    // (even of a built-in) into a stand-in that throws "Dynamic require of
    // ... is not supported" in an ESM bundle, and leaves an import() of a
    // computed name for run time. The start and the one call above need not
    // reach such a line. createRequire would resolve from a node_modules an
    // install does not have. An import() of a node: built-in is fine.
    const server = readFileSync(SERVER_PATH, "utf8")
    expect(server).not.toContain("Dynamic require of")
    expect(server).not.toContain("createRequire")
    expect(server.match(/\bimport\((?!["']node:)[^)\n]*\)?/g) ?? []).toEqual([])
  })
})
