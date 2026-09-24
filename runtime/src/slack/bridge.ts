/**
 * The Slack bridge, launchd job eu.polads.slack-bridge: one Socket Mode
 * connection per mini, to that mini's own Slack app (decision 3). It
 * acknowledges each delivery at once, then files #polads-intake mentions into
 * Linear itself (spec 8: intake works while the front door is busy), applies
 * answers to parked issues itself, queues mentions for the front door, and
 * drains the outbox. It is the only process that reads the Slack tokens.
 */

import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { LogLevel, SocketModeClient } from "@slack/socket-mode"
import { WebClient } from "@slack/web-api"
import { agentPaths, assertProfileMini, loadConfig, readProfileMini, type AgentConfig, type AgentPaths } from "../config.ts"
import { ack, countIn, entryPath, listNew, putOnce, readJson, safeKey, writeJsonAtomic } from "../fsq.ts"
import { appendLedger, createLogger, type Logger } from "../log.ts"
import { enqueueSlack, type ChannelKey } from "../outbox.ts"
import { assertLinearKeyFile, loadSlackSecrets } from "../secrets.ts"
import { issueForThread, saveThread } from "../threads.ts"
import { createLinearTracker, type Tracker } from "../tracker.ts"
import { classify, type Classified, type ClassifyContext, type SlackEnvelope } from "./classify.ts"
import { drainOutbox, SlackTokenRefused, type SendContext, type SlackWeb } from "./send.ts"
import { answerTransition, appendAnswer, intakeIssue } from "./text.ts"

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
}
type AnswerEntry = Extract<Classified, { type: "answer" }> & { userName: string; receivedAt: string }

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
  if (!putOnce(deps.paths.inbox, c.key, { ...c, userName: c.user, receivedAt, ...intake })) return c.type
  // The sender's name, for the front door, the issue and the answer. Their user id when Slack cannot say.
  const userName = await deps.web.userName(c.user).catch(() => c.user)
  if (userName !== c.user) {
    const path = entryPath(deps.paths.inbox, c.key)
    const entry = readJson<Record<string, unknown>>(path)
    if (entry) writeJsonAtomic(path, { ...entry, userName })
  }
  if (c.type === "answer") await applyAnswer(deps, c.key)
  if (c.type === "intake") await fileIntake(deps, c.key)
  return c.type
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
      product: deps.config.repo.product,
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
      if (permalink) {
        await deps.tracker.attachLink(filed.id, permalink, "Slack intake thread").catch((error) => {
          deps.log.warn("intake thread not attached", { issue: filed.id, error: String(error) })
        })
      }
      reply(`filed ${filed.id} ${filed.url}. I will refine it and answer here.`)
      appendLedger(deps.paths, { type: "intake.filed", issue: filed.id }, deps.now())
    } catch (error) {
      deps.log.warn("intake not filed yet", { key, error: String(error) })
      if (!entry.toldUnfiled) {
        writeJsonAtomic(path, { ...entry, toldUnfiled: true })
        reply("Linear is unreachable right now. I will file this as soon as it is back.")
      }
    }
  })
}

export async function applyAnswer(deps: BridgeDeps, key: string): Promise<void> {
  await once(deps, key, async () => {
    const entry = readJson<AnswerEntry>(entryPath(deps.paths.inbox, key))
    if (!entry) return
    // One answer per issue at a time: an apply reads the description and
    // writes it back, so two at once would both read the same text and the
    // second write would drop the first answer. The one that finds the issue
    // busy stays in the inbox for the next retry.
    await once(deps, `issue:${entry.issue}`, async () => {
      try {
        const current = await deps.tracker.readIssue(entry.issue)
        const permalink = await deps.web.permalink(entry.channel, entry.ts).catch(() => null)
        const description = appendAnswer(current.description, { ts: entry.ts, userName: entry.userName, text: entry.text, permalink })
        const move = answerTransition(current)
        await deps.tracker.updateIssue(entry.issue, { ...(description !== current.description ? { description } : {}), ...move })
        ack(deps.paths.inbox, key)
        enqueueSlack(deps.paths, { kind: "react", channelId: entry.channel, ts: entry.ts, name: "white_check_mark" }, deps.now())
        appendLedger(deps.paths, { type: "answer.applied", issue: entry.issue, movedTo: move.state ?? null }, deps.now())
      } catch (error) {
        // Left in the inbox: retryPending tries again every minute.
        deps.log.warn("answer not applied yet", { issue: entry.issue, error: String(error) })
      }
    })
  })
}

/** Every minute: intakes not yet filed and answers not yet applied. */
export async function retryPending(deps: BridgeDeps): Promise<void> {
  for (const { key, payload } of listNew<{ type: string; issue?: string | null }>(deps.paths.inbox)) {
    if (payload.type === "intake" && !payload.issue) await fileIntake(deps, key)
    if (payload.type === "answer") await applyAnswer(deps, key)
  }
}

