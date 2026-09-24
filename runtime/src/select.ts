/**
 * The queue rules, pure (spec 6.4 to 6.6, with decision 1).
 *
 * develop: a Ready issue labelled agent-ready and this mini's product, held by
 *   nobody or by this mini, never a human to-do or one waiting for an answer.
 *   The issue this mini already holds goes first (it was parked and answered,
 *   or paused by a usage limit), then the unassigned queue in listReady's
 *   order (priority, then age).
 * refine: while fewer than refineWhenReadyBelow are eligible for develop,
 *   Triage first, then Refining, then Ready issues nobody has refined. A
 *   human to-do comes back only once a person has answered in Slack.
 * allowlist mode (the rehearsal): only the listed ids, for both.
 */

import type { TrackerIssue } from "./tracker.ts"

export interface QueuePolicy {
  mode: "allowlist" | "open"
  allow: string[]
  refineWhenReadyBelow: number
  product: string
}

const HANDS_OFF = ["human-todo", "awaiting-answer"]

/** Whether this mini may refine or develop an issue at all: in allowlist mode, only the ids on the list. */
export function onQueue(id: string, policy: Pick<QueuePolicy, "mode" | "allow">): boolean {
  return policy.mode === "open" || policy.allow.includes(id)
}

export function developEligible(issue: TrackerIssue, meId: string, policy: QueuePolicy): boolean {
  if (issue.state !== "Ready") return false
  if (!issue.labels.includes("agent-ready") || !issue.labels.includes(policy.product)) return false
  if (HANDS_OFF.some((l) => issue.labels.includes(l))) return false
  if (issue.assigneeId !== null && issue.assigneeId !== meId) return false
  return onQueue(issue.id, policy)
}

export function refineEligible(issue: TrackerIssue, policy: QueuePolicy): boolean {
  if (!["Triage", "Refining", "Ready"].includes(issue.state)) return false
  if (issue.labels.includes("agent-ready") || issue.labels.includes("awaiting-answer")) return false
  // A human to-do waits for a person. Their Slack reply moves it to Refining
  // (answerTransition), and only then does /refine look at it again.
  if (issue.labels.includes("human-todo") && issue.state !== "Refining") return false
  // Triage comes from Slack and the bug receivers; refine decides its product.
  if (issue.state !== "Triage" && !issue.labels.includes(policy.product)) return false
  return onQueue(issue.id, policy)
}

export interface SelectionInput {
  /** Ready issues, sorted by byPriorityThenAge. */
  ready: TrackerIssue[]
  triage: TrackerIssue[]
  refining: TrackerIssue[]
  meId: string
  policy: QueuePolicy
  /** Paused, a worker busy, or the usage limits. */
  developBlockedBy: string | null
  /** Paused. Light mode still refines (spec 6.6). */
  refineBlockedBy: string | null
}

export function selectNext(input: SelectionInput): { develop: TrackerIssue | null; refine: TrackerIssue | null; readyEligible: number } {
  const eligible = input.ready.filter((i) => developEligible(i, input.meId, input.policy))
  const develop = input.developBlockedBy
    ? null
    : (eligible.find((i) => i.assigneeId === input.meId) ?? eligible.find((i) => i.assigneeId === null) ?? null)
  let refine: TrackerIssue | null = null
  if (!input.refineBlockedBy && eligible.length < input.policy.refineWhenReadyBelow) {
    refine = [...input.triage, ...input.refining, ...input.ready].find((i) => refineEligible(i, input.policy)) ?? null
  }
  return { develop, refine, readyEligible: eligible.length }
}

/** One minute after anything happened, five in the working day, thirty at night (spec 6.1: floor one minute). */
export function nextWakeupSeconds(input: { acted: boolean; now: Date; timeZone: string }): number {
  if (input.acted) return 60
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: input.timeZone, hour: "numeric", hourCycle: "h23" }).format(input.now))
  return hour >= 7 && hour < 22 ? 300 : 1800
}
