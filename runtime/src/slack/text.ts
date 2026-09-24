/**
 * Pure text for Slack traffic. What people read follows the PolAds copy
 * rules: British English, no semicolons, no em or en dashes.
 */

import type { CreateIssueInput, TrackerIssue } from "../tracker.ts"

/** Every message carries the agent's name first (spec 8). */
export function prefixed(mini: string, text: string): string {
  return `${mini}: ${text}`
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Cuts between characters as a reader sees them: never inside an emoji, a flag or a letter with its accent. */
export function truncateChars(text: string, max: number): string {
  const chars = Array.from(graphemes.segment(text), (s) => s.segment)
  return chars.length <= max ? text : chars.slice(0, Math.max(0, max - 3)).join("").trimEnd() + "..."
}

export function stripMention(text: string, botUserId: string): string {
  return text.split(`<@${botUserId}>`).join("").replace(/[ \t]+/g, " ").trim()
}

export interface IntakeMeta {
  userName: string
  permalink: string
  botUserId: string
  product: string
}

/** The Triage issue an intake mention becomes. null when the mention carries no request. */
export function intakeIssue(text: string, meta: IntakeMeta): CreateIssueInput | null {
  const body = stripMention(text, meta.botUserId)
  if (!body) return null
  const firstLine = body.split("\n").find((line) => line.trim())!.trim()
  return {
    title: truncateChars(firstLine, 80),
    description: `${body}\n\n---\nFiled from Slack by ${meta.userName}: ${meta.permalink}`,
    labels: [meta.product],
    state: "Triage",
  }
}

export interface SlackAnswer {
  ts: string
  userName: string
  text: string
  permalink: string | null
}

export const ANSWERS_HEADING = "## Answers from Slack"

/** Appends once per Slack message: the ts marker makes a redelivery a no-op. */
export function appendAnswer(description: string, answer: SlackAnswer): string {
  const marker = `<!-- slack:${answer.ts} -->`
  if (description.includes(marker)) return description
  const link = answer.permalink ? ` ([Slack](${answer.permalink}))` : ""
  const entry = `${marker}\n**${answer.userName}**${link}: ${answer.text}`
  const base = description.trimEnd()
  return base.includes(ANSWERS_HEADING) ? `${base}\n\n${entry}` : `${base}\n\n${ANSWERS_HEADING}\n\n${entry}`
}

/**
 * What a person's reply in an issue's thread does to the issue. Only a parked
 * issue (On hold) moves: back to Ready when an agent had already refined it
 * (a worker asked), back to Refining when not (/refine asked). An issue a
 * worker is running keeps its state; the answer is still appended.
 */
export function answerTransition(issue: Pick<TrackerIssue, "state" | "labels">): { state?: string; removeLabels?: string[] } {
  if (issue.state !== "On hold") return {}
  return {
    state: issue.labels.includes("agent-ready") ? "Ready" : "Refining",
    ...(issue.labels.includes("awaiting-answer") ? { removeLabels: ["awaiting-answer"] } : {}),
  }
}
