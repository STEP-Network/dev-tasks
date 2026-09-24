import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew, writeJsonAtomic } from "../../fsq.ts"
import { listJobs, moveJob, submitJob, updateJob } from "../../jobs.ts"
import type { Logger } from "../../log.ts"
import { isWorkerAlive, superviseJobs, type JobRunnerDeps } from "../jobrunner.ts"

const quiet: Logger = { info() {}, warn() {}, error() {} }
const NOW = new Date("2026-09-24T12:00:00.000Z")
const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] } })

function setup(over: Partial<JobRunnerDeps> = {}) {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-jobs-")))
  const kills: Array<[number, string]> = []
  const spawned: string[] = []
  const asked: Array<[number, string]> = []
  const deps: JobRunnerDeps = {
    paths, config, now: () => NOW, log: quiet, bootAt: new Date("2026-09-24T06:00:00.000Z"),
    isAlive: (pid, jobId) => {
      asked.push([pid, jobId])
      return true
    },
    kill: (pid, signal) => { kills.push([pid, signal]) },
    spawnWorker: (id) => { spawned.push(id); return 5000 + spawned.length },
    ...over,
  }
  return { paths, deps, kills, spawned, asked }
}

const running = (paths: JobRunnerDeps["paths"], issue: string, patch: Record<string, unknown>) => {
  const job = submitJob(paths, issue, null, new Date("2026-09-24T11:00:00.000Z"))
  moveJob(paths, job.id, "pending", "running", { pid: 4242, startedAt: "2026-09-24T11:30:00.000Z", ...patch })
  return job
}

const outbox = (paths: JobRunnerDeps["paths"]) => listNew<{ text: string }>(paths.outbox).map((e) => e.payload.text)

