/**
 * The watchdog's front-door duties (spec 6.2): start it at boot, restart it
 * when it exits, and restart it with --resume when it stops waking up (a
 * third rate-limit stop, a /loop past its 7-day expiry, a hang), after the
 * usage limit resets when that is the cause. Three starts in an hour means a
 * restart will not fix it: wait 30 minutes and say so, at most once an hour.
 *
 * Two things it does not take on trust. The session's id comes from the
 * status line (its payload carries `session_id`), so nothing has to pin one
 * at start. And if no wakeup follows a start within five minutes, it types
 * the /loop prompt into tmux once, in case the prompt on the command line was
 * not submitted.
 *
 * tmux targets name the session exactly (`=frontdoor`): a bare name also
 * matches any session it begins, such as a person's `frontdoor-old`.
 */

import { join } from "node:path"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { readJson, writeJsonAtomic } from "../fsq.ts"
import { appendLedger, type Logger } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import { tickPath } from "../tick.ts"
import { limitedUntil, type UsageSnapshot } from "../usage.ts"
import type { Exec } from "../worker/git.ts"

export const LOOP_PROMPT = "/loop /dev-tasks:front-door"
const KICK_AFTER_MINUTES = 5
/** tmux answers at once. One that hangs must not hold up the job launcher behind it. */
const TMUX_TIMEOUT_MS = 30_000

export interface FrontDoorState {
  /** The running conversation, as the status line reports it. null until it has. */
  sessionId: string | null
  lastStartAt: string | null
  /** Start times within the last hour. */
  starts: string[]
  /** Consecutive exits within 90 seconds of a start: a resume that keeps failing. */
  fastExits: number
  waitUntil: string | null
  lastAlertAt: string | null
  /** When the loop prompt was typed in after the current start, if it was. */
  kickedAt: string | null
}

export const FRESH_FRONT_DOOR: FrontDoorState = {
  sessionId: null,
  lastStartAt: null,
  starts: [],
  fastExits: 0,
  waitUntil: null,
  lastAlertAt: null,
  kickedAt: null,
}

export type FrontDoorAction =
  | { kind: "none" }
  | { kind: "start"; mode: "new" | "resume"; reason: string; fastExits: number }
  | { kind: "restart"; reason: string }
  | { kind: "kick"; reason: string }
  /** alert: the front door keeps exiting, which a person must hear about. Otherwise a usage limit, which resets by itself. */
  | { kind: "wait"; until: string; reason: string; alert: boolean }

export interface FrontDoorInput {
  now: Date
  alive: boolean
  lastTickAt: Date | null
  state: FrontDoorState
  usage: UsageSnapshot | null
  staleTickMinutes: number
}

export function decideFrontDoor(i: FrontDoorInput): FrontDoorAction {
  const now = i.now.getTime()
  if (i.state.waitUntil && now < Date.parse(i.state.waitUntil)) return { kind: "none" }
  const lastStart = i.state.lastStartAt ? Date.parse(i.state.lastStartAt) : null
  if (!i.alive) {
    const recent = i.state.starts.filter((t) => Date.parse(t) > now - 3_600_000)
    if (recent.length >= 3) {
      return { kind: "wait", until: new Date(now + 30 * 60_000).toISOString(), reason: `the front door exited ${recent.length} times in the last hour`, alert: true }
    }
    const fastExit = lastStart !== null && now - lastStart < 90_000
    const fastExits = fastExit ? i.state.fastExits + 1 : 0
    const mode = i.state.sessionId && fastExits < 2 ? "resume" : "new"
    const reason = lastStart === null ? "first start" : fastExit ? "it exited right after starting" : "it exited"
    return { kind: "start", mode, reason, fastExits }
  }
  const tick = i.lastTickAt?.getTime() ?? 0
  if (lastStart !== null && tick < lastStart && !i.state.kickedAt && now - lastStart > KICK_AFTER_MINUTES * 60_000) {
    return { kind: "kick", reason: `no wakeup in the ${KICK_AFTER_MINUTES} minutes since the start` }
  }
  const since = Math.max(tick, lastStart ?? 0)
  if (now - since <= i.staleTickMinutes * 60_000) return { kind: "none" }
  const until = limitedUntil(i.usage, i.now)
  if (until) {
    return { kind: "wait", until: new Date(until.getTime() + 60_000).toISOString(), reason: "the usage limit is reached, restarting after it resets", alert: false }
  }
  return { kind: "restart", reason: `no wakeup for ${Math.round((now - since) / 60_000)} minutes` }
}

