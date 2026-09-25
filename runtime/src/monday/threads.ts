/**
 * Where a Needs-you item's words go in Slack (spec 6: every item has one
 * thread). The issue's own thread on this mini first; else the thread
 * another mini opened, by the link Linear keeps; else, when asked to, a new
 * thread in #polads-questions (the Slack outbox opens it, send.ts).
 */
import type { AgentPaths } from "../config.ts"
import type { OutboxMessage } from "../outbox.ts"
import { threadFor } from "../threads.ts"

const PERMALINK = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([CGD][A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?(.*))?$/

/** A Slack message link as the thread it is in: its own, or, for a reply, its thread_ts. null when it is not one. */
export function slackThreadOf(permalink: string | null | undefined): { channelId: string; threadTs: string } | null {
  const m = PERMALINK.exec(permalink ?? "")
  if (!m) return null
  const inThread = new URLSearchParams(m[4] ?? "").get("thread_ts")
  return { channelId: m[1], threadTs: inThread && /^\d{10}\.\d{6}$/.test(inThread) ? inThread : `${m[2]}.${m[3]}` }
}

export type SlackTarget = { kind: "own" } | { kind: "linked"; channelId: string; threadTs: string } | { kind: "none" }

export function threadTarget(paths: AgentPaths, issue: string, permalink: string | null): SlackTarget {
  if (threadFor(paths, issue)) return { kind: "own" }
  const linked = slackThreadOf(permalink)
  return linked ? { kind: "linked", ...linked } : { kind: "none" }
}

/** The outbox message for a target. `open`: with no thread anywhere, open one; else say nothing. */
export function slackMessage(target: SlackTarget, issue: string, text: string, open: boolean): OutboxMessage | null {
  if (target.kind === "own" || (target.kind === "none" && open)) return { kind: "issue", issue, text, question: false }
  if (target.kind === "linked") return { kind: "reply", channelId: target.channelId, threadTs: target.threadTs, text }
  return null
}
