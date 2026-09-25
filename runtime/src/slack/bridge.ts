/**
 * The Slack bridge, launchd job eu.polads.slack-bridge: one Socket Mode
 * connection per mini, to that mini's own Slack app (decision 3). It
 * acknowledges each delivery at once, then files #polads-intake mentions into
 * Linear itself (spec 8: intake works while the front door is busy), files
 * every allowlisted person's reply in a thread the mini owns and every mention
 * for the front door, and drains the outbox. It is the only process that reads
 * the Slack tokens.
 *
 * It never decides what a person's words mean (STEP-3293): the front door
 * reads each reply in its own session, pushed by the Slack channel
 * (channel/server.ts), and answers, records a decision or acts. The bridge
 * acts on words itself only where waiting would hurt: "pause" always, and
 * "leave it" while the front door is down. It never closes a message: the
 * front door reads every one, with what the bridge did beside it.
 */

import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { LogLevel, SocketModeClient } from "@slack/socket-mode"
import { WebClient } from "@slack/web-api"
import { agentPaths, assertProfileMini, loadConfig, readProfileMini, type AgentConfig, type AgentPaths } from "../config.ts"
import { ack, countIn, entryPath, fail, listNew, putOnce, readJson, safeKey, writeJsonAtomic } from "../fsq.ts"
import { appendLedger, createLogger, redact, type Logger } from "../log.ts"
import { enqueueSlack, type ChannelKey } from "../outbox.ts"
import { releasePidLock, takePidLock } from "../pidlock.ts"
import { assertLinearKeyFile, loadSlackSecrets } from "../secrets.ts"
import { onQueue } from "../select.ts"
import { issueForThread, saveThread, threadFor } from "../threads.ts"
import { createLinearTracker, type Tracker } from "../tracker.ts"
import { classify, type Classified, type ClassifyContext, type SlackEnvelope } from "./classify.ts"
import { parseInstruction, type Action, type InstructionEntry } from "./instruction.ts"
import { isSlackTrouble, slackErrorCode, startOutbox, type SendContext, type SlackWeb } from "./send.ts"
import { fromSlack, intakeIssue, mentionedUsers } from "./text.ts"
import { frontDoorUp, lastTickAt } from "../agentd/frontdoor.ts"
import { NOTHING_NEEDED } from "../plain.ts"
import { noteCorrection } from "../answer.ts"

export interface BridgeWeb extends SlackWeb {
  userName(userId: string): Promise<string>
}

export interface BridgeDeps {
  paths: AgentPaths
  config: AgentConfig
  tracker: Tracker
  web: BridgeWeb
  classifyContext: ClassifyContext
  log: Logger
  now: () => Date
  /** Inbox keys being worked on right now, so the one-minute retry never races a live delivery. */
  busy: Set<string>
}

type IntakeEntry = Extract<Classified, { type: "intake" }> & {
  userName: string
  receivedAt: string
  /** Chosen before the first attempt, sent as the Linear issue id. */
  linearId: string
  issue: string | null
  toldUnfiled?: boolean
  /** When Linear first refused it: the give-up day counts from here, not from the delivery. */
  failingSince?: string
}
type PersonEntry = Extract<Classified, { type: "reply" | "mention" }> & {
  userName: string
  receivedAt: string
  /** What the bridge did about the words itself (pause, leave), which the front door must not do again. */
  acted?: Action[]
  /** On a reply: the questions open in the thread when it came. */
  openQuestions?: number
}

