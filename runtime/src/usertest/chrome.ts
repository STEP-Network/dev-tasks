/**
 * The browser for one test (WS5): a fresh headless Chrome with its own
 * throwaway profile, DevTools on loopback only. chrome-devtools-mcp connects
 * to it (--browserUrl), after the runtime has put the persona's cookies in
 * over the browser's own DevTools socket.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { BrowserCookie } from "./login.ts"

export interface ChromeHandle {
  port: number
  close(): Promise<void>
}

export type SpawnChrome = (path: string, args: string[]) => ChildProcess

export function chromeArgs(o: { profileDir: string; headless: boolean }): string[] {
  return [
    `--user-data-dir=${o.profileDir}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-extensions",
    "--disable-background-networking",
    "--window-size=1440,900",
    ...(o.headless ? ["--headless=new"] : []),
    "about:blank",
  ]
}

/** The port Chrome chose, from the DevToolsActivePort file it writes into its profile. */
export function readDevToolsPort(profileDir: string): number | null {
  const file = join(profileDir, "DevToolsActivePort")
  if (!existsSync(file)) return null
  const port = Number(readFileSync(file, "utf8").split("\n")[0])
  return Number.isInteger(port) && port > 0 ? port : null
}

export function chromeMajor(versionText: string): number | null {
  const m = /Chrome\s+(\d+)\./.exec(versionText)
  return m ? Number(m[1]) : null
}

export async function launchChrome(o: {
  chromePath: string
  profileDir: string
  headless: boolean
  sleep: (ms: number) => Promise<void>
  spawnChrome?: SpawnChrome
  timeoutMs?: number
}): Promise<ChromeHandle> {
  // A profile from an earlier run could hold an old port file and old cookies.
  rmSync(o.profileDir, { recursive: true, force: true })
  mkdirSync(o.profileDir, { recursive: true })
  const child = (o.spawnChrome ?? ((path, args) => spawn(path, args, { stdio: "ignore" })))(o.chromePath, chromeArgs(o))
  let exited = false
  child.on("exit", () => void (exited = true))
  child.on("error", () => void (exited = true))
  const deadline = Date.now() + (o.timeoutMs ?? 30_000)
  let port: number | null = null
  while (port === null) {
    if (exited) throw new Error("Chrome exited before it opened its debugging port")
    if (Date.now() > deadline) {
      child.kill("SIGKILL")
      throw new Error("Chrome did not open its debugging port in time")
    }
    await o.sleep(250)
    port = readDevToolsPort(o.profileDir)
  }
  return {
    port,
    async close() {
      if (!exited) {
        child.kill("SIGTERM")
        for (let i = 0; i < 20 && !exited; i++) await o.sleep(250)
        if (!exited) child.kill("SIGKILL")
      }
      rmSync(o.profileDir, { recursive: true, force: true })
    },
  }
}

export interface MiniSocket {
  send(data: string): void
  close(): void
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void
}
export type SocketFactory = (url: string) => MiniSocket

const nodeSocket: SocketFactory = (url) => {
  const Ws = (globalThis as { WebSocket?: new (u: string) => MiniSocket }).WebSocket
  if (!Ws) throw new Error("this Node has no WebSocket: the browser test needs Node 22 or newer")
  return new Ws(url)
}

/** Puts the cookies in before any page loads, with one Storage.setCookies over the browser's local DevTools socket. */
export async function setBrowserCookies(
  port: number,
  cookies: readonly BrowserCookie[],
  o: { fetchImpl: typeof fetch; socket?: SocketFactory; timeoutMs?: number },
): Promise<void> {
  if (!cookies.length) return
  const version = (await (await o.fetchImpl(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl?: string }
  const url = version.webSocketDebuggerUrl
  if (!url?.startsWith(`ws://127.0.0.1:${port}/`)) throw new Error("Chrome gave no local DevTools socket")
  const ws = (o.socket ?? nodeSocket)(url)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error("Chrome did not take the cookies in time"))
    }, o.timeoutMs ?? 15_000)
    ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Storage.setCookies", params: { cookies } })))
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as { id?: number; error?: { message?: string } }
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(`Chrome refused the cookies: ${msg.error.message ?? "no reason given"}`))
      else resolve()
    })
    ws.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new Error("the DevTools socket failed"))
    })
  })
}
