/**
 * agentd's job launcher: one develop job at a time (spec 6.3). The worker is
 * its own detached process group, so restarting agentd or the front door
 * never kills it. agentd starts it, notices when it dies, and stops it if it
 * overruns the runner's own wall clock by ten minutes. No task logic.
 *
 * A dead worker's commits are not pushed from here. They stay on this mini's
 * local STEP-<n>-<slug> branch, which the runner's prepareWorktree starts
 * from on the next run of that issue here, and pushing is the runner's job
 * (decision 2), from its own guarded path.
 */

import { spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { jobPath, listJobs, moveJob, updateJob, type JobRecord } from "../jobs.ts"
import { appendLedger, type Logger } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import { commandOf } from "../pidlock.ts"

export interface JobRunnerDeps {
  paths: AgentPaths
  config: AgentConfig
  now: () => Date
  log: Logger
  /** When the machine last booted: any job started before it is dead. */
  bootAt: Date
  /** Whether `pid` is still this job's worker (isWorkerAlive). */
  isAlive(pid: number, jobId: string): boolean
  /** Signals a whole process group when given a negative pid. */
  kill(pid: number, signal: NodeJS.Signals): void
  /** Starts run.ts for the job. Returns the pid of the new process group's leader. */
  spawnWorker(jobId: string): number
}

const GRACE_MINUTES = 10

/** Moves a job that will never report to done, as blocked, and tells #polads-agents. */
function endBlocked(deps: JobRunnerDeps, job: JobRecord, reason: string, startedAt: number, notice: string): void {
  const now = deps.now()
  moveJob(deps.paths, job.id, "running", "done", {
    endedAt: now.toISOString(),
    result: {
      status: "blocked",
      reason,
      prUrl: null,
      branch: null,
      costUsd: null,
      turns: null,
      minutes: Math.round((now.getTime() - startedAt) / 60_000),
    },
  })
  appendLedger(deps.paths, { type: "worker.end", issue: job.issue, status: "blocked", reason }, now)
  enqueueSlack(deps.paths, { kind: "post", channel: "agents", text: `${job.issue}: ${reason}. ${notice}` }, now)
}

export function superviseJobs(deps: JobRunnerDeps): void {
  const now = deps.now()
  const done = new Set(listJobs(deps.paths, "done").map((j) => j.id))
  let busy = false
  for (const job of listJobs(deps.paths, "running")) {
    if (done.has(job.id)) {
      rmSync(jobPath(deps.paths, "running", job.id), { force: true }) // a move that crashed halfway
      continue
    }
    const startedAt = Date.parse(job.startedAt ?? job.submittedAt)
    // A pid survives a reboot in the job file, and macOS reuses pids: a job
    // from before the boot is dead whatever that pid is now.
    const dead = !job.pid || startedAt < deps.bootAt.getTime() || !deps.isAlive(job.pid, job.id)
    if (dead) {
      const reason = job.killRequestedAt
        ? `the worker overran its wall clock of ${deps.config.worker.wallClockMinutes} minutes and was stopped`
        : "the worker process died before reporting"
      endBlocked(
        deps,
        job,
        reason,
        startedAt,
        `Anything it committed stays on this mini's local branch, where the next run of ${job.issue} here starts from it. ` +
          `Its claim is released after ${deps.config.claims.ttlHours} hours unless someone takes the issue first.`,
      )
      deps.log.warn("worker gone without reporting", { issue: job.issue, pid: job.pid, reason })
      continue
    }
    busy = true
    if (now.getTime() - startedAt <= (deps.config.worker.wallClockMinutes + GRACE_MINUTES) * 60_000) continue
    // The runner stops itself at its wall clock. One still running ten minutes
    // later is stuck: its whole group goes, and the dead path above reports it.
    if (!job.killRequestedAt) {
      deps.kill(-job.pid!, "SIGTERM")
      updateJob(deps.paths, "running", job.id, { killRequestedAt: now.toISOString() })
      deps.log.warn("worker overran, SIGTERM sent", { issue: job.issue, pid: job.pid })
    } else if (now.getTime() - Date.parse(job.killRequestedAt) > 60_000) {
      deps.kill(-job.pid!, "SIGKILL")
      deps.log.warn("worker ignored SIGTERM, SIGKILL sent", { issue: job.issue, pid: job.pid })
    }
  }
  if (busy || existsSync(deps.paths.pauseFile)) return
  const next = listJobs(deps.paths, "pending")[0]
  if (!next) return
  if (!moveJob(deps.paths, next.id, "pending", "running", { startedAt: now.toISOString() })) return
  let pid: number
  try {
    pid = deps.spawnWorker(next.id)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    endBlocked(deps, next, `the worker could not be started: ${message}`, now.getTime(), "A person needs to look.")
    deps.log.error("worker not started", { issue: next.issue, error: message })
    return
  }
  updateJob(deps.paths, "running", next.id, { pid })
  appendLedger(deps.paths, { type: "worker.start", issue: next.issue, pid }, now)
  deps.log.info("worker started", { issue: next.issue, pid })
}

/**
 * Whether `pid` is still the worker for `jobId`: a live process whose command
 * line is run.ts with that job id (spawnWorkerProcess). Any other process
 * that now has the pid, after a crash of agentd or a reboot, is not ours, and
 * signalling its group would hit a stranger.
 */
export function isWorkerAlive(pid: number, jobId: string): boolean {
  const args = commandOf(pid)?.trim().split(/\s+/) ?? []
  return args.some((a) => a.endsWith("worker/run.ts")) && args.includes(jobId)
}

export function spawnWorkerProcess(paths: AgentPaths, runtimeDir: string): (jobId: string) => number {
  return (jobId) => {
    mkdirSync(paths.logs, { recursive: true })
    const out = openSync(join(paths.logs, `worker-${jobId}.log`), "a")
    try {
      const child = spawn(process.execPath, ["--import", "tsx", join(runtimeDir, "src", "worker", "run.ts"), jobId], {
        cwd: runtimeDir,
        detached: true,
        stdio: ["ignore", out, out],
      })
      // A failed spawn is also emitted as 'error', and an unheard 'error' would take agentd down.
      child.on("error", () => {})
      child.unref()
      if (!child.pid) throw new Error(`could not start the worker for ${jobId}`)
      return child.pid
    } finally {
      closeSync(out)
    }
  }
}
