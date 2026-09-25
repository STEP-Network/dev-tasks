import { EventEmitter } from "node:events"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { chromeArgs, chromeMajor, launchChrome, readDevToolsPort, setBrowserCookies } from "../chrome.ts"

describe("chromeArgs", () => {
  it("binds DevTools to loopback, uses its own profile and runs headless", () => {
    const args = chromeArgs({ profileDir: "/tmp/p", headless: true })
    expect(args).toContain("--remote-debugging-address=127.0.0.1")
    expect(args).toContain("--remote-debugging-port=0")
    expect(args).toContain("--user-data-dir=/tmp/p")
    expect(args).toContain("--headless=new")
  })
})

describe("launchChrome", () => {
  it("returns the port Chrome writes, and closes by killing it and removing the profile", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "chrome-")), "profile")
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => child.emit("exit", 0)) })
    const spawnChrome = vi.fn(() => {
      setTimeout(() => writeFileSync(join(dir, "DevToolsActivePort"), "9333\n/devtools/browser/x\n"), 5)
      return child as never
    })
    const handle = await launchChrome({ chromePath: "/chrome", profileDir: dir, headless: true, spawnChrome, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) })
    expect(handle.port).toBe(9333)
    await handle.close()
    expect(child.kill).toHaveBeenCalled()
    expect(readDevToolsPort(dir)).toBeNull()
  })

  it("fails when Chrome exits before it opens its port", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "chrome-")), "profile")
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    const spawnChrome = vi.fn(() => {
      setTimeout(() => child.emit("exit", 1), 1)
      return child as never
    })
    await expect(launchChrome({ chromePath: "/chrome", profileDir: dir, headless: true, spawnChrome, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) })).rejects.toThrow(/exited/)
  })
})

describe("setBrowserCookies", () => {
  it("sends Storage.setCookies over the local DevTools socket and waits for the answer", async () => {
    const sent: string[] = []
    const listeners: Record<string, (e: { data?: unknown }) => void> = {}
    const socket = (url: string) => {
      expect(url).toBe("ws://127.0.0.1:9333/devtools/browser/x")
      setTimeout(() => listeners.open?.({}), 1)
      return {
        send: (d: string) => {
          sent.push(d)
          setTimeout(() => listeners.message?.({ data: JSON.stringify({ id: 1, result: {} }) }), 1)
        },
        close: () => {},
        addEventListener: (type: string, fn: (e: { data?: unknown }) => void) => void (listeners[type] = fn),
      }
    }
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/x" }) })
    await setBrowserCookies(9333, [{ name: "a", value: "1", url: "https://s.example.com", secure: true, httpOnly: false }], { fetchImpl, socket })
    expect(JSON.parse(sent[0])).toMatchObject({ id: 1, method: "Storage.setCookies" })
  })

  it("refuses a DevTools socket that is not local", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ webSocketDebuggerUrl: "ws://10.0.0.1:9333/x" }) })
    await expect(setBrowserCookies(9333, [{ name: "a", value: "1", url: "https://s.example.com", secure: true, httpOnly: false }], { fetchImpl, socket: vi.fn() })).rejects.toThrow(/local/)
  })
})

describe("chromeMajor", () => {
  it("reads the major version from --version", () => {
    expect(chromeMajor("Google Chrome 153.0.7000.1 ")).toBe(153)
    expect(chromeMajor("nothing")).toBeNull()
  })
})
