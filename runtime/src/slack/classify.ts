/**
 * What one Socket Mode delivery is. Pure: the bridge passes a lookup for
 * "which issue owns this thread", so every rule is unit-tested.
 *
 * Every agent has its own Slack app, and the four channels are shared
 * (decision 3, 2026-09-24). So a bridge acts only on messages that mention
 * its own bot and on replies in threads it owns, intake included. The
 * mention is read from the text, never from the event type: the delivery an
 * app_mention subscription brings in proves nothing about whose name the
 * text carries. A request that names several agents is filed by the first
 * agent it names, which owns its thread. Every other agent it names treats it
 * as a mention (marked `filedBy` that agent), answered in that same thread,
 * and never applies the thread's later replies as answers: a later reply
 * that names it is only a mention for it.
 *
 * In order:
 *  1. A delivery for another installation of the app (another workspace) is
 *     ignored. That is the envelope's authorization, never the sender's team:
 *     in a Slack Connect channel a sender from another workspace carries
 *     their own team, and the allowlist of member ids (3) decides who is heard.
 *  2. Bots (ours included), edits, deletes and joins are ignored.
 *  3. People not on the allowlist are ignored. A Slack message can never
 *     grant a permission (spec 11); here it cannot even start work.
 *  4. A reply in a thread that belongs to one of this mini's issues is an answer.
 *  5. A top-level message in #polads-intake that names this bot before any
 *     other agent is intake. Named after another agent, it is a mention
 *     that agent files.
 *  6. Any other mention of this bot is a mention, answered in its thread.
 *  7. Everything else is ignored, other agents' mentions included.
 * Both copies of a mentioning message (app_mention and message) get the key
 * msg:<channel>:<ts>, so the queue keeps one.
 */

import { mentionedUsers } from "./text.ts"

export interface SlackEvent {
  type: string
  subtype?: string
  user?: string
  bot_id?: string
  text?: string
  channel?: string
  /** channel (public) or group (private): the four may be either, and both read alike. */
  channel_type?: string
  ts?: string
  thread_ts?: string
  reaction?: string
  item?: { type?: string; channel?: string; ts?: string }
}

export interface SlackEnvelope {
  /** Slack says this mirrors authorizations[0]. */
  team_id?: string
  /** The installation this delivery is for. Slack sends one. */
  authorizations?: Array<{ team_id?: string | null }>
  event_id?: string
  event?: SlackEvent
}

export interface ClassifyContext {
  teamId: string
  botUserId: string
  /** The other agents' bot user ids (config slack.otherAgentBots). */
  otherAgentBots: readonly string[]
  allowedUsers: readonly string[]
  channels: { agents: string; questions: string; intake: string; releases: string }
  issueForThread: (channelId: string, threadTs: string) => string | null
}

export type Classified =
  | { type: "intake"; key: string; channel: string; ts: string; user: string; text: string }
  | { type: "answer"; key: string; issue: string; channel: string; ts: string; threadTs: string; user: string; text: string }
  | {
      type: "mention"
      key: string
      channel: string
      ts: string
      threadTs: string
      user: string
      text: string
      /** An intake request another agent was named first in: that agent's bot files it, so the front door must not. */
      filedBy?: string
    }
  | { type: "reaction"; key: string; channel: string; itemTs: string; user: string; reaction: string }
  | { type: "ignore"; reason: string }

const PASS_SUBTYPES = new Set<string | undefined>([undefined, "thread_broadcast", "file_share"])

export function classify(envelope: SlackEnvelope, ctx: ClassifyContext): Classified {
  const e = envelope.event
  if (!e) return { type: "ignore", reason: "no event" }
  const installedIn = envelope.authorizations?.[0]?.team_id ?? envelope.team_id
  if (installedIn && installedIn !== ctx.teamId) return { type: "ignore", reason: "another workspace" }
  if (e.bot_id || e.user === ctx.botUserId || !PASS_SUBTYPES.has(e.subtype)) return { type: "ignore", reason: "bot or system message" }
  if (!e.user || !ctx.allowedUsers.includes(e.user)) return { type: "ignore", reason: "sender not on the allowlist" }

  if (e.type === "reaction_added") {
    const channel = e.item?.channel
    const itemTs = e.item?.ts
    if (!channel || !itemTs || !Object.values(ctx.channels).includes(channel)) return { type: "ignore", reason: "reaction outside our channels" }
    return { type: "reaction", key: `reaction:${channel}:${itemTs}:${e.user}:${e.reaction ?? ""}`, channel, itemTs, user: e.user, reaction: e.reaction ?? "" }
  }

  if (e.type !== "app_mention" && e.type !== "message") return { type: "ignore", reason: `event type ${e.type}` }
  if (!e.channel || !e.ts) return { type: "ignore", reason: "no channel or ts" }

  const key = `msg:${e.channel}:${e.ts}`
  const text = e.text ?? ""
  const threadTs = e.thread_ts && e.thread_ts !== e.ts ? e.thread_ts : null
  const mentioned = mentionedUsers(text)

  if (threadTs) {
    const issue = ctx.issueForThread(e.channel, threadTs)
    if (issue) return { type: "answer", key, issue, channel: e.channel, ts: e.ts, threadTs, user: e.user, text }
  }
  if (!mentioned.includes(ctx.botUserId)) return { type: "ignore", reason: "not addressed to the bot" }
  const firstAgent = mentioned.find((id) => id === ctx.botUserId || ctx.otherAgentBots.includes(id))
  const isRequest = e.channel === ctx.channels.intake && !threadTs
  if (isRequest && firstAgent === ctx.botUserId) {
    return { type: "intake", key, channel: e.channel, ts: e.ts, user: e.user, text }
  }
  return {
    type: "mention",
    key,
    channel: e.channel,
    ts: e.ts,
    threadTs: threadTs ?? e.ts,
    user: e.user,
    text,
    ...(isRequest && firstAgent ? { filedBy: firstAgent } : {}),
  }
}