export async function handleEnvelope(deps: BridgeDeps, envelope: SlackEnvelope): Promise<Classified["type"]> {
  const c = classify(envelope, deps.classifyContext)
  if (c.type === "ignore") return c.type
  const receivedAt = deps.now().toISOString()
  if (c.type === "reaction") {
    // Kept for the record. Phase 3's release train is the first reader.
    if (putOnce(deps.paths.inbox, c.key, { ...c, receivedAt })) ack(deps.paths.inbox, c.key)
    return c.type
  }
  // Slack has its acknowledgement and will not send this again, so it goes to
  // disk before any call that can wait on the network. The put is the dedupe:
  // a redelivery never files a second issue or applies an answer twice.
  const intake = c.type === "intake" ? { linearId: randomUUID(), issue: null } : {}
  // A reply keeps the thread as it stood when it came: the question it
  // answered, when the front door last wrote there, and how many questions
  // were open. Nothing said later changes what their "yes" agreed to (STEP-3293 review).
  const thread = c.type === "reply" && c.issue ? threadFor(deps.paths, c.issue) : null
  const asked =
    c.type === "reply"
      ? { lastQuestion: thread?.lastQuestion ?? null, lastQuestionAt: thread?.lastQuestionAt ?? null, lastReplyAt: thread?.lastReplyAt ?? null, openQuestions: thread?.openQuestions ?? 0 }
      : {}
  if (!putOnce(deps.paths.inbox, c.key, { ...c, userName: c.user, receivedAt, ...intake, ...asked })) return c.type
  // They replied: the questions before it are theirs to have answered, and a later one counts afresh.
  if (thread?.openQuestions) saveThread(deps.paths, { ...thread, openQuestions: 0 })
  // The sender's name, for the front door, the issue and the answer. Their user id when Slack cannot say.
  const userName = await deps.web.userName(c.user).catch(() => c.user)
  // For the front door and for the record a decision leaves on the issue: names for Slack's mention markup, and the message's link.
  const person = c.type === "reply" || c.type === "mention"
  const readableText = person ? fromSlack(c.text, await namesFor(deps, c.text)) : undefined
  const permalink = person ? await deps.web.permalink(c.channel, c.ts).catch(() => null) : undefined
  if (userName !== c.user || person) {
    const path = entryPath(deps.paths.inbox, c.key)
    const entry = readJson<Record<string, unknown>>(path)
    if (entry) writeJsonAtomic(path, { ...entry, userName, ...(person ? { readableText, permalink } : {}) })
  }
  if (c.type === "intake") await fileIntake(deps, c.key)
  // "No, do X": a lesson for the weekly retro (STEP-3290), whoever handles the words.
  if (person) learnCorrection(deps, { issue: c.type === "reply" ? c.issue : null, channel: c.channel, ts: c.ts, who: userName, text: c.text })
  if (person) actForFrontDoor(deps, c.key)
  return c.type
}

/**
 * A message that is only a command (STEP-3293 final pass): "pause", "pause
 * everything", "stop everything", "hold everything", or "leave it", "I'll
 * take it", with an optional "@eve" and "please". The bridge acts on these
 * alone, the front door up or down. A sentence that says pause or leave about
 * something else ("pause the countdown", "hold off on the banner", "should we
 * pause the rollout?"), or a bare "stop" or "hold", is the front door's to
 * read: the away note tells them it will be.
 */
const POLITELY = "(please[\\s,]+)?"
const TRAIL = "([\\s,]+(now|for now|please))*[\\s.!]*$"
const SHORT_PAUSE = new RegExp(`^${POLITELY}(pause|pause everything|stop everything|hold everything)${TRAIL}`, "i")
const LEAVE = "(leave (it|this|that)( to me)?|i'?ll (take|handle) (it|this|that))"
const SHORT_LEAVE = new RegExp(`^${POLITELY}${LEAVE}([\\s,.!]+${LEAVE})*${TRAIL}`, "i")
const bare = (text: string) => text.replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, " ").trim()

export const shortPause = (text: string) => SHORT_PAUSE.test(bare(text))
export const shortLeave = (text: string) => SHORT_LEAVE.test(bare(text))

/** What the bridge says in a thread while the front door cannot read it: a restart, a usage limit. */
export const AWAY_NOTE = `I am not reading messages right now, and I will read this one as soon as I am back. ${NOTHING_NEEDED}`

/**
 * A person's reply or mention is the front door's to read, and it stays in
 * the inbox until the front door closes it. The bridge acts on the words
 * itself only where waiting would hurt, through agentd, and only on a message
 * that is only a command: a pause at once, unless it replies in a thread with
 * a question open, where "pause" may be the answer, and a leave while the
 * front door is down. A pause is the whole mini's and needs no issue or PR.
 * The entry records what it did (`acted`), so the front door handles the rest
 * and does nothing twice. While the front door is down, it says so in the
 * thread, once each time.
 */
