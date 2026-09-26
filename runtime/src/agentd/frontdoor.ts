/**
 * The watchdog's front-door duties (spec 6.2): start it at boot, restart it
 * when it exits, and restart it with --resume when it stops waking up (a
 * third rate-limit stop, a /loop past its 7-day expiry, a hang), after the
 * usage limit resets when that is the cause. Three starts in an hour means a
 * restart will not fix it: wait 30 minutes and say so, at most once an hour.
 * A restart someone asked for (`agentctl frontdoor restart`: a deploy, a
 * config change) is no exit: it starts again at once and counts toward none
 * of that (STEP-3370).
 *
 * Two things it does not take on trust. The session's id comes from the
 * status line (its payload carries `session_id`), so nothing has to pin one
 * at start. And if no wakeup follows a start within five minutes, it types
 * the /loop prompt into tmux once, in case the prompt on the command line was
 * not submitted.
 *
 * tmux targets name the session exactly (`=frontdoor`): a bare name also
 * matches any session it begins, such as a person's `frontdoor-old`. And the
 * front door has a tmux server of its own (`tmux -L agentd`): a session takes
 * its server's global environment, and a server a person started from their
 * own shell would hand the front door whatever that shell exported (an
 * ANTHROPIC_API_KEY would bill the API). agentd starts this one with its own
 * scrubbed environment. The session is marked AGENTD_FRONT_DOOR=1, so the
 * status line records its session id and no other session's.
 */

import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { channelApproval, MANAGED_SETTINGS } from "../channel/managed.ts"
import { readSandboxProbe } from "../cli/sandbox-probe.ts"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { readJson, writeJsonAtomic } from "../fsq.ts"
import { appendLedger, type Logger } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import { tickPath } from "../tick.ts"
import { limitedUntil, readUsage, type UsageSnapshot } from "../usage.ts"
import type { Exec } from "../worker/git.ts"

export const LOOP_PROMPT = "/loop /dev-tasks:front-door"
/** The front door's own tmux server: `tmux -L agentd attach -t =frontdoor`. */
export const TMUX_SOCKET = "agentd"

/**
 * The front door's own settings (sandbox, deny rules, status line, Remote
 * Control), rendered by install.sh from runtime/templates/claude-settings.json
 * and passed with --settings, so a person's own claude sessions on the mini
 * keep the user's settings as they are.
 */
export const frontDoorSettingsPath = (paths: AgentPaths) => join(paths.root, "front-door-settings.json")

/**
 * What is wrong with the front door's settings file, or null. claude refuses
 * a missing file, but starts on an unparseable one with no sandbox and no
 * deny rules at all, so the file is read here first.
 */
export function frontDoorSettingsProblem(paths: AgentPaths): string | null {
  const file = frontDoorSettingsPath(paths)
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return `${file} is missing: run install.sh`
  }
  let settings: { sandbox?: { enabled?: unknown; allowUnsandboxedCommands?: unknown } }
  try {
    settings = JSON.parse(text)
  } catch {
    return `${file} is not valid JSON, and claude would start without its sandbox: run install.sh`
  }
  if (settings?.sandbox?.enabled !== true || settings.sandbox.allowUnsandboxedCommands !== false) {
    return `${file} does not turn the sandbox on (sandbox.enabled true, allowUnsandboxedCommands false): run install.sh`
  }
  return null
}

/** agentd would not start the front door: agentd.json and agentctl status say why. */
export class FrontDoorRefused extends Error {}

/**
 * Why the front door must not start now, or null: its settings, and a
 * sandbox probe that has not passed on the claude it would run. The sandbox
 * leans on how that Claude Code treats the settings (cli/sandbox-probe.ts), so
 * a claude someone updated starts only once agentctl probe-sandbox passes on it.
 */
export async function frontDoorRefusal(deps: { paths: AgentPaths; config: AgentConfig; exec: Exec }): Promise<string | null> {
  const problem = frontDoorSettingsProblem(deps.paths)
  if (problem) return problem
  const claude = deps.config.frontDoor.claudePath
  const r = await deps.exec(claude, ["--version"], { timeoutMs: TMUX_TIMEOUT_MS })
  const version = r.code === 0 ? r.stdout.trim().split("\n")[0] : ""
  if (!version) return `${claude} --version failed (${r.code}): ${r.stderr.trim()}`
  const probe = readSandboxProbe(deps.paths)
  if (!probe?.ok || probe.claudeVersion !== version || probe.claudePath !== claude) {
    const last = probe ? ` (the last probe ${probe.ok ? "passed" : "failed"} on ${probe.claudeVersion}, ${probe.claudePath ?? "the SDK's own binary"})` : ""
    return `the sandbox probe has not passed on ${claude}, ${version}${last}: a person runs agentctl probe-sandbox`
  }
  return null
}
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

