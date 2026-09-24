import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

const unref = vi.fn()
const on = vi.fn()
const spawn = vi.fn(() => ({ pid: 777, unref, on }))
vi.mock("node:child_process", async (actual) => ({ ...(await actual<typeof import("node:child_process")>()), spawn: (...args: unknown[]) => spawn(...(args as [])) }))

const { agentPaths } = await import("../../config.ts")
const { spawnWorkerProcess } = await import("../jobrunner.ts")

describe("spawnWorkerProcess", () => {
  it("starts run.ts in its own process group, so an agentd or front-door restart never kills it", () => {
    const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-spawn-")))
    expect(spawnWorkerProcess(paths, "/Users/eve/dev-tasks/runtime")("STEP-7-20260924090000")).toBe(777)
    const [cmd, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { detached: boolean; cwd: string; stdio: unknown[] }]
    expect(cmd).toBe(process.execPath)
    expect(args).toEqual(["--import", "tsx", "/Users/eve/dev-tasks/runtime/src/worker/run.ts", "STEP-7-20260924090000"])
    expect(options).toMatchObject({ detached: true, cwd: "/Users/eve/dev-tasks/runtime" })
    expect(options.stdio[0]).toBe("ignore")
    expect(unref).toHaveBeenCalled()
    // A spawn that fails reports it as an 'error' event: without a listener that would take agentd down.
    expect(on).toHaveBeenCalledWith("error", expect.any(Function))
  })

  it("throws when no process started", () => {
    spawn.mockReturnValueOnce({ pid: undefined as unknown as number, unref, on })
    const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-spawn-")))
    expect(() => spawnWorkerProcess(paths, "/Users/eve/dev-tasks/runtime")("STEP-7-20260924090000")).toThrow(/could not start the worker for STEP-7-20260924090000/)
  })
})
