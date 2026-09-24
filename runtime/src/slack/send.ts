/**
 * Posting what the outbox holds. The bridge is the only caller. Threading for
 * `issue` messages lives here: each send re-reads the issue's thread file and
 * the outbox drains in order, so two questions queued before the first is
 * posted still land in one thread (spec 6.5).
 */

import type { AgentPaths } from "../config.ts"
import { ack, fail, listNew } from "../fsq.ts"
import { appendLedger, type Logger } from "../log.ts"
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

export async function sendOutboxMessage(ctx: SendContext, msg: OutboxMessage): Promise<{ warning?: string }> {
  switch (msg.kind) {
    case "post":
      await ctx.web.postMessage({ channel: ctx.channelIds[msg.channel], text: prefixed(ctx.mini, msg.text) })
      return {}
    case "reply":
      await ctx.web.postMessage({ channel: msg.channelId, thread_ts: msg.threadTs, text: prefixed(ctx.mini, msg.text) })
      return {}
    case "react":
      await ctx.web.react(msg.channelId, msg.ts, msg.name)
      return {}
    case "issue": {
      const nowIso = ctx.now().toISOString()
      const existing = threadFor(ctx.paths, msg.issue)
      if (existing) {
        await ctx.web.postMessage({ channel: existing.channelId, thread_ts: existing.ts, text: prefixed(ctx.mini, msg.text) })
        if (msg.question) saveThread(ctx.paths, { ...existing, lastQuestionAt: nowIso })
        return {}
      }
      const about = await ctx.describeIssue(msg.issue).catch(() => null)
      const head = about ? `${msg.issue} ${about.title}\n${about.url}` : msg.issue
      const channel = ctx.channelIds.questions
      const { ts } = await ctx.web.postMessage({ channel, text: prefixed(ctx.mini, `${head}\n\n${msg.text}`) })
      // The message is out. Nothing below may throw, or the drain would post it again.
      const permalink = await ctx.web.permalink(channel, ts).catch(() => null)
      saveThread(ctx.paths, { issue: msg.issue, channelId: channel, ts, permalink, createdAt: nowIso, lastQuestionAt: msg.question ? nowIso : null })
      if (!permalink) return { warning: `no permalink for the new thread of ${msg.issue}` }
      try {
        await ctx.attachThread(msg.issue, permalink)
        return {}
      } catch (error) {
        return { warning: `could not attach the Slack thread to ${msg.issue}: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
  }
}

const PERMANENT = new Set([
  "channel_not_found", "not_in_channel", "is_archived", "invalid_auth", "account_inactive", "token_revoked",
  "msg_too_long", "no_text", "restricted_action", "thread_not_found", "message_not_found", "already_reacted", "invalid_name",
])

/** A refusal that retrying cannot fix. Anything else (network, rate limit, 5xx) is worth another go. */
export function isPermanentSlackError(error: unknown): boolean {
  const code = (error as { data?: { error?: string } } | null)?.data?.error
  return typeof code === "string" && PERMANENT.has(code)
}

/** Posts what is waiting, oldest first, and stops at the first transient failure so the order holds. */
export async function drainOutbox(ctx: SendContext, log: Logger): Promise<number> {
  let sent = 0
  for (const { key, payload } of listNew<OutboxMessage>(ctx.paths.outbox)) {
    try {
      const { warning } = await sendOutboxMessage(ctx, payload)
      if (warning) log.warn(warning, { key })
      ack(ctx.paths.outbox, key)
      if (payload.kind === "issue" && payload.question) appendLedger(ctx.paths, { type: "question.asked", issue: payload.issue }, ctx.now())
      sent++
    } catch (error) {
      if (isPermanentSlackError(error)) {
        log.error("outbox message refused by Slack, moved to failed", { key, error: String(error) })
        fail(ctx.paths.outbox, key)
        continue
      }
      log.warn("outbox waiting: Slack unreachable", { key, error: String(error) })
      break
    }
  }
  return sent
}
