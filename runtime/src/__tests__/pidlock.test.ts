import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { releasePidLock, takePidLock } from "../pidlock.ts"

const MARKER = "pidlock-test-holder"
const lockFile = () => join(mkdtempSync(join(tmpdir(), "pidlock-")), "slack-bridge.pid")

// A pid whose process has certainly exited: a child that ran and ended.
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!

// A live process whose command line carries the marker, as a running bridge's carries src/slack/bridge.ts.
const holders: ChildProcess[] = []
const liveHolder = () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", MARKER], { stdio: "ignore" })
  holders.push(child)
  return child.pid!
}

afterEach(() => {
  for (const child of holders.splice(0)) child.kill()
})

describe("takePidLock", () => {
  it("takes a free lock, and leaves nothing else behind", () => {
    const path = lockFile()
    expect(takePidLock(path, MARKER, 4242)).toEqual({ ok: true })
    expect(readFileSync(path, "utf8")).toBe("4242")
    expect(readdirSync(dirname(path))).toEqual(["slack-bridge.pid"])
  })

  it("refuses while a live process of the holder's kind has it", () => {
    const path = lockFile()
    const holder = liveHolder()
    writeFileSync(path, String(holder))
    expect(takePidLock(path, MARKER, 4242)).toEqual({ ok: false, holder })
  })

  it("takes over a lock whose process has gone", () => {
    const path = lockFile()
    writeFileSync(path, String(deadPid()))
    expect(takePidLock(path, MARKER, 4242)).toEqual({ ok: true })
    expect(readFileSync(path, "utf8")).toBe("4242")
  })

  it("takes over a lock whose pid now belongs to some other process", () => {
    // After a crash or a power cut the old pid can belong to anything: here, this test runner.
    const path = lockFile()
    writeFileSync(path, String(process.pid))
    expect(takePidLock(path, MARKER, 4242)).toEqual({ ok: true })
  })

  it("releases only its own lock", () => {
    const path = lockFile()
    takePidLock(path, MARKER, 4242)
    releasePidLock(path, 4343)
    expect(readFileSync(path, "utf8")).toBe("4242")
    releasePidLock(path, 4242)
    expect(takePidLock(path, MARKER, 4343)).toEqual({ ok: true })
  })
})
