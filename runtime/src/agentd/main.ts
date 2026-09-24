/**
 * agentd, launchd job eu.polads.agentd: the watchdog (spec 6.2) and the job
 * launcher, in one 15-second loop. No task logic. Every step is caught and
 * logged on its own, so one failing duty never stops the others. It never
 * reads the Slack tokens: everything it says goes through the outbox, and the
 * bridge starts each message with the mini's name.
 */

import { mkdirSync } from "node:fs"
import { uptime } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { agentPaths, assertProfileMini, loadConfig, readProfileMini, type AgentConfig, type AgentPaths } from "../config.ts"
import { readJson, writeJsonAtomic } from "../fsq.ts"
import { listJobs } from "../jobs.ts"
import { appendLedger, createLogger, redact, type Logger } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import { releasePidLock, takePidLock } from "../pidlock.ts"
import { assertLinearKeyFile, loadSentryCronUrl } from "../secrets.ts"
import { createLinearTracker, type Tracker } from "../tracker.ts"
import { readUsage } from "../usage.ts"
import { realExec, type Exec } from "../worker/git.ts"
import { heartbeatAndSweep } from "./claims.ts"
import { frontDoorAlive, lastTickAt, readFrontDoorState, superviseFrontDoor } from "./frontdoor.ts"
import { cleanup, Every, healthStatus, inboxStuck, linearDownNotice, refreshCheckout, sentryCheckInUrl, watchPrs, type BridgeHeartbeat } from "./health.ts"
import { spawnWorkerProcess, superviseJobs, workerLiveness, type Liveness } from "./jobrunner.ts"

const TICK_MS = 15_000

/**
 * What agentd checks on this machine before it starts, in this order:
 * config.json, the mini's one name (decision 2: config.json and the machine
 * profile must agree, or claims are signed with a name the heartbeat never
 * finds), and the Linear key file. The Sentry check-in URL is optional.
 */
export function checkLocal(paths: AgentPaths, profileMini: string | null): { config: AgentConfig; sentryUrl: string | null } {
  const config = loadConfig(paths)
  assertProfileMini(config, profileMini, paths.config)
  assertLinearKeyFile(paths.home)
  return { config, sentryUrl: loadSentryCronUrl(paths.home) }
}

/** Signals a process group, ignoring one that ended between the liveness check and the signal. */
export function killGroup(pid: number, signal: NodeJS.Signals | number): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

export interface DutyDeps {
  paths: AgentPaths
  config: AgentConfig
  log: Logger
  exec: Exec
  tracker: Tracker
  now: () => Date
  every: Every
  bootAt: Date
  liveness: (pid: number, jobId: string) => Liveness
  kill: (pid: number, signal: NodeJS.Signals) => void
  spawnWorker: (jobId: string) => number
  sentryUrl: string | null
  /** One GET of the Sentry check-in URL. */
  checkIn: (url: string) => Promise<{ ok: boolean; status: number }>
}

/** What agentd carries from one loop to the next. */
export interface DutyMemo {
  linearDown: { downSince: string | null; notified: boolean }
  /** outbox/failed's count at the last health check. null until the first: what was there when agentd started is not news. */
  outboxFailedSeen: number | null
  /** The last checkout refresh's result, for the health check. */
  lastRefresh: string | null
}