export function actForFrontDoor(deps: BridgeDeps, key: string): void {
  const path = entryPath(deps.paths.inbox, key)
  const entry = readJson<PersonEntry>(path)
  if (!entry) return
  const now = deps.now()
  const up = frontDoorUp(deps.paths, deps.config, now)
  const said = parseInstruction(entry.text)
  const issue = entry.type === "reply" ? entry.issue : null
  const acted = entry.acted ?? []
  const aimed = Boolean(issue || said.target.issue || said.target.pr)
  // "Ship it now, or pause?": with a question open in the thread, a pause may be the answer.
  const answering = entry.type === "reply" && (entry.openQuestions ?? 0) > 0
  const wanted: Action[] = [
    ...(shortPause(entry.text) && !answering ? (["pause"] as const) : []),
    ...(!up && aimed && shortLeave(entry.text) ? (["leave"] as const) : []),
  ]
  const due = wanted.filter((a) => !acted.includes(a))
  if (due.length) {
    // A key of its own: the front door's instruct files instr:<channel>:<ts> for the rest of the words.
    fileInstruction(deps, `instr:bridge-${due.join("-")}:${entry.channel}:${entry.ts}`, {
      issue, channel: entry.channel, ts: entry.ts, threadTs: entry.threadTs, user: entry.user, userName: entry.userName, text: entry.text, actions: due, target: said.target,
    })
    writeJsonAtomic(path, { ...entry, acted: [...acted, ...due] })
  }
  if (!up) tellAway(deps, entry, now)
}

const awayNotesPath = (paths: AgentPaths) => join(paths.state, "front-door-away-notes.json")

/**
 * The away note, once per thread for each time the front door is down: the
 * time it last woke up names the outage, and a later wakeup starts a new one.
 */
function tellAway(deps: BridgeDeps, entry: PersonEntry, now: Date): void {
  const outage = lastTickAt(deps.paths)?.toISOString() ?? "never"
  const thread = `${entry.channel}:${entry.threadTs}`
  const notes = readJson<Record<string, string>>(awayNotesPath(deps.paths)) ?? {}
  if (notes[thread] === outage) return
  const current = Object.fromEntries(Object.entries(notes).filter(([, at]) => at === outage))
  writeJsonAtomic(awayNotesPath(deps.paths), { ...current, [thread]: outage })
  enqueueSlack(deps.paths, { kind: "reply", channelId: entry.channel, threadTs: entry.threadTs, text: AWAY_NOTE }, now)
  deps.log.info("front door down: told the thread", { key: entry.key })
}

/**
 * An instruction for agentd (agentd/instructions.ts), which acts on it within
 * seconds and replies in words. Filed once per key.
 */
function fileInstruction(deps: BridgeDeps, key: string, entry: Omit<InstructionEntry, "type" | "key" | "receivedAt">): void {
  const filed: InstructionEntry = { type: "instruction", key, ...entry, receivedAt: deps.now().toISOString() }
  if (putOnce(deps.paths.inbox, key, filed)) {
    appendLedger(deps.paths, { type: "instruction.received", issue: entry.issue ?? entry.target.issue ?? undefined, actions: entry.actions }, deps.now())
    learnCorrection(deps, { issue: entry.issue ?? entry.target.issue ?? null, channel: entry.channel, ts: entry.ts, who: entry.userName || entry.user, text: entry.text })
  }
}

/**
 * A person's reply that says the mini got something wrong ("no, do X"): a
 * lesson for the weekly retro (STEP-3290). Its words are data. A lesson that
 * cannot be written never stops the reply's own handling.
 */
function learnCorrection(deps: BridgeDeps, said: { issue: string | null; channel: string; ts: string; who: string; text: string }): void {
  noteCorrection({ paths: deps.paths, mini: deps.config.mini, now: deps.now, log: deps.log }, { issue: said.issue, source: "slack", key: `correction:${said.channel}:${said.ts}`, who: said.who, text: said.text })
}

/** How long an intake or an answer Linear keeps refusing waits in the inbox before the bridge gives up and says so. */
const GIVE_UP_MS = 24 * 60 * 60_000

/**
 * Whether Linear has refused an entry for a whole day, counted from its first
 * refusal, which it records on the entry: time the bridge was down is not
 * Linear refusing.
 */
