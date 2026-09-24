/**
 * Posting what the outbox holds. The bridge is the only caller. Threading for
 * `issue` messages lives here: each send re-reads the issue's thread file and
 * the outbox drains in order, so two questions queued before the first is
 * posted still land in one thread (spec 6.5).
 */

import type { AgentPaths } from "../config.ts"
import { ack, fail, listNew } from "../fsq.ts"
import { appendLedger, redact, type Logger } from "../log.ts"
import type { ChannelKey, OutboxMessage } from "../outbox.ts"
import { saveThread, threadFor, type ThreadRecord } from "../threads.ts"
import { prefixed } from "./text.ts"

/** The Web API calls a send makes. Tests pass a fake. */
export interface SlackWeb {
  postMessage(args: { channel: string; text: string; thread_ts?: string }): Promise<{ ts: string }>
  permalink(channel: string, ts: string): Promise<string | null>
  react(channel: string, ts: string, name: string): Promise<void>
}

export interface SendContext {
  paths: AgentPaths
  mini: string
  channelIds: Record<ChannelKey, string>
  web: SlackWeb
  /** Title and URL for an issue's first thread message. null when Linear cannot say right now. */
  describeIssue(issue: string): Promise<{ title: string; url: string } | null>
  /** Stores the thread link on the issue (spec 6.5). */
  attachThread(issue: string, permalink: string): Promise<void>
  now(): Date
}

/**
 * The thread's link, on the issue and then on the thread record. Called
 * after the message is out, so it never throws: a failure is a warning. The
 * record keeps no link until the issue has it, so a thread whose link is
 * missing on either side gets another go with its next message.
 */
async function linkThread(ctx: SendContext, thread: ThreadRecord): Promise<{ warning?: string }> {
  const permalink = await ctx.web.permalink(thread.channelId, thread.ts).catch(() => null)
  if (!permalink) return { warning: `no permalink for the thread of ${thread.issue}` }
  try {
    await ctx.attachThread(thread.issue, permalink)
  } catch (error) {
    return { warning: `could not attach the Slack thread to ${thread.issue}: ${error instanceof Error ? error.message : String(error)}` }
  }
  saveThread(ctx.paths, { ...thread, permalink })
  return {}
}

/**
 * Sends one outbox message. `posted` runs the moment Slack has it, before
 * any call that follows (the permalink, the Linear link), so the drain takes
 * it off the queue then: a crash in those calls must not post it again.
 */
export async function sendOutboxMessage(ctx: SendContext, msg: OutboxMessage, posted: () => void = () => {}): Promise<{ warning?: string }> {
  // Worker and git error text reach Slack through here: no token-shaped string does.
  const say = (text: string) => prefixed(ctx.mini, redact(text))
  switch (msg.kind) {
    case "post":
      await ctx.web.postMessage({ channel: ctx.channelIds[msg.channel], text: say(msg.text) })
      posted()
      return {}
    case "reply":
      await ctx.web.postMessage({ channel: msg.channelId, thread_ts: msg.threadTs, text: say(msg.text) })
      posted()
      return {}
    case "react":
      await ctx.web.react(msg.channelId, msg.ts, msg.name).catch((error: unknown) => {
        // Already there is what the message asked for.
        if (slackErrorCode(error) !== "already_reacted") throw error
      })
      posted()
      return {}
    case "issue": {
      const nowIso = ctx.now().toISOString()
      const existing = threadFor(ctx.paths, msg.issue)
      if (existing) {
        await ctx.web.postMessage({ channel: existing.channelId, thread_ts: existing.ts, text: say(msg.text) })
        posted()
        const thread = msg.question ? { ...existing, lastQuestionAt: nowIso } : existing
        if (msg.question) saveThread(ctx.paths, thread)
        return existing.permalink ? {} : linkThread(ctx, thread)
      }
      const about = await ctx.describeIssue(msg.issue).catch(() => null)
      const head = about ? `${msg.issue} ${about.title}\n${about.url}` : msg.issue
      const channel = ctx.channelIds.questions
      const { ts } = await ctx.web.postMessage({ channel, text: say(`${head}\n\n${msg.text}`) })
      // The message is out: nothing below may throw. The thread is recorded
      // before any call that can wait, so a restart replies in it, where a
      // second thread would leave answers in the first one unread.
      const thread = { issue: msg.issue, channelId: channel, ts, permalink: null, createdAt: nowIso, lastQuestionAt: msg.question ? nowIso : null }
      saveThread(ctx.paths, thread)
      posted()
      return linkThread(ctx, thread)
    }
  }
}