export const freshMemo = (): DutyMemo => ({ linearDown: { downSince: null, notified: false }, outboxFailedSeen: null, lastRefresh: null })

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** One pass of the loop: every duty that is due, each caught on its own. */
export async function runDuties(d: DutyDeps, memo: DutyMemo): Promise<void> {
  const { paths, config, log, now } = d
  const step = async (name: string, fn: () => unknown) => {
    try {
      await fn()
    } catch (error) {
      log.error(`${name} failed`, { error: message(error) })
    }
  }
  await step("front door", () => superviseFrontDoor({ paths, config, exec: d.exec, now, log, usage: () => readUsage(paths) }))
  await step("jobs", () => superviseJobs({ paths, config, now, log, bootAt: d.bootAt, liveness: d.liveness, kill: d.kill, spawnWorker: d.spawnWorker }))
  // The main checkout and its worktrees change only between jobs: a job
  // fetches into the same repository, and its session loads the project's
  // settings and hooks from this checkout (projectConfigRoot).
  const jobActive = listJobs(paths, "running").length > 0 || listJobs(paths, "pending").length > 0
  if (d.every.due("claims", config.claims.heartbeatMinutes * 60_000)) {
    await step("claims", async () => {
      let ok = false
      try {
        const r = await heartbeatAndSweep({ tracker: d.tracker, paths, config, now, liveness: d.liveness, log })
        if (r.refreshed || r.released) log.info("claims", r)
        ok = true
      } finally {
        const notice = linearDownNotice(memo.linearDown, ok, now())
        memo.linearDown = notice.state
        if (notice.message) enqueueSlack(paths, { kind: "post", channel: "agents", text: notice.message }, now())
      }
    })
  }
  if (d.every.due("prs", 15 * 60_000)) await step("prs", () => watchPrs({ exec: d.exec, paths, config, now, log }))
  if (!jobActive && d.every.due("checkout", 10 * 60_000)) {
    await step("checkout", async () => {
      memo.lastRefresh = await refreshCheckout(d.exec, config.repo.path, config.repo.base)
      log.info("checkout", { result: memo.lastRefresh })
    })
  }
  if (d.every.due("health", 5 * 60_000)) {
    await step("health", async () => {
      const fd = readFrontDoorState(paths)
      const bridge = readJson<BridgeHeartbeat>(join(paths.state, "bridge.json"))
      const verdict = healthStatus({
        frontDoorAlive: await frontDoorAlive({ exec: d.exec, config }),
        lastWakeAt: lastTickAt(paths),
        lastStartAt: fd.lastStartAt ? new Date(fd.lastStartAt) : null,
        bridge,
        now: now(),
        staleTickMinutes: config.frontDoor.staleTickMinutes,
        outboxFailedBefore: memo.outboxFailedSeen,
        stuckInbox: inboxStuck(paths, now()),
        checkout: memo.lastRefresh,
      })
      memo.outboxFailedSeen = bridge?.outboxFailed ?? memo.outboxFailedSeen
      if (!verdict.ok) log.warn("unhealthy", { problems: verdict.problems })
      if (!d.sentryUrl) return
      // The URL carries the monitor's key: it is never logged.
      const res = await d.checkIn(sentryCheckInUrl(d.sentryUrl, verdict.ok))
      if (!res.ok) log.warn("Sentry check-in refused", { status: res.status })
    })
  }
  if (d.every.due("usage", 60 * 60_000)) {
    await step("usage", () => {
      const u = readUsage(paths)
      if (u) appendLedger(paths, { type: "usage", fiveHourPct: u.fiveHourPct, sevenDayPct: u.sevenDayPct }, now())
    })
  }
  if (!jobActive && d.every.due("cleanup", 24 * 60 * 60_000)) await step("cleanup", () => cleanup({ paths, config, exec: d.exec, now }))
}

async function main(): Promise<void> {
  const paths = agentPaths()
  const log = createLogger(paths, "agentd")
  mkdirSync(paths.state, { recursive: true })
  const status = (extra: Record<string, unknown> = {}) => writeJsonAtomic(join(paths.state, "agentd.json"), { pid: process.pid, at: new Date().toISOString(), ...extra })

  // One agentd per mini: a second would start a second worker and a second
  // front door. It leaves agentd.json alone, which is the running agentd's,
  // and exits 1, so launchd's copy takes over once the other ends.
  const lockPath = join(paths.state, "agentd.pid")
  const lock = takePidLock(lockPath, "agentd/main.ts")
  if (!lock.ok) {
    log.error("another agentd is running", { pid: lock.holder })
    console.error(`agentd: another agentd is running here, pid ${lock.holder}`)
    process.exit(1)
  }
  process.on("exit", () => releasePidLock(lockPath))
  process.on("SIGTERM", () => process.exit(143))
  process.on("SIGINT", () => process.exit(130))

  let setup: { config: AgentConfig; sentryUrl: string | null }
  try {
    setup = checkLocal(paths, readProfileMini())
  } catch (error) {
    // Exit 0: launchd restarts only a failed exit (Task 17), and a config
    // problem does not fix itself. agentctl status shows the error.
    const why = redact(message(error))
    log.error("agentd cannot start", { error: why })
    status({ error: why })
    process.exit(0)
  }
  const { config, sentryUrl } = setup
  const runtimeDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
  const bootAt = new Date(Date.now() - uptime() * 1000)
  const deps: DutyDeps = {
    paths,
    config,
    log,
    exec: realExec,
    tracker: createLinearTracker(),
    now: () => new Date(),
    every: new Every(() => Date.now()),
    bootAt,
    liveness: workerLiveness,
    kill: killGroup,
    spawnWorker: spawnWorkerProcess(paths, runtimeDir),
    sentryUrl,
    checkIn: (url) => fetch(url, { signal: AbortSignal.timeout(10_000) }),
  }
  const memo = freshMemo()
  let running = false
  const loop = async () => {
    if (running) return
    running = true
    try {
      await runDuties(deps, memo)
      status()
    } finally {
      running = false
    }
  }

  setInterval(() => void loop(), TICK_MS)
  void loop()
  log.info("agentd started", { mini: config.mini, runtimeDir, bootAt: bootAt.toISOString() })
}

if (process.argv[1]?.endsWith("agentd/main.ts")) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