function refusedForADay(deps: BridgeDeps, path: string, entry: { failingSince?: string }): boolean {
  if (!entry.failingSince) {
    writeJsonAtomic(path, { ...entry, failingSince: deps.now().toISOString() })
    return false
  }
  return deps.now().getTime() - Date.parse(entry.failingSince) > GIVE_UP_MS
}

/** An error that says Linear has no such issue, in the adapter's own words (plugin/src/tracker/linear.ts). */
export function isIssueGone(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Linear: no issue ")
}

/** Display names for the users a message mentions, for Linear, where <@U1> means nothing. */
async function namesFor(deps: BridgeDeps, text: string): Promise<Record<string, string>> {
  const names: Record<string, string> = {}
  for (const id of new Set(mentionedUsers(text))) names[id] = await deps.web.userName(id).catch(() => id)
  return names
}

async function once(deps: BridgeDeps, key: string, work: () => Promise<void>): Promise<void> {
  // A live delivery knows the key as Slack wrote it (msg:C1:1800.1), the retry
  // as its file name (msg_C1_1800.1): both must claim the same entry.
  const entry = safeKey(key)
  if (deps.busy.has(entry)) return
  deps.busy.add(entry)
  try {
    await work()
  } finally {
    deps.busy.delete(entry)
  }
}

export async function fileIntake(deps: BridgeDeps, key: string): Promise<void> {
  await once(deps, key, async () => {
    const path = entryPath(deps.paths.inbox, key)
    const entry = readJson<IntakeEntry>(path)
    if (!entry || entry.issue) return
    const reply = (text: string) => enqueueSlack(deps.paths, { kind: "reply", channelId: entry.channel, threadTs: entry.ts, text }, deps.now())
    const permalink = await deps.web.permalink(entry.channel, entry.ts).catch(() => null)
    const input = intakeIssue(entry.text, {
      userName: entry.userName,
      permalink: permalink ?? "(no link)",
      botUserId: deps.classifyContext.botUserId,
      otherAgentBots: deps.classifyContext.otherAgentBots,
      product: deps.config.repo.product,
      names: await namesFor(deps, entry.text),
    })
    if (!input) {
      ack(deps.paths.inbox, key)
      reply(`Tell me what you need in the same message, for example: @${deps.config.mini} the notice page shows the wrong date.`)
      return
    }
    try {
      // An earlier attempt may have created the issue and crashed before
      // writing that down. Its id is ours, so it reads back here. createIssue
      // settles the same case on its own since dev-tasks #96 (a create whose
      // id is taken reads that issue back): reading first only spares Linear
      // a create it would refuse.
      const filed =
        (await deps.tracker.readIssue(entry.linearId).catch(() => null)) ??
        (await deps.tracker.createIssue({ ...input, clientId: entry.linearId }))
      writeJsonAtomic(path, { ...entry, issue: filed.id })
      saveThread(deps.paths, { issue: filed.id, channelId: entry.channel, ts: entry.ts, permalink, createdAt: deps.now().toISOString(), lastQuestionAt: null })
      // The reply first: it is a local write, and the link below a Linear call a crash can cut short.
      // In allowlist mode a new issue is not on the list, so this mini will not refine it.
      const next = onQueue(filed.id, deps.config.queue) ? "I will refine it and answer here." : "A person decides when I work on it."
      reply(`filed ${filed.id} ${filed.url}. ${next}`)
      appendLedger(deps.paths, { type: "intake.filed", issue: filed.id }, deps.now())
      if (permalink) {
        await deps.tracker.attachLink(filed.id, permalink, "Slack intake thread").catch((error) => {
          deps.log.warn("intake thread not attached", { issue: filed.id, error: String(error) })
        })
      }
    } catch (error) {
      deps.log.warn("intake not filed yet", { key, error: String(error) })
      if (refusedForADay(deps, path, entry)) {
        fail(deps.paths.inbox, key)
        reply("Linear refused this for a whole day, so I have stopped trying to file it. Please ask again.")
        deps.log.error("intake given up", { key, error: String(error) })
        return
      }
      if (!entry.toldUnfiled) {
        const current = readJson<IntakeEntry>(path) ?? entry
        writeJsonAtomic(path, { ...current, toldUnfiled: true })
        reply("Linear is unreachable right now. I will file this as soon as it is back.")
      }
    }
  })
}

