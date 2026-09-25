/**
 * Everything that posts to Slack goes through this queue, and only the bridge
 * drains it. So the worker, the front door and agentd never hold a Slack
 * token, and Slack being down (spec 12) only means the queue waits. Keys sort
 * by queue time, then by a per-process sequence, so the bridge posts one
 * process's messages in the order they were queued, even within a millisecond.
 */

import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { AgentPaths } from "./config.ts"
import { putOnce, readJson, safeKey, writeJsonAtomic } from "./fsq.ts"
import { redact } from "./log.ts"

export type ChannelKey = "agents" | "questions" | "intake" | "releases"

export type OutboxMessage =
  /** A notice in a channel: claimed, PR opened, parked, alerts. */
  | { kind: "post"; channel: ChannelKey; text: string }
  /**
   * A reply in a thread the caller knows, e.g. the front door answering a
   * mention. frontDoor: the front door's own words (agentctl slack reply),
   * which the thread records the time of (STEP-3293 review).
   */
  | { kind: "reply"; channelId: string; threadTs: string; text: string; frontDoor?: boolean }
  /** A message in the issue's own thread. The bridge opens one in #polads-questions when there is none. */
  | { kind: "issue"; issue: string; text: string; question: boolean }
  /** A reaction, e.g. a tick on an answer that was applied. */
  | { kind: "react"; channelId: string; ts: string; name: string }

let sequence = 0

export function enqueueSlack(paths: AgentPaths, message: OutboxMessage, now: Date = new Date()): string {
  sequence = (sequence + 1) % 1_000_000
  const key = `${String(now.getTime()).padStart(15, "0")}-${String(sequence).padStart(6, "0")}-${randomUUID()}`
  // Worker and git error text come through here, and the queue files stay on
  // disk: token-shaped strings are redacted before they are written.
  const safe = "text" in message ? { ...message, text: redact(message.text) } : message
  putOnce(paths.outbox, key, { ...safe, queuedAt: now.toISOString() })
  if (safe.kind === "issue" && safe.question) writeJsonAtomic(questionPath(paths, safe.issue), { text: safe.text, at: now.toISOString() })
  return key
}

const questionPath = (paths: AgentPaths, issue: string) => join(paths.state, "questions", `${safeKey(issue)}.json`)

/**
 * The newest question this mini asked about an issue (a worker's, a
 * decision's, a person's to-do), as Slack got it. The Monday bridge shows it
 * on the board (STEP-3289), where the Slack thread is out of reach.
 */
export function lastQuestion(paths: AgentPaths, issue: string): { text: string; at: string } | null {
  return readJson<{ text: string; at: string }>(questionPath(paths, issue))
}
