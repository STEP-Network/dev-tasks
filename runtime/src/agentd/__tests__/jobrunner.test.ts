import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew, writeJsonAtomic } from "../../fsq.ts"
import { heldBackIssues, listJobs, moveJob, submitJob, updateJob } from "../../jobs.ts"
import type { Logger } from "../../log.ts"
import { superviseJobs, workerLiveness, type JobRunnerDeps } from "../jobrunner.ts"

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
    liveness: (pid, jobId) => {
      asked.push([pid, jobId])
      return "ours"
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
    const { paths, deps, spawned } = setup({ liveness: () => "gone" })
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
    superviseJobs({ ...deps, liveness: () => "gone" })
    expect(listJobs(paths, "done")[0].result).toMatchObject({ status: "blocked", reason: "the worker overran its wall clock of 90 minutes and was stopped" })
    expect(outbox(paths)).toHaveLength(1)
    expect(outbox(paths)[0]).toMatch(/^STEP-1: the worker overran its wall clock of 90 minutes and was stopped\./)
  })

  it("counts the wall clock from the session's start, so a slow worktree never cuts a session or its finish short", () => {
    // Spawned 115 minutes ago, 25 of them preparing: the session is at 90 minutes, and the runner is finishing.
    const { paths, deps, kills } = setup()
    running(paths, "STEP-1", { startedAt: "2026-09-24T10:05:00.000Z", sessionStartedAt: "2026-09-24T10:30:00.000Z" })
    superviseJobs(deps)
    expect(kills).toEqual([])
    // 100 minutes into the session: past its own clock, and still inside the time to finish.
    superviseJobs({ ...deps, now: () => new Date("2026-09-24T12:10:00.000Z") })
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
    superviseJobs({ ...deps, liveness: () => "gone" })
    expect(listJobs(paths, "done").find((j) => j.id === job.id)?.result?.reason).toBe(
      "the worker was still preparing its worktree after 45 minutes and was stopped",
    )
  })

  it("never signals a worker ps cannot vouch for, and neither writes it off nor starts another", () => {
    const { paths, deps, kills, spawned } = setup({ liveness: () => "unknown" })
    running(paths, "STEP-1", { startedAt: "2026-09-24T09:00:00.000Z" })
    submitJob(paths, "STEP-2", null, NOW)
    superviseJobs(deps)
    superviseJobs({ ...deps, now: () => new Date("2026-09-24T12:05:00.000Z") })
    expect(kills).toEqual([])
    expect(listJobs(paths, "running").map((j) => j.issue)).toEqual(["STEP-1"])
    expect(spawned).toEqual([])
  })

  it("never overwrites the result a runner wrote just before it died", () => {
    // The runner wrote done, then died before it removed its running file.
    const { paths, deps } = setup()
    const job = running(paths, "STEP-1", {})
    const result = { status: "done" as const, reason: "done", prUrl: "https://github.com/x/pull/9", branch: "STEP-1-x", costUsd: 2, turns: 40, minutes: 30 }
    superviseJobs({
      ...deps,
      liveness: () => {
        writeJsonAtomic(join(paths.jobs, "done", `${job.id}.json`), { ...job, result })
        return "gone"
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
      liveness: () => {
        moveJob(paths, job.id, "running", "done", { result })
        return "gone"
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
  const lose = (paths: JobRunnerDeps["paths"], issue: string, submitted: string, started: string) => {
    const job = submitJob(paths, issue, null, new Date(submitted))
    moveJob(paths, job.id, "pending", "running", { pid: 4242, startedAt: started })
    return job
  }

  it("on one issue hold that issue back, and say so once, in the second loss's own notice", () => {
    const { paths, deps } = setup({ liveness: () => "gone" })
    lose(paths, "STEP-1", "2026-09-24T11:50:00.000Z", "2026-09-24T11:55:00.000Z")
    superviseJobs(deps)
    expect(heldBackIssues(paths)).toEqual(new Set())
    expect(outbox(paths)[0]).not.toMatch(/held back/)
    lose(paths, "STEP-1", "2026-09-24T11:56:00.000Z", "2026-09-24T11:57:00.000Z")
    superviseJobs({ ...deps, now: () => new Date("2026-09-24T12:01:00.000Z") })
    expect(heldBackIssues(paths)).toEqual(new Set(["STEP-1"]))
    expect(outbox(paths)).toHaveLength(2)
    expect(outbox(paths)[1]).toMatch(
      /Its last two workers died within 10 minutes of starting or never started, so STEP-1 is held back from new jobs until a person runs it by hand \(agentctl job submit --issue STEP-1\)\. Look for STEP-1 in ~\/\.agentd\/logs\/worker\.log and agentd\.log\.$/,
    )
    // The mini is not paused: other issues go on.
    expect(existsSync(paths.pauseFile)).toBe(false)
    // A person runs it by hand, and that job ends the ordinary way: the hold is lifted.
    const byHand = submitJob(paths, "STEP-1", null, new Date("2026-09-24T12:10:00.000Z"))
    moveJob(paths, byHand.id, "pending", "done", { endedAt: "2026-09-24T12:40:00.000Z", result: { status: "done", reason: "done", prUrl: null, branch: null, costUsd: null, turns: null, minutes: 30 } })
    expect(heldBackIssues(paths)).toEqual(new Set())
  })

  it("on two different issues pause the mini once, name the likely cause, and hold neither issue back", () => {
    const { paths, deps } = setup({ liveness: () => "gone" })
    const first = lose(paths, "STEP-1", "2026-09-24T11:50:00.000Z", "2026-09-24T11:55:00.000Z")
    superviseJobs(deps)
    const second = lose(paths, "STEP-2", "2026-09-24T11:56:00.000Z", "2026-09-24T11:57:00.000Z")
    superviseJobs({ ...deps, now: () => new Date("2026-09-24T12:01:00.000Z") })
    expect(JSON.parse(readFileSync(paths.pauseFile, "utf8"))).toEqual({
      at: "2026-09-24T12:01:00.000Z",
      reason: "early losses on two different issues in a row (STEP-1, STEP-2): a fault on this mini",
    })
    expect(heldBackIssues(paths)).toEqual(new Set())
    // One notice per loss: the pause is said in the second, never in a post of its own, and no hold is.
    const posts = outbox(paths)
    expect(posts).toHaveLength(2)
    expect(posts[0]).not.toMatch(/paused|held back/)
    expect(posts[1]).toMatch(/^STEP-2: the worker process died before reporting\. .* It is the second worker in a row, after STEP-1's, to die within 10 minutes of starting or never start, which points at this mini rather than the issues: /)
    expect(posts[1].endsWith(`The mini is paused. Look for ${first.id} and ${second.id} in ~/.agentd/logs/worker.log and agentd.log, and run agentctl resume once it is fixed.`)).toBe(true)
    expect(posts[1]).not.toMatch(/held back/)

    // Both losses were the mini's. After a resume, one more loss neither pauses again nor holds an issue back.
    rmSync(paths.pauseFile)
    lose(paths, "STEP-1", "2026-09-24T12:02:00.000Z", "2026-09-24T12:05:00.000Z")
    superviseJobs({ ...deps, now: () => new Date("2026-09-24T12:06:00.000Z") })
    expect(existsSync(paths.pauseFile)).toBe(false)
    expect(heldBackIssues(paths)).toEqual(new Set())
    expect(outbox(paths).at(-1)).not.toMatch(/paused|held back/)
  })

  it("need the loss before to be early too: a job of another issue that ended otherwise is no fault", () => {
    const { paths, deps } = setup({ liveness: () => "gone" })
    const ok = submitJob(paths, "STEP-5", null, new Date("2026-09-24T11:00:00.000Z"))
    moveJob(paths, ok.id, "pending", "done", { endedAt: "2026-09-24T11:50:00.000Z", result: { status: "done", reason: "done", prUrl: null, branch: null, costUsd: null, turns: null, minutes: 45 } })
    lose(paths, "STEP-2", "2026-09-24T11:51:00.000Z", "2026-09-24T11:55:00.000Z")
    superviseJobs(deps)
    expect(existsSync(paths.pauseFile)).toBe(false)
    expect(heldBackIssues(paths)).toEqual(new Set())
  })

  it("on two different issues that could not be started pause the mini too", () => {
    const { paths, deps } = setup({
      spawnWorker: () => {
        throw new Error("spawn EAGAIN")
      },
    })
    submitJob(paths, "STEP-1", null, new Date("2026-09-24T11:00:00.000Z"))
    superviseJobs(deps)
    submitJob(paths, "STEP-2", null, new Date("2026-09-24T11:01:00.000Z"))
    superviseJobs({ ...deps, now: () => new Date("2026-09-24T12:00:10.000Z") })
    expect(existsSync(paths.pauseFile)).toBe(true)
    expect(heldBackIssues(paths)).toEqual(new Set())
  })

  it("on one issue count a worker that could not be started", () => {
    const { paths, deps } = setup({
      spawnWorker: () => {
        throw new Error("spawn EAGAIN")
      },
    })
    submitJob(paths, "STEP-1", null, new Date("2026-09-24T11:00:00.000Z"))
    superviseJobs(deps)
    submitJob(paths, "STEP-1", null, new Date("2026-09-24T11:01:00.000Z"))
    superviseJobs({ ...deps, now: () => new Date("2026-09-24T12:00:10.000Z") })
    expect(heldBackIssues(paths)).toEqual(new Set(["STEP-1"]))
  })

  it("do not count a worker that ran a while, one lost to a reboot, or a job of the issue that ended otherwise in between", () => {
    const late = setup({ liveness: () => "gone" })
    lose(late.paths, "STEP-1", "2026-09-24T11:00:00.000Z", "2026-09-24T11:30:00.000Z")
    superviseJobs(late.deps)
    lose(late.paths, "STEP-1", "2026-09-24T11:50:00.000Z", "2026-09-24T11:55:00.000Z")
    superviseJobs({ ...late.deps, now: () => new Date("2026-09-24T12:01:00.000Z") })
    expect(heldBackIssues(late.paths)).toEqual(new Set())

    const reboot = setup({ liveness: () => "gone", bootAt: new Date("2026-09-24T11:58:00.000Z") })
    lose(reboot.paths, "STEP-1", "2026-09-24T11:50:00.000Z", "2026-09-24T11:55:00.000Z")
    superviseJobs(reboot.deps)
    lose(reboot.paths, "STEP-1", "2026-09-24T11:58:30.000Z", "2026-09-24T11:59:00.000Z")
    superviseJobs({ ...reboot.deps, now: () => new Date("2026-09-24T12:01:00.000Z") })
    expect(heldBackIssues(reboot.paths)).toEqual(new Set())

    const between = setup({ liveness: () => "gone" })
    lose(between.paths, "STEP-1", "2026-09-24T11:50:00.000Z", "2026-09-24T11:55:00.000Z")
    superviseJobs(between.deps)
    const ok = submitJob(between.paths, "STEP-1", null, new Date("2026-09-24T11:56:00.000Z"))
    moveJob(between.paths, ok.id, "pending", "done", { endedAt: "2026-09-24T12:00:30.000Z", result: { status: "skipped", reason: "the issue is In Review, not Ready", prUrl: null, branch: null, costUsd: null, turns: null, minutes: 0 } })
    lose(between.paths, "STEP-1", "2026-09-24T11:57:00.000Z", "2026-09-24T11:58:00.000Z")
    superviseJobs({ ...between.deps, now: () => new Date("2026-09-24T12:01:00.000Z") })
    expect(heldBackIssues(between.paths)).toEqual(new Set())
  })
})


describe("workerLiveness", () => {
  it("is unknown when ps itself fails: neither written off nor signalled", () => {
    expect(workerLiveness(process.pid, "STEP-7-20260924090000", "/nonexistent/ps")).toBe("unknown")
  })

  const children: ChildProcess[] = []
  afterEach(() => {
    for (const child of children.splice(0)) child.kill()
  })

  it("is ours only for a live process whose command line is run.ts for this job", () => {
    // Its command line reads like a worker's: node ... src/worker/run.ts <job id>.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "/x/runtime/src/worker/run.ts", "STEP-7-20260924090000"], { stdio: "ignore" })
    children.push(child)
    expect(workerLiveness(child.pid!, "STEP-7-20260924090000")).toBe("ours")
    // Another job's id, and a prefix of this one, are not this job.
    expect(workerLiveness(child.pid!, "STEP-8-20260924090000")).toBe("gone")
    expect(workerLiveness(child.pid!, "STEP-7-2026092409000")).toBe("gone")
  })

  it("is gone for a pid that now belongs to some other process, or to none", () => {
    // After a crash the old pid can belong to anything: here, this test runner.
    expect(workerLiveness(process.pid, "STEP-7-20260924090000")).toBe("gone")
    const gone = spawnSync(process.execPath, ["-e", ""]).pid!
    expect(workerLiveness(gone, "STEP-7-20260924090000")).toBe("gone")
  })
})