/** Every minute: intakes not yet filed, and for a person's message still open, what actForFrontDoor does now the front door is up or down. */
export async function retryPending(deps: BridgeDeps): Promise<void> {
  for (const { key, payload } of listNew<{ type: string; issue?: string | null }>(deps.paths.inbox)) {
    if (payload.type === "intake" && !payload.issue) await fileIntake(deps, key)
    if (payload.type === "reply" || payload.type === "mention") actForFrontDoor(deps, key)
  }
}

type ChannelPage = { channels: Array<{ id?: string; name?: string; is_member?: boolean }>; next?: string }
type ListArgs = { types: string; exclude_archived: boolean; limit: number; cursor?: string }
type ListResult = { channels?: ChannelPage["channels"]; response_metadata?: { next_cursor?: string } }

/**
 * conversations.list a page at a time: the public channels, and the private
 * ones the bot is in, since the four may be private Slack Connect channels.
 * An app whose scopes predate private channels is refused with missing_scope,
 * and the bridge stops naming the scope, where "does not exist" would send a
 * person looking for the channel.
 */
export function channelPages(list: (args: ListArgs) => Promise<ListResult>): (cursor?: string) => Promise<ChannelPage> {
  return async (cursor) => {
    try {
      const page = await list({ types: "public_channel,private_channel", exclude_archived: true, limit: 1000, cursor })
      return { channels: page.channels ?? [], next: page.response_metadata?.next_cursor || undefined }
    } catch (error) {
      if (slackErrorCode(error) !== "missing_scope") throw error
      const needed = (error as { data?: { needed?: unknown } }).data?.needed
      throw new Error(
        `slack-bridge: the Slack app lacks the scope ${typeof needed === "string" ? needed : "groups:read"}, which listing private channels needs. ` +
          "Update the app from runtime/slack/app-manifest.json (App Manifest), then reinstall it to the workspace",
      )
    }
  }
}

/** Channel ids by name, refusing to start when one is missing or the bot is not in it. */
export async function resolveChannels(
  list: (cursor?: string) => Promise<ChannelPage>,
  names: Record<ChannelKey, string>,
): Promise<Record<ChannelKey, string>> {
  const byName = new Map<string, { id: string; isMember: boolean }>()
  let cursor: string | undefined
  do {
    const page = await list(cursor)
    for (const c of page.channels) if (c.id && c.name) byName.set(c.name, { id: c.id, isMember: Boolean(c.is_member) })
    cursor = page.next
  } while (cursor)
  const ids = {} as Record<ChannelKey, string>
  const problems: string[] = []
  for (const [key, name] of Object.entries(names) as Array<[ChannelKey, string]>) {
    const hit = byName.get(name)
    if (!hit) problems.push(`the bot cannot see #${name}: it does not exist, or it is private and the bot is not in it`)
    else if (!hit.isMember) problems.push(`the bot is not in #${name}`)
    else ids[key] = hit.id
  }
  if (problems.length) {
    throw new Error(
      `slack-bridge: ${problems.join(". ")}. Add the bot in the channel's settings, Integrations, Add an App (/invite by name can pick a person called the same)`,
    )
  }
  return ids
}

/**
 * What the bridge checks on this machine before it opens Slack, in this
 * order: config.json, the mini's one name (decision 2: config.json and the
 * machine profile must agree), the Linear key file, and its own tokens.
 */
export function checkLocal(paths: AgentPaths, profileMini: string | null): { config: AgentConfig; botToken: string; appToken: string } {
  const config = loadConfig(paths)
  assertProfileMini(config, profileMini, paths.config)
  assertLinearKeyFile(paths.home)
  return { config, ...loadSlackSecrets(paths.home) }
}

const TRANSIENT_SLACK_CODES = new Set(["slack_webapi_request_error", "slack_webapi_http_error", "slack_webapi_rate_limited_error"])

/**
 * How the bridge exits when it cannot run. Slack out of reach (the network
 * not up yet after a power cut, say) or in trouble of its own passes: 1, and
 * launchd starts it again. Anything else, a bad config, another mini's name,
 * a revoked token, a missing channel, waits for a person: 0, and launchd
 * leaves it stopped (KeepAlive restarts only a failed exit, Task 17).
 * agentctl status and the Sentry check-in show why.
 */
