/**
 * chrome-devtools-mcp, pinned in runtime/package.json and locked, run from
 * this runtime's node_modules. Never npx: that would fetch whatever is newest.
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const CHROME_DEVTOOLS_MCP_VERSION = "1.9.0"
const RUNTIME_DIR = fileURLToPath(new URL("../..", import.meta.url))

export function chromeDevtoolsMcp(runtimeDir: string = RUNTIME_DIR): { bin: string; version: string } {
  const dir = join(runtimeDir, "node_modules", "chrome-devtools-mcp")
  const pkgFile = join(dir, "package.json")
  if (!existsSync(pkgFile)) throw new Error(`chrome-devtools-mcp is not installed in ${runtimeDir}: run npm ci there`)
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { version?: string; bin?: Record<string, string> }
  const rel = pkg.bin?.["chrome-devtools-mcp"]
  if (!rel) throw new Error("chrome-devtools-mcp has no chrome-devtools-mcp binary")
  return { bin: join(dir, rel), version: pkg.version ?? "unknown" }
}