/**
 * A restart a person or a deploy asked for (STEP-3370), written by `agentctl
 * frontdoor restart` just before it ends the session: that exit is not a
 * crash, and must not bring the three-in-an-hour wait closer.
 */
export interface RestartRequest {
  at: string
  reason: string
}

/** A request answers only the exit that follows it, and only for so long: an older one excuses nothing. */
const RESTART_REQUEST_MINUTES = 10

export type FrontDoorAction =
  | { kind: "none" }
  /** intentional: a restart asked for, whose start counts toward no backoff. */
  | { kind: "start"; mode: "new" | "resume"; reason: string; fastExits: number; intentional?: true }
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
  restartRequest?: RestartRequest | null
}

export function decideFrontDoor(i: FrontDoorInput): FrontDoorAction {
  const now = i.now.getTime()
  const lastStart = i.state.lastStartAt ? Date.parse(i.state.lastStartAt) : null
  // Gone because someone asked, since the last start: start it again now, even inside a wait, and count no exit.
  const asked = i.restartRequest ? Date.parse(i.restartRequest.at) : NaN
  if (!i.alive && asked >= (lastStart ?? 0) && now - asked <= RESTART_REQUEST_MINUTES * 60_000) {
    return { kind: "start", mode: i.state.sessionId ? "resume" : "new", reason: `restarted on purpose: ${i.restartRequest!.reason}`, fastExits: 0, intentional: true }
  }
  if (i.state.waitUntil && now < Date.parse(i.state.waitUntil)) return { kind: "none" }
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

/**
 * The status line reports the running session's id. Adopt it once the front
 * door reported it after the last start: a person's own session writes the
 * snapshot too, keeping the id it found, which may be the previous one.
 */
export function adoptSessionId(state: FrontDoorState, usage: UsageSnapshot | null): FrontDoorState {
  if (!usage?.sessionId || usage.sessionId === state.sessionId || !state.lastStartAt) return state
  if (Date.parse(usage.sessionAt ?? usage.at) < Date.parse(state.lastStartAt)) return state
  return { ...state, sessionId: usage.sessionId }
}

export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** The front door's command line (spec 6.1), as one shell string for tmux. */
/**
 * The Slack channel (STEP-3293), as the dev-tasks plugin declares it. An
 * approved channel, never a development one: `--dangerously-load-development-channels`
 * asks for a confirmation at every start, which nobody is there to give.
 */
export const CHANNEL_PLUGIN = "plugin:dev-tasks@dev-tasks-marketplace"

export function claudeCommand(o: { claudePath: string; resumeId: string | null; model: string; settingsPath: string; channel?: boolean }): string {
  return [
    o.claudePath,
    ...(o.resumeId ? ["--resume", o.resumeId] : []),
    ...(o.channel ? ["--channels", CHANNEL_PLUGIN] : []),
    "--settings",
    o.settingsPath,
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

/**
 * Whether the front door will read a message soon (STEP-3293 review): it
 * woke up within staleTickMinutes, it is not at its usage limit, and agentd
 * is not holding it back. Its wakeups decide, never the Slack channel's
 * heartbeat alone: the channel process outlives a front door stuck at its
 * usage limit, and can die on its own while the front door still wakes up
 * and reads the digest.
 */
export function frontDoorUp(paths: AgentPaths, config: Pick<AgentConfig, "frontDoor">, now: Date): boolean {
  const tick = lastTickAt(paths)
  if (!tick || now.getTime() - tick.getTime() >= config.frontDoor.staleTickMinutes * 60_000) return false
  const held = readFrontDoorState(paths).waitUntil
  if (held && Date.parse(held) > now.getTime()) return false
  return limitedUntil(readUsage(paths), now) === null
}

/** tmux on the front door's own server, by the absolute path install.sh recorded. */
function tmuxOn(deps: { exec: Exec; config: AgentConfig }, args: string[]) {
  return deps.exec(deps.config.frontDoor.tmuxPath, ["-L", TMUX_SOCKET, ...args], { timeoutMs: TMUX_TIMEOUT_MS })
}

export async function frontDoorAlive(deps: { exec: Exec; config: AgentConfig }): Promise<boolean> {
  return (await tmuxOn(deps, ["has-session", "-t", `=${deps.config.frontDoor.tmuxSession}`])).code === 0
}

export interface FrontDoorDeps {
  paths: AgentPaths
  config: AgentConfig
  exec: Exec
  now: () => Date
  log: Logger
  /** Claude Code's managed settings on this machine. Default: MANAGED_SETTINGS. */
  managedSettings?: string
}

/**
 * Whether this start opens the Slack channel (STEP-3293): config.json wants
 * it, and the machine's managed settings approve exactly the dev-tasks
 * plugin's channel. Otherwise the front door starts without it, and says why.
 */
function slackChannel(deps: FrontDoorDeps): boolean {
  if (!deps.config.frontDoor.channel) return false
  const approval = channelApproval(deps.managedSettings ?? MANAGED_SETTINGS)
  if (!approval.ok) deps.log.warn("front door started without the Slack channel", { why: approval.why })
  return approval.ok
}

export async function applyFrontDoor(deps: FrontDoorDeps, state: FrontDoorState, action: FrontDoorAction): Promise<FrontDoorState> {
  const now = deps.now()
  const session = deps.config.frontDoor.tmuxSession
  const tmux = (args: string[]) => tmuxOn(deps, args)
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
  // Checked before a restart kills anything: a refused start leaves the session as it is.
  const refusal = await frontDoorRefusal(deps)
  if (refusal) throw new FrontDoorRefused(refusal)
  if (action.kind === "restart") await tmux(["kill-session", "-t", `=${session}`])
  const resumeId = action.kind === "restart" || action.mode === "resume" ? state.sessionId : null
  const channel = slackChannel(deps)
  const command = claudeCommand({
    claudePath: deps.config.frontDoor.claudePath,
    resumeId,
    model: deps.config.frontDoor.model,
    settingsPath: frontDoorSettingsPath(deps.paths),
    channel,
  })
  // AGENTD_CHANNEL=1 only beside --channels: the plugin runs the channel server
  // where Claude Code was asked to register it, and nowhere else (STEP-3293 review).
  const env = ["-e", "AGENTD_FRONT_DOOR=1", ...(channel ? ["-e", "AGENTD_CHANNEL=1"] : [])]
  const r = await tmux(["new-session", "-d", "-s", session, ...env, "-x", "220", "-y", "60", "-c", deps.config.repo.path, command])
  if (r.code !== 0) throw new Error(`tmux new-session failed (${r.code}): ${r.stderr.trim()}`)
  const mode = resumeId ? "resume" : "new"
  appendLedger(deps.paths, { type: "frontdoor.start", mode, reason: action.reason }, now)
  deps.log.info("front door started", { mode, reason: action.reason, sessionId: resumeId })
  const hourAgo = now.getTime() - 3_600_000
  const intentional = action.kind === "start" && action.intentional === true
  // The request is spent on the start it asked for.
  if (intentional) rmSync(restartRequestPath(deps.paths), { force: true })
  return {
    ...state,
    sessionId: resumeId,
    lastStartAt: now.toISOString(),
    // Only an exit nobody asked for brings the three-in-an-hour wait closer.
    starts: [...state.starts.filter((t) => Date.parse(t) > hourAgo), ...(intentional ? [] : [now.toISOString()])],
    fastExits: action.kind === "start" ? action.fastExits : 0,
    waitUntil: null,
    kickedAt: null,
  }
}

export const restartRequestPath = (paths: AgentPaths) => join(paths.state, "frontdoor-restart.json")

export function readRestartRequest(paths: AgentPaths): RestartRequest | null {
  const request = readJson<Partial<RestartRequest>>(restartRequestPath(paths))
  return request && typeof request.at === "string" && typeof request.reason === "string" ? { at: request.at, reason: request.reason } : null
}

/**
 * Restarts the front door on purpose (`agentctl frontdoor restart`): records
 * the request first, then ends the session, so agentd never sees the session
 * gone without it, and starts it again, resumed, counting no exit. With no
 * session to end the request is taken back: it must never excuse a later crash.
 */
export async function requestFrontDoorRestart(
  deps: { paths: AgentPaths; config: AgentConfig; exec: Exec; now: () => Date },
  reason: string,
): Promise<{ restarted: true } | { restarted: false; why: string }> {
  const now = deps.now()
  writeJsonAtomic(restartRequestPath(deps.paths), { at: now.toISOString(), reason } satisfies RestartRequest)
  const r = await tmuxOn(deps, ["kill-session", "-t", `=${deps.config.frontDoor.tmuxSession}`])
  if (r.code !== 0) {
    rmSync(restartRequestPath(deps.paths), { force: true })
    return { restarted: false, why: "the front door is not running: agentd starts it within 15 seconds" }
  }
  appendLedger(deps.paths, { type: "frontdoor.restartAsked", reason }, now)
  return { restarted: true }
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
    restartRequest: readRestartRequest(deps.paths),
  })
  const next = await applyFrontDoor(deps, state, action)
  if (next !== stored) writeJsonAtomic(statePath(deps.paths), next)
  return action
}