export function exitCodeFor(error: unknown): 0 | 1 {
  const code = (error as { code?: unknown } | null)?.code
  return (typeof code === "string" && TRANSIENT_SLACK_CODES.has(code)) || isSlackTrouble(error) ? 1 : 0
}

export interface SocketHooks {
  /** One delivery, after its acknowledgement. */
  handle(body: SlackEnvelope): Promise<unknown>
  /** Any delivery arrived: bridge.json's lastEventAt. */
  received(): void
  /** The connection came up (true) or dropped (false). */
  connected(value: boolean): void
}

/**
 * The Socket Mode wiring. Each delivery is acknowledged first, inside Slack's
 * 3 seconds and before any Linear call, then handled, even when the
 * acknowledgement failed: Slack then sends it again and the inbox keeps one.
 * A dropped connection reconnects on its own and never reports
 * "disconnected" (@slack/socket-mode 3), so "reconnecting" is the drop.
 */
export function wireSocket(socket: { on(event: string, listener: (...args: any[]) => void): unknown }, hooks: SocketHooks, log: Logger): void {
  const onEvent = async ({ body, ack }: { body: SlackEnvelope; ack: () => Promise<void> }) => {
    hooks.received()
    try {
      await ack()
    } catch (error) {
      log.warn("delivery not acknowledged, handled anyway", { error: String(error) })
    }
    try {
      await hooks.handle(body)
    } catch (error) {
      log.error("event failed", { error: String(error) })
    }
  }
  for (const type of ["app_mention", "message", "reaction_added"]) socket.on(type, onEvent)
  for (const state of ["connected", "reconnecting", "disconnected"]) socket.on(state, () => hooks.connected(state === "connected"))
}

async function setup(paths: AgentPaths) {
  const { config, botToken, appToken } = checkLocal(paths, readProfileMini())
  const client = new WebClient(botToken)
  // users.info and getPermalink have answers to fall back on (the user id, no
  // link), so they fail fast rather than hold an intake or the drain through
  // the Web API's half hour of retries.
  const lookups = new WebClient(botToken, { retryConfig: { retries: 1 }, timeout: 10_000 })
  const auth = await client.auth.test()
  if (!auth.team_id || !auth.user_id) throw new Error("slack-bridge: auth.test returned no team or bot user")
  const channelIds = await resolveChannels(
    channelPages((args) => client.conversations.list(args)),
    config.slack.channels,
  )
  return { config, appToken, client, lookups, teamId: auth.team_id, botUserId: auth.user_id, channelIds }
}

export interface BridgeState {
  connected: boolean
  lastEventAt: string | null
  /** Why the outbox is paused: Slack refused the app. null once a message goes out again. */
  refused: string | null
  /** The app's own bot user, once auth.test named it: what the other minis list in slack.otherAgentBots. */
  botUserId?: string
}

/**
 * ~/.agentd/state/bridge.json, written every 30 seconds and on every change.
 * `error` is set while the outbox is paused, so agentctl status and the
 * health check see why nothing is posted even though the bridge is running.
 * `botUserId` is the id bootstrap-mini.sh hands to the other minis.
 */
export function bridgeStatus(paths: AgentPaths, state: BridgeState, now: Date = new Date()): Record<string, unknown> {
  return {
    pid: process.pid,
    at: now.toISOString(),
    connected: state.connected,
    lastEventAt: state.lastEventAt,
    outboxWaiting: countIn(paths.outbox, "new"),
    outboxFailed: countIn(paths.outbox, "failed"),
    ...(state.refused ? { error: state.refused } : {}),
    ...(state.botUserId ? { botUserId: state.botUserId } : {}),
  }
}