/** The refusal Slack gave (`ok: false`), e.g. channel_not_found. null for the network, HTTP errors and rate limits. */
export function slackErrorCode(error: unknown): string | null {
  const code = (error as { data?: { error?: unknown } } | null)?.data?.error
  return typeof code === "string" ? code : null
}

/** Refusals of the app itself, its token or its scopes, not of one message: nothing goes out until a person fixes it. */
const ACCESS_REFUSALS = new Set([
  "invalid_auth", "not_authed", "account_inactive", "token_revoked", "token_expired", "team_access_not_granted",
  "missing_scope", "no_permission", "not_allowed_token_type", "access_denied", "ekm_access_denied",
])
/** The bot cannot use a channel. In one of its own four, every later message there would fail too. */
const CHANNEL_REFUSALS = new Set(["not_in_channel", "channel_not_found", "is_archived"])
/** Slack's own trouble, reported as a refusal: worth another go, like the network. */
const SLACK_TROUBLE = new Set([
  "internal_error", "fatal_error", "service_unavailable", "request_timeout", "ratelimited", "rate_limited",
  // The workspace is moving into an Enterprise org: Slack says to try again later.
  "team_added_to_org",
])

export function isSlackTrouble(error: unknown): boolean {
  const code = slackErrorCode(error)
  return code !== null && SLACK_TROUBLE.has(code)
}


/**
 * What a failed send means for the queue: retry (keep it, stop this drain),
 * drop (move it to failed, carry on) or pause (keep everything, and try again
 * after a pause, reporting why). `ownChannel` names the bot's own channel the
 * message went to, if it went to one of the four.
 */
export function sendFailure(error: unknown, ownChannel: ChannelKey | null = null): "retry" | "drop" | "pause" {
  const code = slackErrorCode(error)
  if (code === null || SLACK_TROUBLE.has(code)) return "retry"
  if (ACCESS_REFUSALS.has(code) || (ownChannel !== null && CHANNEL_REFUSALS.has(code))) return "pause"
  // Any other refusal is about this message (a thread deleted, a text too
  // long, a channel outside the four): kept waiting, it would hold up every one after it.
  return "drop"
}

/** Slack refused the app itself, or one of its four channels: the outbox waits, every message kept, for a person. */
export class SlackAccessRefused extends Error {}

/** Which of the bot's four channels a message goes to, if any. */
function ownChannelOf(ctx: SendContext, msg: OutboxMessage): ChannelKey | null {
  const byId = (id: string) => (Object.entries(ctx.channelIds) as Array<[ChannelKey, string]>).find(([, value]) => value === id)?.[0] ?? null
  switch (msg.kind) {
    case "post":
      return msg.channel
    case "reply":
    case "react":
      return byId(msg.channelId)
    case "issue":
      return byId(threadFor(ctx.paths, msg.issue)?.channelId ?? ctx.channelIds.questions)
  }
}

/**
 * Whether an entry is a message this bridge can send. The files are written
 * by other processes (agentd, the worker, agentctl) and can come from another
 * version of them, or from a hand: one it cannot read must not hold up the queue.
 */
