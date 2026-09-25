import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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
    // Chrome started over SSH never reaches for the locked login keychain.
    expect(args).toContain("--use-mock-keychain")
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

  it("fails when Chrome exits before it opens its port, and removes the profile", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "chrome-")), "profile")
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    const spawnChrome = vi.fn(() => {
      setTimeout(() => child.emit("exit", 1), 1)
      return child as never
    })
    await expect(launchChrome({ chromePath: "/chrome", profileDir: dir, headless: true, spawnChrome, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) })).rejects.toThrow(/exited/)
    expect(existsSync(dir)).toBe(false)
  })

  it("kills a Chrome that never opens its port in time, and removes the profile", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "chrome-")), "profile")
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    const spawnChrome = vi.fn(() => child as never)
    await expect(launchChrome({ chromePath: "/chrome", profileDir: dir, headless: true, spawnChrome, timeoutMs: 20, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) })).rejects.toThrow(/in time/)
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    expect(existsSync(dir)).toBe(false)
  })

  it("starts the real binary through its own spawn without the runner's secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "chrome-"))
    const script = join(root, "chrome.sh")
    writeFileSync(script, `#!/bin/sh\nenv > "${join(root, "env.txt")}"\n`, { mode: 0o755 })
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-secret")
    try {
      await expect(launchChrome({ chromePath: script, profileDir: join(root, "profile"), headless: true, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))) })).rejects.toThrow(/exited/)
    } finally {
      vi.unstubAllEnvs()
    }
    const env = readFileSync(join(root, "env.txt"), "utf8")
    expect(env).toMatch(/^PATH=/m)
    expect(env).not.toContain("SLACK_BOT_TOKEN")
  })

  it("starts Chrome without the runner's secrets in its environment", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-secret")
    vi.stubEnv("TEST_LOGIN_SECRET", "s3cret")
    try {
      const dir = join(mkdtempSync(join(tmpdir(), "chrome-")), "profile")
      const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => child.emit("exit", 0)) })
      const spawnChrome = vi.fn((_path: string, _args: string[], _env: Record<string, string>) => {
        setTimeout(() => writeFileSync(join(dir, "DevToolsActivePort"), "9333\n/devtools/browser/x\n"), 5)
        return child as never
      })
      const handle = await launchChrome({ chromePath: "/chrome", profileDir: dir, headless: true, spawnChrome, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) })
      await handle.close()
      const env = spawnChrome.mock.calls[0][2]
      expect(env.PATH).toBe(process.env.PATH)
      expect(env).not.toHaveProperty("SLACK_BOT_TOKEN")
      expect(env).not.toHaveProperty("TEST_LOGIN_SECRET")
    } finally {
      vi.unstubAllEnvs()
    }
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
    const cookies = [
      { name: "a", value: "1", url: "https://s.example.com", secure: true, httpOnly: false },
      { name: "b", value: '"q"', url: "https://s.example.com", secure: true, httpOnly: true, sameSite: "None" as const, expires: 1060 },
    ]
    await setBrowserCookies(9333, cookies, { fetchImpl, socket })
    expect(JSON.parse(sent[0])).toEqual({ id: 1, method: "Storage.setCookies", params: { cookies } })
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it("passes over a socket message that is not JSON, and still takes the answer", async () => {
    const listeners: Record<string, (e: { data?: unknown }) => void> = {}
    const socket = () => {
      setTimeout(() => listeners.open?.({}), 1)
      return {
        send: () => {
          setTimeout(() => listeners.message?.({ data: "not json" }), 1)
          setTimeout(() => listeners.message?.({ data: JSON.stringify({ id: 1, result: {} }) }), 2)
        },
        close: () => {},
        addEventListener: (type: string, fn: (e: { data?: unknown }) => void) => void (listeners[type] = fn),
      }
    }
    const fetchImpl = vi.fn().mockResolvedValue({ json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/x" }) })
    await expect(setBrowserCookies(9333, [{ name: "a", value: "1", url: "https://s.example.com", secure: true, httpOnly: false }], { fetchImpl, socket, timeoutMs: 500 })).resolves.toBeUndefined()
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