async function main(): Promise<void> {
  const paths = agentPaths()
  const log = createLogger(paths, "slack-bridge")

  // One bridge per mini: a second would drain the same outbox and post
  // everything twice. It leaves bridge.json alone, which is the running
  // bridge's, and exits 1, so launchd's copy takes over once the other ends.
  mkdirSync(paths.state, { recursive: true })
  const lockPath = join(paths.state, "slack-bridge.pid")
  const lock = takePidLock(lockPath, "slack/bridge.ts")
  if (!lock.ok) {
    log.error("another bridge is running", { pid: lock.holder })
    console.error(`slack-bridge: another bridge is running here, pid ${lock.holder}`)
    process.exit(1)
  }
  process.on("exit", () => releasePidLock(lockPath))
  process.on("SIGTERM", () => process.exit(143))
  process.on("SIGINT", () => process.exit(130))

  const state: BridgeState = { connected: false, lastEventAt: null, refused: null }
  const writeStatus = (extra: Record<string, unknown> = {}) =>
    writeJsonAtomic(join(paths.state, "bridge.json"), { ...bridgeStatus(paths, state), ...extra })
  const halt = (error: unknown): never => {
    const message = redact(error instanceof Error ? error.message : String(error))
    // stopped: agentd's health must not read this error as a paused outbox while the heartbeat is still fresh.
    writeStatus({ error: message, stopped: true })
    log.error("bridge stopped", { error: message })
    process.exit(exitCodeFor(error))
  }
  // Setup can wait out a Slack outage: the last run's status must not stand meanwhile.
  writeStatus()

  const s = await setup(paths).catch(halt)
  state.botUserId = s.botUserId

  const tracker = createLinearTracker()
  const names = new Map<string, string>()
  const web: BridgeWeb = {
    async postMessage(args) {
      const r = await s.client.chat.postMessage({ ...args, unfurl_links: false, unfurl_media: false })
      return { ts: String(r.ts) }
    },
    async permalink(channel, ts) {
      const r = await s.lookups.chat.getPermalink({ channel, message_ts: ts })
      return r.permalink ?? null
    },
    async react(channel, ts, name) {
      await s.client.reactions.add({ channel, timestamp: ts, name })
    },
    async userName(userId) {
      const known = names.get(userId)
      if (known) return known
      const r = await s.lookups.users.info({ user: userId })
      const name = r.user?.profile?.display_name || r.user?.real_name || r.user?.name || userId
      names.set(userId, name)
      return name
    },
  }
  const deps: BridgeDeps = {
    paths,
    config: s.config,
    tracker,
    web,
    log,
    now: () => new Date(),
    busy: new Set(),
    classifyContext: {
      teamId: s.teamId,
      botUserId: s.botUserId,
      otherAgentBots: s.config.slack.otherAgentBots,
      allowedUsers: s.config.slack.allowedUsers,
      channels: s.channelIds,
      issueForThread: (channel, ts) => issueForThread(paths, channel, ts),
    },
  }
  const sendContext: SendContext = {
    paths,
    mini: s.config.mini,
    channelIds: s.channelIds,
    web,
    now: () => new Date(),
    describeIssue: async (id) => {
      const found = await tracker.readIssue(id)
      return { title: found.title, url: found.url }
    },
    attachThread: (id, permalink) => tracker.attachLink(id, permalink, "Slack thread"),
  }

  const socket = new SocketModeClient({
    appToken: s.appToken,
    logLevel: LogLevel.WARN,
    // socket-mode's own policy for reconnecting has no ceiling on the wait,
    // which grows past an hour after a long outage: Slack drops what it cannot
    // deliver meanwhile. When these run out (about 1.5 hours), start() or the
    // reconnect throws and launchd starts the bridge again.
    clientOptions: { retryConfig: { retries: 100, factor: 1.3, maxTimeout: 60_000 } },
  })
  wireSocket(
    socket,
    {
      handle: (body) => handleEnvelope(deps, body),
      received: () => {
        state.lastEventAt = new Date().toISOString()
      },
      connected: (value) => {
        state.connected = value
        writeStatus()
      },
    },
    log,
  )

  // Before the connection, which waits out a Slack outage: the outbox, the
  // heartbeat and the intake retry must not wait with it. When Slack refuses
  // the app, the outbox pauses with every message kept and tries again every
  // few minutes, and the bridge runs on: intake still reaches Linear, and
  // bridge.json says why nothing is posted until a message goes out again.
  startOutbox(sendContext, log, (reason) => {
    state.refused = reason === null ? null : redact(reason)
    writeStatus()
  })
  setInterval(() => {
    retryPending(deps).catch((error) => log.error("retry failed", { error: String(error) }))
  }, 60_000)
  setInterval(() => writeStatus(), 30_000)

  await socket.start().catch(halt)
  log.info("bridge connected", { team: s.teamId, channels: s.channelIds })
}

if (process.argv[1]?.endsWith("bridge.ts")) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
