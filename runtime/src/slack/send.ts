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
import { saveThread, threadFor } from "../threads.ts"
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
        if (msg.question) saveThread(ctx.paths, { ...existing, lastQuestionAt: nowIso })
        return {}
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
      const permalink = await ctx.web.permalink(channel, ts).catch(() => null)
      if (!permalink) return { warning: `no permalink for the new thread of ${msg.issue}` }
      saveThread(ctx.paths, { ...thread, permalink })
      try {
        await ctx.attachThread(msg.issue, permalink)
        return {}
      } catch (error) {
        return { warning: `could not attach the Slack thread to ${msg.issue}: ${error instanceof Error ? error.message : String(error)}` }
      }
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
  "missing_scope", "no_permission", "not_allowed_token_type", "ekm_access_denied",
])
/** Slack's own trouble, reported as a refusal: worth another go, like the network. */
const SLACK_TROUBLE = new Set(["internal_error", "fatal_error", "service_unavailable", "request_timeout", "ratelimited"])

export function isSlackTrouble(error: unknown): boolean {
  const code = slackErrorCode(error)
  return code !== null && SLACK_TROUBLE.has(code)
}

/** What a failed send means for the queue. */
export function sendFailure(error: unknown): "retry" | "drop" | "stop" {
  const code = slackErrorCode(error)
  if (code === null || SLACK_TROUBLE.has(code)) return "retry"
  // Any other refusal is about this message (a channel archived, a thread
  // deleted, a text too long): kept waiting, it would hold up every one after it.
  return ACCESS_REFUSALS.has(code) ? "stop" : "drop"
}

/** Slack refused the app itself: the bridge stops, and every message waits for a person to fix it. */
export class SlackAccessRefused extends Error {}

/**
 * Posts what is waiting, oldest first. Stops at the first failure worth
 * retrying so the order holds, moves a message Slack refuses to failed, and
 * throws SlackAccessRefused, with every message still queued, when Slack
 * refuses the app itself.
 */
export async function drainOutbox(ctx: SendContext, log: Logger): Promise<number> {
  let sent = 0
  for (const { key, payload } of listNew<OutboxMessage>(ctx.paths.outbox)) {
    try {
      const { warning } = await sendOutboxMessage(ctx, payload, () => ack(ctx.paths.outbox, key))
      if (warning) log.warn(warning, { key })
      if (payload.kind === "issue" && payload.question) appendLedger(ctx.paths, { type: "question.asked", issue: payload.issue }, ctx.now())
      sent++
    } catch (error) {
      const failure = sendFailure(error)
      if (failure === "drop") {
        log.error("outbox message refused by Slack, moved to failed", { key, error: String(error) })
        fail(ctx.paths.outbox, key)
        continue
      }
      if (failure === "stop") {
        throw new SlackAccessRefused(`slack-bridge: Slack refused the app (${slackErrorCode(error)}). Fix its token or scopes, then restart the bridge.`)
      }
      log.warn("outbox waiting: Slack unreachable", { key, error: String(error) })
      break
    }
  }
  return sent
}