function isOutboxMessage(ctx: SendContext, value: unknown): value is OutboxMessage {
  const m = value as Record<string, unknown> | null
  const text = (key: string) => typeof m?.[key] === "string" && (m[key] as string).length > 0
  switch (m?.kind) {
    case "post":
      return text("text") && Object.hasOwn(ctx.channelIds, m.channel as string)
    case "reply":
      return text("channelId") && text("threadTs") && text("text")
    case "react":
      return text("channelId") && text("ts") && text("name")
    case "issue":
      return text("issue") && text("text") && typeof m.question === "boolean"
    default:
      return false
  }
}

/**
 * Posts what is waiting, oldest first. Stops at the first failure worth
 * retrying so the order holds, moves a message Slack refuses (or one it
 * cannot read) to failed, and throws SlackAccessRefused, every message still
 * queued, when Slack refuses the app itself or one of its four channels.
 */
export async function drainOutbox(ctx: SendContext, log: Logger): Promise<number> {
  let sent = 0
  for (const { key, payload } of listNew<unknown>(ctx.paths.outbox)) {
    if (!isOutboxMessage(ctx, payload)) {
      log.error("outbox entry is not a message this bridge can send, moved to failed", { key })
      fail(ctx.paths.outbox, key)
      continue
    }
    // Off the queue the moment Slack has it, and at the latest when the send
    // returns: a kind that forgot to say so must not go out every 2 seconds.
    let acked = false
    const posted = () => {
      if (!acked) {
        acked = true
        ack(ctx.paths.outbox, key)
      }
    }
    try {
      const { warning } = await sendOutboxMessage(ctx, payload, posted)
      posted()
      if (warning) log.warn(warning, { key })
      if (payload.kind === "issue" && payload.question) appendLedger(ctx.paths, { type: "question.asked", issue: payload.issue }, ctx.now())
      sent++
    } catch (error) {
      const code = slackErrorCode(error)
      const own = ownChannelOf(ctx, payload)
      const failure = sendFailure(error, own)
      if (failure === "drop") {
        log.error("outbox message refused by Slack, moved to failed", { key, error: String(error) })
        fail(ctx.paths.outbox, key)
        continue
      }
      if (failure === "pause") {
        const what = code !== null && CHANNEL_REFUSALS.has(code) ? `a message to the ${own} channel (${ctx.channelIds[own!]})` : "the app"
        throw new SlackAccessRefused(
          `slack-bridge: Slack refused ${what}: ${code}, sending outbox entry ${key}. ` +
            `The outbox keeps every message and tries again every few minutes. ` +
            `Fix the app's scopes or channels, or its token (a new token needs a restart of the bridge).`,
        )
      }
      log.warn("outbox waiting: Slack unreachable", { key, error: String(error) })
      break
    }
  }
  return sent
}

/**
 * Drains the outbox every `everyMs`. When Slack refuses the app, it pauses
 * for `pauseMs` with every message kept, then tries again, and tells `report`
 * why, once per reason. A re-invited bot or a reinstalled app goes on by
 * itself: the first message that goes out after a refusal reports null. A new
 * token needs a restart, because the bridge reads it at start. Returns the stop.
 */
export function startOutbox(
  ctx: SendContext,
  log: Logger,
  report: (reason: string | null) => void,
  everyMs = 2_000,
  pauseMs = 5 * 60_000,
): () => void {
  let draining = false
  let pausedUntil = 0
  let reported: string | null = null
  const timer = setInterval(async () => {
    if (draining || Date.now() < pausedUntil) return
    draining = true
    try {
      const sent = await drainOutbox(ctx, log)
      if (sent > 0 && reported !== null) {
        reported = null
        log.info("outbox going again")
        report(null)
      }
    } catch (error) {
      if (error instanceof SlackAccessRefused) {
        pausedUntil = Date.now() + pauseMs
        if (error.message !== reported) {
          reported = error.message
          log.error("outbox paused", { error: error.message })
          report(error.message)
        }
      } else {
        log.error("outbox drain failed", { error: String(error) })
      }
    } finally {
      draining = false
    }
  }, everyMs)
  return () => clearInterval(timer)
}
