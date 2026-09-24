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
import { appendLedger, createLogger, redact } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import { releasePidLock, takePidLock } from "../pidlock.ts"
import { assertLinearKeyFile, loadSentryCronUrl } from "../secrets.ts"
import { createLinearTracker } from "../tracker.ts"
import { readUsage } from "../usage.ts"
import { realExec } from "../worker/git.ts"
import { heartbeatAndSweep } from "./claims.ts"
import { frontDoorAlive, lastTickAt, readFrontDoorState, superviseFrontDoor } from "./frontdoor.ts"
import { cleanup, Every, healthStatus, inboxStuck, linearDownNotice, refreshCheckout, sentryCheckInUrl, watchPrs, type BridgeHeartbeat } from "./health.ts"
import { isWorkerAlive, spawnWorkerProcess, superviseJobs } from "./jobrunner.ts"

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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

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
  const tracker = createLinearTracker()
  const every = new Every(() => Date.now())
  const bootAt = new Date(Date.now() - uptime() * 1000)
  const now = () => new Date()
  const spawnWorker = spawnWorkerProcess(paths, runtimeDir)
  const kill = (pid: number, signal: NodeJS.Signals) => {
    try {
      process.kill(pid, signal)
    } catch (error) {
      // The group ended between the liveness check and the signal.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  let linearDown = { downSince: null as string | null, notified: false }
  // What was in outbox/failed when agentd started is not news: only growth is.
  let outboxFailedSeen: number | null = null
  let running = false

  const step = async (name: string, fn: () => unknown) => {
    try {
      await fn()
    } catch (error) {
      log.error(`${name} failed`, { error: message(error) })
    }
  }

  const loop = async () => {
    if (running) return
    running = true
    try {
      await step("front door", () => superviseFrontDoor({ paths, config, exec: realExec, now, log, usage: () => readUsage(paths) }))
      await step("jobs", () => superviseJobs({ paths, config, now, log, bootAt, isAlive: isWorkerAlive, kill, spawnWorker }))
      // The main checkout and its worktrees change only between jobs: a job
      // fetches into the same repository, and its session loads the
      // project's settings and hooks from this checkout (projectConfigRoot).
      const jobActive = listJobs(paths, "running").length > 0 || listJobs(paths, "pending").length > 0
      if (every.due("claims", config.claims.heartbeatMinutes * 60_000)) {
        await step("claims", async () => {
          let ok = false
          try {
            const r = await heartbeatAndSweep({ tracker, paths, config, now, isAlive: isWorkerAlive, log })
            if (r.refreshed || r.released) log.info("claims", r)
            ok = true
          } finally {
            const notice = linearDownNotice(linearDown, ok, now())
            linearDown = notice.state
            if (notice.message) enqueueSlack(paths, { kind: "post", channel: "agents", text: notice.message }, now())
          }
        })
      }
      if (every.due("prs", 15 * 60_000)) await step("prs", () => watchPrs({ exec: realExec, paths, config, now, log }))
      if (!jobActive && every.due("checkout", 10 * 60_000)) {
        await step("checkout", async () => log.info("checkout", { result: await refreshCheckout(realExec, config.repo.path, config.repo.base) }))
      }
      if (every.due("health", 5 * 60_000)) {
        await step("health", async () => {
          const fd = readFrontDoorState(paths)
          const bridge = readJson<BridgeHeartbeat>(join(paths.state, "bridge.json"))
          const verdict = healthStatus({
            frontDoorAlive: await frontDoorAlive({ exec: realExec, config }),
            lastWakeAt: lastTickAt(paths) ?? (fd.lastStartAt ? new Date(fd.lastStartAt) : null),
            bridge,
            now: now(),
            staleTickMinutes: config.frontDoor.staleTickMinutes,
            outboxFailedBefore: outboxFailedSeen,
            stuckInbox: inboxStuck(paths, now()),
          })
          outboxFailedSeen = bridge?.outboxFailed ?? outboxFailedSeen
          if (!verdict.ok) log.warn("unhealthy", { problems: verdict.problems })
          if (!sentryUrl) return
          // The URL carries the monitor's key: it is never logged.
          const res = await fetch(sentryCheckInUrl(sentryUrl, verdict.ok), { signal: AbortSignal.timeout(10_000) })
          if (!res.ok) log.warn("Sentry check-in refused", { status: res.status })
        })
      }
      if (every.due("usage", 60 * 60_000)) {
        await step("usage", () => {
          const u = readUsage(paths)
          if (u) appendLedger(paths, { type: "usage", fiveHourPct: u.fiveHourPct, sevenDayPct: u.sevenDayPct }, now())
        })
      }
      if (!jobActive && every.due("cleanup", 24 * 60 * 60_000)) await step("cleanup", () => cleanup({ paths, config, exec: realExec, now }))
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
