/**
 * agentd's job launcher: one develop job at a time (spec 6.3). The worker is
 * its own detached process group, so restarting agentd or the front door
 * never kills it. agentd starts it, notices when it dies, and stops it if it
 * overruns the runner's own limits. No task logic.
 *
 * A dead worker's commits are not pushed from here. They stay on this mini's
 * local STEP-<n>-<slug> branch, which the runner's prepareWorktree starts
 * from on the next run of that issue here, and pushing is the runner's job
 * (decision 2), from its own guarded path.
 *
 * A worker that dies within minutes of its start, or cannot be started, is
 * lost early: its issue stays Ready and would be offered again at every
 * wakeup. Two early losses in a row on one issue hold that issue back
 * (heldBackIssues). Two in a row on different issues are a fault of the
 * mini, and pause it. The second loss's own notice says which, once.
 */

import { spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { heldBackIssues, jobPath, listJobs, moveJob, updateJob, type JobRecord } from "../jobs.ts"
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

/** Before its session the runner claims and prepares the worktree, pnpm install included (up to 20 minutes). */
export const PREP_ALLOWANCE_MINUTES = 45
/** After its own wall clock the runner still pushes, opens the PR and writes to Linear. */
export const FINISH_GRACE_MINUTES = 15
/** A worker that dies this soon after its start most likely died of something the next one would meet too. */
export const EARLY_DEATH_MINUTES = 10

/**
 * When a still-running worker is stuck: its session's wall clock plus the
 * time to finish, counted from the session's start, which the runner marks.
 * Until it does, the runner is preparing, and that has its own allowance.
 */
function deadline(job: JobRecord, startedAt: number, config: AgentConfig): number {
  if (job.sessionStartedAt) return Date.parse(job.sessionStartedAt) + (config.worker.wallClockMinutes + FINISH_GRACE_MINUTES) * 60_000
  return startedAt + PREP_ALLOWANCE_MINUTES * 60_000
}

/**
 * Moves a job that will never report to done, as blocked, and tells
 * #polads-agents. Nothing is said, and nothing overwritten, when the job has
 * reached done meanwhile: its runner reported after all, in the moment
 * before it exited.
 */
function endBlocked(deps: JobRunnerDeps, job: JobRecord, reason: string, startedAt: number, notice: string, lostEarly: boolean): boolean {
  const now = deps.now()
  if (existsSync(jobPath(deps.paths, "done", job.id))) {
    rmSync(jobPath(deps.paths, "running", job.id), { force: true })
    return false
  }
  // Decided before this loss joins the record: the job that ended just before it.
  const previous = lostEarly ? lastFinished(deps.paths) : null
  const miniFault = previous !== null && previous.lostEarly === true && previous.issue !== job.issue
  const moved = moveJob(deps.paths, job.id, "running", "done", {
    endedAt: now.toISOString(),
    ...(lostEarly ? { lostEarly } : {}),
    ...(miniFault ? { miniFault } : {}),
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
  if (!moved) return false
  appendLedger(deps.paths, { type: "worker.end", issue: job.issue, status: "blocked", reason }, now)
  // What the second early loss in a row means is said once, in the notice of that loss itself.
  let more = ""
  if (miniFault && previous) {
    updateJob(deps.paths, "done", previous.id, { miniFault: true })
    pauseForMiniFault(deps, [previous, job], now)
    more =
      ` It is the second worker in a row, after ${previous.issue}'s, to stop within ${EARLY_DEATH_MINUTES} minutes of starting, which points at this mini rather than the issues: ` +
      `a broken install, a secrets file the runner refuses (~/.config/agentd/claude.env must be chmod 600), or a missing SDK. ` +
      `The mini is paused. The logs are worker-${previous.id}.log and worker-${job.id}.log in ~/.agentd/logs. Run agentctl resume once it is fixed.`
  } else if (lostEarly && heldBackIssues(deps.paths).has(job.issue)) {
    more = ` Its last two workers stopped within ${EARLY_DEATH_MINUTES} minutes of starting, so ${job.issue} is held back from new jobs until a person runs it by hand (agentctl job submit --issue ${job.issue}). The logs are in ~/.agentd/logs/worker-${job.issue}-*.log.`
    deps.log.error("issue held back after two early losses", { issue: job.issue })
  }
  enqueueSlack(deps.paths, { kind: "post", channel: "agents", text: `${job.issue}: ${reason}. ${notice}${more}` }, now)
  return true
}

/** The job that finished last, leaving out the losses already put down to a fault of the mini. */
function lastFinished(paths: AgentPaths): JobRecord | null {
  return (
    listJobs(paths, "done")
      .filter((j) => j.endedAt && !j.miniFault)
      .sort((a, b) => a.endedAt!.localeCompare(b.endedAt!))
      .at(-1) ?? null
  )
}

/**
 * Early losses on two different issues in a row are a fault of the mini, not
 * of the issues: every issue would be lost the same way. PAUSE, in the shape
 * agentctl pause writes, stops new jobs until a person resumes. The two
 * losses are marked miniFault, so neither holds its issue back nor counts
 * towards a later streak.
 */
function pauseForMiniFault(deps: JobRunnerDeps, lost: JobRecord[], now: Date): void {
  const reason = `early losses on two different issues in a row (${lost.map((j) => j.issue).join(", ")}): a fault on this mini`
  deps.log.error("paused: a fault on the mini", { jobs: lost.map((j) => j.id) })
  if (existsSync(deps.paths.pauseFile)) return
  mkdirSync(deps.paths.root, { recursive: true })
  writeFileSync(deps.paths.pauseFile, JSON.stringify({ at: now.toISOString(), reason }))
  appendLedger(deps.paths, { type: "paused", reason }, now)
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
    const beforeBoot = startedAt < deps.bootAt.getTime()
    const dead = !job.pid || beforeBoot || !deps.isAlive(job.pid, job.id)
    if (dead) {
      const reason = !job.killRequestedAt
        ? "the worker process died before reporting"
        : job.sessionStartedAt
          ? `the worker overran its wall clock of ${deps.config.worker.wallClockMinutes} minutes and was stopped`
          : `the worker was still preparing its worktree after ${PREP_ALLOWANCE_MINUTES} minutes and was stopped`
      // A reboot or a stop is no sign that the next worker will die too.
      const lostEarly = !beforeBoot && !job.killRequestedAt && now.getTime() - startedAt < EARLY_DEATH_MINUTES * 60_000
      const said = endBlocked(
        deps,
        job,
        reason,
        startedAt,
        `Anything it committed stays on this mini's local branch, where the next run of ${job.issue} here starts from it. ` +
          `If it had claimed the issue, the claim is released after ${deps.config.claims.ttlHours} hours unless someone takes the issue first.`,
        lostEarly,
      )
      if (said) deps.log.warn("worker gone without reporting", { issue: job.issue, pid: job.pid, reason })
      continue
    }
    busy = true
    if (now.getTime() <= deadline(job, startedAt, deps.config)) continue
    // The runner stops itself at its wall clock. One still running past the
    // deadline is stuck: its whole group goes, and the dead path above reports it.
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
    endBlocked(deps, next, `the worker could not be started: ${message}`, now.getTime(), "A person needs to look.", true)
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
 * signalling its group would hit a stranger. When ps itself fails, nobody can
 * tell, and a live worker must not be written off: it counts as alive.
 */
export function isWorkerAlive(pid: number, jobId: string, ps?: string): boolean {
  const command = commandOf(pid, ps)
  if (command === undefined) return true
  const args = command?.trim().split(/\s+/) ?? []
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