type ChannelPage = { channels: Array<{ id?: string; name?: string; is_member?: boolean }>; next?: string }

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
    if (!hit) problems.push(`#${name} does not exist or is private`)
    else if (!hit.isMember) problems.push(`the bot is not in #${name}: /invite it there`)
    else ids[key] = hit.id
  }
  if (problems.length) throw new Error(`slack-bridge: ${problems.join(". ")}`)
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
 * not up yet after a power cut, say) passes: 1, and launchd starts it again.
 * Anything else, a bad config, another mini's name, a revoked token, a
 * missing channel, waits for a person: 0, and launchd leaves it stopped
 * (KeepAlive restarts only a failed exit, Task 17). agentctl status and the
 * Sentry check-in show why.
 */
export function exitCodeFor(error: unknown): 0 | 1 {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && TRANSIENT_SLACK_CODES.has(code) ? 1 : 0
}

async function setup(paths: AgentPaths) {
  const { config, botToken, appToken } = checkLocal(paths, readProfileMini())
  const client = new WebClient(botToken)
  const auth = await client.auth.test()
  if (!auth.team_id || !auth.user_id) throw new Error("slack-bridge: auth.test returned no team or bot user")
  const channelIds = await resolveChannels(async (cursor) => {
    const page = await client.conversations.list({ types: "public_channel", exclude_archived: true, limit: 1000, cursor })
    return { channels: page.channels ?? [], next: page.response_metadata?.next_cursor || undefined }
  }, config.slack.channels)
  return { config, appToken, client, teamId: auth.team_id, botUserId: auth.user_id, channelIds }
}

async function main(): Promise<void> {
  const paths = agentPaths()
  const log = createLogger(paths, "slack-bridge")
  let connected = false
  let lastEventAt: string | null = null
  const writeStatus = (extra: Record<string, unknown> = {}) =>
    writeJsonAtomic(join(paths.state, "bridge.json"), {
      pid: process.pid,
      at: new Date().toISOString(),
      connected,
      lastEventAt,
      outboxWaiting: countIn(paths.outbox, "new"),
      outboxFailed: countIn(paths.outbox, "failed"),
      ...extra,
    })
  const halt = (error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error)
    writeStatus({ error: message })
    log.error("bridge stopped", { error: message })
    process.exit(exitCodeFor(error))
  }

  const s = await setup(paths).catch(halt)

  const tracker = createLinearTracker()
  const names = new Map<string, string>()
  const web: BridgeWeb = {
    async postMessage(args) {
      const r = await s.client.chat.postMessage({ ...args, unfurl_links: false, unfurl_media: false })
      return { ts: String(r.ts) }
    },
    async permalink(channel, ts) {
      const r = await s.client.chat.getPermalink({ channel, message_ts: ts })
      return r.permalink ?? null
    },
    async react(channel, ts, name) {
      await s.client.reactions.add({ channel, timestamp: ts, name })
    },
    async userName(userId) {
      const known = names.get(userId)
      if (known) return known
      const r = await s.client.users.info({ user: userId })
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

  const socket = new SocketModeClient({ appToken: s.appToken, logLevel: LogLevel.WARN })
  const onEvent = async ({ body, ack: ackSlack }: { body: SlackEnvelope; ack: () => Promise<void> }) => {
    lastEventAt = new Date().toISOString()
    try {
      await ackSlack() // inside Slack's 3 seconds, before any Linear call
      await handleEnvelope(deps, body)
    } catch (error) {
      // An unacknowledged delivery comes again, and the inbox keeps it to one.
      log.error("event failed", { error: String(error) })
    }
  }
  socket.on("app_mention", onEvent)
  socket.on("message", onEvent)
  socket.on("reaction_added", onEvent)
  // A dropped connection reconnects on its own and never reports
  // "disconnected" (@slack/socket-mode 3), so "reconnecting" is the drop.
  for (const state of ["connected", "reconnecting", "disconnected"] as const) {
    socket.on(state, () => {
      connected = state === "connected"
      writeStatus()
    })
  }

  // Before the connection, which waits out a Slack outage: the heartbeat and
  // the intake retry must not wait with it.
  let draining = false
  setInterval(async () => {
    if (draining) return
    draining = true
    try {
      await drainOutbox(sendContext, log)
    } catch (error) {
      if (error instanceof SlackTokenRefused) halt(error)
      log.error("outbox drain failed", { error: String(error) })
    } finally {
      draining = false
    }
  }, 2_000)
  setInterval(() => {
    retryPending(deps).catch((error) => log.error("retry failed", { error: String(error) }))
  }, 60_000)
  setInterval(() => writeStatus(), 30_000)
  writeStatus()

  await socket.start().catch(halt)
  log.info("bridge connected", { team: s.teamId, channels: s.channelIds })
}

if (process.argv[1]?.endsWith("bridge.ts")) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