/** The status line reports the running session's id. Adopt it once it is newer than the last start. */
export function adoptSessionId(state: FrontDoorState, usage: UsageSnapshot | null): FrontDoorState {
  if (!usage?.sessionId || usage.sessionId === state.sessionId || !state.lastStartAt) return state
  if (Date.parse(usage.at) < Date.parse(state.lastStartAt)) return state
  return { ...state, sessionId: usage.sessionId }
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** The front door's command line (spec 6.1), as one shell string for tmux. */
export function claudeCommand(o: { claudePath: string; resumeId: string | null; model: string }): string {
  return [
    o.claudePath,
    ...(o.resumeId ? ["--resume", o.resumeId] : []),
    "--model",
    o.model,
    "--permission-mode",
    "auto",
    "--permission-prompts",
    "none",
    // Self-paced loops are not restored on resume, so every start re-arms it.
    LOOP_PROMPT,
  ]
    .map(shellQuote)
    .join(" ")
}

const statePath = (paths: AgentPaths) => join(paths.state, "frontdoor.json")

export function readFrontDoorState(paths: AgentPaths): FrontDoorState {
  return { ...FRESH_FRONT_DOOR, ...(readJson<Partial<FrontDoorState>>(statePath(paths)) ?? {}) }
}

export function lastTickAt(paths: AgentPaths): Date | null {
  const tick = readJson<{ at: string }>(tickPath(paths))
  return tick ? new Date(tick.at) : null
}

export async function frontDoorAlive(deps: { exec: Exec; config: AgentConfig }): Promise<boolean> {
  return (await deps.exec("tmux", ["has-session", "-t", `=${deps.config.frontDoor.tmuxSession}`], { timeoutMs: TMUX_TIMEOUT_MS })).code === 0
}

export interface FrontDoorDeps {
  paths: AgentPaths
  config: AgentConfig
  exec: Exec
  now: () => Date
  log: Logger
}

export async function applyFrontDoor(deps: FrontDoorDeps, state: FrontDoorState, action: FrontDoorAction): Promise<FrontDoorState> {
  const now = deps.now()
  const session = deps.config.frontDoor.tmuxSession
  const tmux = (args: string[]) => deps.exec("tmux", args, { timeoutMs: TMUX_TIMEOUT_MS })
  if (action.kind === "none") return state
  if (action.kind === "wait") {
    const alertDue = action.alert && (!state.lastAlertAt || now.getTime() - Date.parse(state.lastAlertAt) > 3_600_000)
    if (alertDue) {
      const zone = deps.config.queue.timeZone
      const at = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(action.until))
      const reason = action.reason.charAt(0).toUpperCase() + action.reason.slice(1)
      enqueueSlack(deps.paths, { kind: "post", channel: "agents", text: `${reason}. Trying again at ${at} (${zone}).` }, now)
    }
    deps.log.warn("front door waiting", { reason: action.reason, until: action.until })
    return {
      ...state,
      waitUntil: action.until,
      lastAlertAt: alertDue ? now.toISOString() : state.lastAlertAt,
      // The starts that set off the wait are spent, so the start comes at the
      // time the alert names, not once they have aged out of the hour.
      starts: action.alert ? [] : state.starts,
    }
  }
  if (action.kind === "kick") {
    // -l sends the text literally; Enter is a key name, so it goes separately.
    // A pane target needs the trailing colon after an exact session name.
    await tmux(["send-keys", "-t", `=${session}:`, "-l", LOOP_PROMPT])
    await tmux(["send-keys", "-t", `=${session}:`, "Enter"])
    deps.log.warn("front door kicked", { reason: action.reason })
    return { ...state, kickedAt: now.toISOString() }
  }
  if (action.kind === "restart") await tmux(["kill-session", "-t", `=${session}`])
  const resumeId = action.kind === "restart" || action.mode === "resume" ? state.sessionId : null
  const command = claudeCommand({ claudePath: deps.config.frontDoor.claudePath, resumeId, model: deps.config.frontDoor.model })
  const r = await tmux(["new-session", "-d", "-s", session, "-x", "220", "-y", "60", "-c", deps.config.repo.path, command])
  if (r.code !== 0) throw new Error(`tmux new-session failed (${r.code}): ${r.stderr.trim()}`)
  const mode = resumeId ? "resume" : "new"
  appendLedger(deps.paths, { type: "frontdoor.start", mode, reason: action.reason }, now)
  deps.log.info("front door started", { mode, reason: action.reason, sessionId: resumeId })
  const hourAgo = now.getTime() - 3_600_000
  return {
    ...state,
    sessionId: resumeId,
    lastStartAt: now.toISOString(),
    starts: [...state.starts.filter((t) => Date.parse(t) > hourAgo), now.toISOString()],
    fastExits: action.kind === "start" ? action.fastExits : 0,
    waitUntil: null,
    kickedAt: null,
  }
}

export async function superviseFrontDoor(deps: FrontDoorDeps & { usage: () => UsageSnapshot | null }): Promise<FrontDoorAction> {
  const usage = deps.usage()
  const stored = readFrontDoorState(deps.paths)
  const state = adoptSessionId(stored, usage)
  const action = decideFrontDoor({
    now: deps.now(),
    alive: await frontDoorAlive(deps),
    lastTickAt: lastTickAt(deps.paths),
    state,
    usage,
    staleTickMinutes: deps.config.frontDoor.staleTickMinutes,
  })
  const next = await applyFrontDoor(deps, state, action)
  if (next !== stored) writeJsonAtomic(statePath(deps.paths), next)
  return action
}