describe("superviseJobs", () => {
  it("starts the oldest pending job when idle, and only that one", () => {
    const { paths, deps, spawned } = setup()
    submitJob(paths, "STEP-2", null, new Date("2026-09-24T11:05:00.000Z"))
    const first = submitJob(paths, "STEP-1", null, new Date("2026-09-24T11:00:00.000Z"))
    superviseJobs(deps)
    expect(spawned).toEqual([first.id])
    expect(listJobs(paths, "running")[0]).toMatchObject({ issue: "STEP-1", pid: 5001, startedAt: NOW.toISOString() })
    superviseJobs(deps)
    expect(spawned).toHaveLength(1)
  })

  it("starts nothing while paused", () => {
    const { paths, deps, spawned } = setup()
    submitJob(paths, "STEP-1", null, NOW)
    writeFileSync(paths.pauseFile, "")
    superviseJobs(deps)
    expect(spawned).toEqual([])
  })

  it("asks whether the job's own worker is alive, by pid and job id", () => {
    const { paths, deps, asked } = setup()
    const job = running(paths, "STEP-1", {})
    superviseJobs(deps)
    expect(asked).toEqual([[4242, job.id]])
  })

  it("records a dead worker as blocked, says so, and frees the slot", () => {
    const { paths, deps, spawned } = setup({ isAlive: () => false })
    running(paths, "STEP-1", {})
    submitJob(paths, "STEP-2", null, NOW)
    superviseJobs(deps)
    expect(listJobs(paths, "done")[0].result).toMatchObject({ status: "blocked", reason: "the worker process died before reporting", minutes: 30 })
    const [notice] = outbox(paths)
    expect(notice).toMatch(/^STEP-1: the worker process died before reporting\./)
    // Its commits are not pushed from here: they stay on the local branch, where the next run starts from them.
    expect(notice).toMatch(/stays on this mini's local branch/)
    expect(notice).toMatch(/released after 6 hours/)
    expect(spawned).toHaveLength(1)
  })

  it("treats a job that started before the last boot as dead, even if its pid is in use again", () => {
    const { paths, deps, kills, spawned } = setup()
    running(paths, "STEP-1", { startedAt: "2026-09-24T05:00:00.000Z" })
    superviseJobs(deps)
    expect(listJobs(paths, "done")).toHaveLength(1)
    expect(kills).toEqual([])
    expect(spawned).toEqual([])
  })

  it("stops a worker that overran its wall clock: SIGTERM to the group, SIGKILL a minute later", () => {
    const { paths, deps, kills } = setup()
    const job = running(paths, "STEP-1", { startedAt: "2026-09-24T10:00:00.000Z" })
    superviseJobs(deps)
    expect(kills).toEqual([[-4242, "SIGTERM"]])
    updateJob(paths, "running", job.id, { killRequestedAt: "2026-09-24T11:58:00.000Z" })
    superviseJobs(deps)
    expect(kills).toEqual([[-4242, "SIGTERM"], [-4242, "SIGKILL"]])
  })

  it("says a stopped worker was stopped, once, when it has gone", () => {
    const { paths, deps } = setup()
    const job = running(paths, "STEP-1", { startedAt: "2026-09-24T09:50:00.000Z", sessionStartedAt: "2026-09-24T10:10:00.000Z" })
    superviseJobs(deps)
    expect(outbox(paths)).toEqual([])
    updateJob(paths, "running", job.id, { killRequestedAt: "2026-09-24T11:59:00.000Z" })
    superviseJobs({ ...deps, isAlive: () => false })
    expect(listJobs(paths, "done")[0].result).toMatchObject({ status: "blocked", reason: "the worker overran its wall clock of 90 minutes and was stopped" })
    expect(outbox(paths)).toHaveLength(1)
    expect(outbox(paths)[0]).toMatch(/^STEP-1: the worker overran its wall clock of 90 minutes and was stopped\./)
  })

  it("counts the wall clock from the session's start, so a slow worktree does not cut a session short", () => {
    // Spawned 115 minutes ago, 25 of them preparing: the session is at 90 minutes, and the runner is finishing.
    const { paths, deps, kills } = setup()
    running(paths, "STEP-1", { startedAt: "2026-09-24T10:05:00.000Z", sessionStartedAt: "2026-09-24T10:30:00.000Z" })
    superviseJobs(deps)
    expect(kills).toEqual([])
    // 90 minutes of session and 15 to finish have passed.
    superviseJobs({ ...deps, now: () => new Date("2026-09-24T12:15:01.000Z") })
    expect(kills).toEqual([[-4242, "SIGTERM"]])
  })

  it("stops a worker still preparing its worktree after 45 minutes, and says so", () => {
    const { paths, deps, kills } = setup()
    const job = running(paths, "STEP-1", { startedAt: "2026-09-24T11:14:00.000Z" })
    superviseJobs(deps)
    expect(kills).toEqual([[-4242, "SIGTERM"]])
    expect(listJobs(paths, "running")[0].killRequestedAt).toBe(NOW.toISOString())
    superviseJobs({ ...deps, isAlive: () => false })
    expect(listJobs(paths, "done").find((j) => j.id === job.id)?.result?.reason).toBe(
      "the worker was still preparing its worktree after 45 minutes and was stopped",
    )
  })

  it("never overwrites the result a runner wrote just before it died", () => {
    // The runner wrote done, then died before it removed its running file.
    const { paths, deps } = setup()
    const job = running(paths, "STEP-1", {})
    const result = { status: "done" as const, reason: "done", prUrl: "https://github.com/x/pull/9", branch: "STEP-1-x", costUsd: 2, turns: 40, minutes: 30 }
    superviseJobs({
      ...deps,
      isAlive: () => {
        writeJsonAtomic(join(paths.jobs, "done", `${job.id}.json`), { ...job, result })
        return false
      },
    })
    expect(listJobs(paths, "done")[0].result).toEqual(result)
    expect(listJobs(paths, "running")).toEqual([])
    expect(outbox(paths)).toEqual([])
  })

  it("says nothing of a worker that reported in the moment before it exited", () => {
    const { paths, deps } = setup()
    const job = running(paths, "STEP-1", {})
    const result = { status: "done" as const, reason: "done", prUrl: "https://github.com/x/pull/9", branch: "STEP-1-x", costUsd: 2, turns: 40, minutes: 30 }
    superviseJobs({
      ...deps,
      // The runner moves its job to done and exits, between agentd's listing and its look at the pid.
      isAlive: () => {
        moveJob(paths, job.id, "running", "done", { result })
        return false
      },
    })
    expect(listJobs(paths, "done")[0].result).toEqual(result)
    expect(outbox(paths)).toEqual([])
  })

  it("clears a job a crash left in both running and done", () => {
    const { paths, deps } = setup()
    const job = running(paths, "STEP-1", {})
    writeJsonAtomic(join(paths.jobs, "done", `${job.id}.json`), { ...job, result: { status: "done" } })
    superviseJobs(deps)
    expect(listJobs(paths, "running")).toEqual([])
  })

  it("records a worker that could not be started as blocked, and frees the slot", () => {
    const { paths, deps } = setup({
      spawnWorker: () => {
        throw new Error("could not start the worker for STEP-1-20260924110000")
      },
    })
    submitJob(paths, "STEP-1", null, new Date("2026-09-24T11:00:00.000Z"))
    superviseJobs(deps)
    expect(listJobs(paths, "running")).toEqual([])
    expect(listJobs(paths, "done")[0].result).toMatchObject({ status: "blocked", reason: "the worker could not be started: could not start the worker for STEP-1-20260924110000" })
    expect(outbox(paths)[0]).toMatch(/^STEP-1: the worker could not be started/)
  })
})

describe("two early losses in a row", () => {
  // A worker that dies before it claims leaves its issue Ready, and the front door would offer it again at every wakeup.
  const deadEarly = (paths: JobRunnerDeps["paths"], issue: string, at: string) => running(paths, issue, { startedAt: at })

  it("pause the mini with the reason, and say where the logs are", () => {
    const { paths, deps } = setup({ isAlive: () => false })
    const first = deadEarly(paths, "STEP-1", "2026-09-24T11:55:00.000Z")
    superviseJobs(deps)
    expect(existsSync(paths.pauseFile)).toBe(false)
    const second = submitJob(paths, "STEP-2", null, NOW)
    moveJob(paths, second.id, "pending", "running", { pid: 4243, startedAt: "2026-09-24T11:57:00.000Z" })
    superviseJobs({ ...deps, now: () => new Date("2026-09-24T12:01:00.000Z") })
    expect(JSON.parse(readFileSync(paths.pauseFile, "utf8"))).toEqual({ at: "2026-09-24T12:01:00.000Z", reason: "two workers in a row stopped within 10 minutes of starting" })
    expect(outbox(paths).at(-1)).toBe(
      `Paused: two workers in a row stopped within 10 minutes of starting, so the next would too. Their logs are worker-${first.id}.log and worker-${second.id}.log in ~/.agentd/logs. Run agentctl resume once it is fixed.`,
    )
    // Paused: the next pending job waits.
    submitJob(paths, "STEP-3", null, NOW)
    const spawned: string[] = []
    superviseJobs({ ...deps, spawnWorker: (id) => (spawned.push(id), 1) })
    expect(spawned).toEqual([])
  })

  it("count a worker that could not be started", () => {
    const { paths, deps } = setup({
      spawnWorker: () => {
        throw new Error("spawn EAGAIN")
      },
    })
    submitJob(paths, "STEP-1", null, new Date("2026-09-24T11:00:00.000Z"))
    superviseJobs(deps)
    submitJob(paths, "STEP-2", null, new Date("2026-09-24T11:01:00.000Z"))
    superviseJobs(deps)
    expect(existsSync(paths.pauseFile)).toBe(true)
  })

  it("do not count a worker that ran a while, one lost to a reboot, or one a finished job came between", () => {
    const late = setup({ isAlive: () => false })
    running(late.paths, "STEP-1", { startedAt: "2026-09-24T11:30:00.000Z" })
    superviseJobs(late.deps)
    running(late.paths, "STEP-2", { startedAt: "2026-09-24T11:55:00.000Z" })
    superviseJobs(late.deps)
    expect(existsSync(late.paths.pauseFile)).toBe(false)

    const reboot = setup({ isAlive: () => false, bootAt: new Date("2026-09-24T11:58:00.000Z") })
    running(reboot.paths, "STEP-1", { startedAt: "2026-09-24T11:55:00.000Z" })
    superviseJobs(reboot.deps)
    running(reboot.paths, "STEP-2", { startedAt: "2026-09-24T11:59:00.000Z" })
    superviseJobs(reboot.deps)
    expect(existsSync(reboot.paths.pauseFile)).toBe(false)

    const between = setup({ isAlive: () => false })
    deadEarly(between.paths, "STEP-1", "2026-09-24T11:55:00.000Z")
    superviseJobs(between.deps)
    const ok = submitJob(between.paths, "STEP-5", null, new Date("2026-09-24T11:56:00.000Z"))
    moveJob(between.paths, ok.id, "pending", "done", { endedAt: "2026-09-24T12:00:30.000Z", result: { status: "done", reason: "done", prUrl: null, branch: null, costUsd: null, turns: null, minutes: 4 } })
    deadEarly(between.paths, "STEP-2", "2026-09-24T11:58:00.000Z")
    superviseJobs({ ...between.deps, now: () => new Date("2026-09-24T12:01:00.000Z") })
    expect(existsSync(between.paths.pauseFile)).toBe(false)
  })
})

describe("isWorkerAlive", () => {
  it("counts a worker as alive when ps itself fails, rather than write a live one off", () => {
    expect(isWorkerAlive(process.pid, "STEP-7-20260924090000", "/nonexistent/ps")).toBe(true)
  })

  const children: ChildProcess[] = []
  afterEach(() => {
    for (const child of children.splice(0)) child.kill()
  })

  it("is true only for a live process whose command line is run.ts for this job", () => {
    // Its command line reads like a worker's: node ... src/worker/run.ts <job id>.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "/x/runtime/src/worker/run.ts", "STEP-7-20260924090000"], { stdio: "ignore" })
    children.push(child)
    expect(isWorkerAlive(child.pid!, "STEP-7-20260924090000")).toBe(true)
    // Another job's id, and a prefix of this one, are not this job.
    expect(isWorkerAlive(child.pid!, "STEP-8-20260924090000")).toBe(false)
    expect(isWorkerAlive(child.pid!, "STEP-7-2026092409000")).toBe(false)
  })

  it("is false for a pid that now belongs to some other process, or to none", () => {
    // After a crash the old pid can belong to anything: here, this test runner.
    expect(isWorkerAlive(process.pid, "STEP-7-20260924090000")).toBe(false)
    const gone = spawnSync(process.execPath, ["-e", ""]).pid!
    expect(isWorkerAlive(gone, "STEP-7-20260924090000")).toBe(false)
  })
})
