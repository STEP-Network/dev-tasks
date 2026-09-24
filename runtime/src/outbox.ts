/**
 * Everything that posts to Slack goes through this queue, and only the bridge
 * drains it. So the worker, the front door and agentd never hold a Slack
 * token, and Slack being down (spec 12) only means the queue waits. Keys sort
 * by queue time, then by a per-process sequence, so the bridge posts one
 * process's messages in the order they were queued, even within a millisecond.
 */

import { randomUUID } from "node:crypto"
import type { AgentPaths } from "./config.ts"
import { putOnce } from "./fsq.ts"

export type ChannelKey = "agents" | "questions" | "intake" | "releases"

export type OutboxMessage =
  /** A notice in a channel: claimed, PR opened, parked, alerts. */
  | { kind: "post"; channel: ChannelKey; text: string }
  /** A reply in a thread the caller knows, e.g. the front door answering a mention. */
  | { kind: "reply"; channelId: string; threadTs: string; text: string }
  /** A message in the issue's own thread. The bridge opens one in #polads-questions when there is none. */
  | { kind: "issue"; issue: string; text: string; question: boolean }
  /** A reaction, e.g. a tick on an answer that was applied. */
  | { kind: "react"; channelId: string; ts: string; name: string }

let sequence = 0

export function enqueueSlack(paths: AgentPaths, message: OutboxMessage, now: Date = new Date()): string {
  sequence = (sequence + 1) % 1_000_000
  const key = `${String(now.getTime()).padStart(15, "0")}-${String(sequence).padStart(6, "0")}-${randomUUID()}`
  putOnce(paths.outbox, key, { ...message, queuedAt: now.toISOString() })
  return key
}
