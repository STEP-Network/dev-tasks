import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir, uptime } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { releasePidLock, takePidLock } from "../pidlock.ts"

const lockFile = () => join(mkdtempSync(join(tmpdir(), "pidlock-")), "slack-bridge.pid")

// A pid whose process has certainly exited: a child that ran and ended.
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!

describe("takePidLock", () => {
  it("takes a free lock, and refuses a second process while the first lives", () => {
    const path = lockFile()
    expect(takePidLock(path, process.pid)).toEqual({ ok: true })
    expect(readFileSync(path, "utf8")).toBe(String(process.pid))
    expect(takePidLock(path, 424242)).toEqual({ ok: false, holder: process.pid })
  })

  it("takes over a lock whose process has gone", () => {
    const path = lockFile()
    writeFileSync(path, String(deadPid()))
    expect(takePidLock(path, 424242)).toEqual({ ok: true })
    expect(readFileSync(path, "utf8")).toBe("424242")
  })

  it("takes over a lock written before this boot, whoever has its pid now", () => {
    // After a power cut the old pid can belong to any process: only a lock from this boot counts.
    const path = lockFile()
    writeFileSync(path, String(process.pid))
    const beforeBoot = new Date(Date.now() - uptime() * 1000 - 60_000)
    utimesSync(path, beforeBoot, beforeBoot)
    expect(takePidLock(path, 424242)).toEqual({ ok: true })
  })

  it("releases only its own lock", () => {
    const path = lockFile()
    takePidLock(path, process.pid)
    releasePidLock(path, 424242)
    expect(readFileSync(path, "utf8")).toBe(String(process.pid))
    releasePidLock(path, process.pid)
    expect(takePidLock(path, 424242)).toEqual({ ok: true })
  })
})
