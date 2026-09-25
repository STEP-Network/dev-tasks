/**
 * Pure text for Slack traffic. What people read follows the PolAds copy
 * rules: British English, no semicolons, no em or en dashes.
 */

import { answerEntries, insertUnder, type CreateIssueInput, type TrackerIssue } from "../tracker.ts"

/** Every message carries the agent's name first (spec 8). */
export function prefixed(mini: string, text: string): string {
  return `${mini}: ${text}`
}

/**
 * Slack's special mentions made plain text (STEP-3353): <!channel>, <!here>,
 * <!everyone> and a user group's <!subteam^…> go out as they read, never
 * notifying anyone. A worker's words may carry what a PR or an issue told
 * it, and the runtime never writes one on purpose. A person's <@U…> stays a
 * mention.
 */
export function noBroadcast(text: string): string {
  return text.replace(/<!/g, "&lt;!")
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Cuts between characters as a reader sees them: never inside an emoji, a flag or a letter with its accent. */
export function truncateChars(text: string, max: number): string {
  const chars = Array.from(graphemes.segment(text), (s) => s.segment)
  return chars.length <= max ? text : chars.slice(0, Math.max(0, max - 3)).join("").trimEnd() + "..."
}

// A user mention as Slack writes it: <@U123>, or the older <@U123|name>.
const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g

/** The user ids a message mentions, people and bots alike, in the order it names them. */
export function mentionedUsers(text: string): string[] {
  return Array.from(text.matchAll(MENTION_RE), (m) => m[1])
}

export function stripMention(text: string, botUserId: string): string {
  return text.replace(MENTION_RE, (whole, id: string) => (id === botUserId ? "" : whole)).replace(/[ \t]+/g, " ").trim()
}

/**
 * Slack's message markup made readable, for Linear, which people read too
 * (decision 4): <@U1> becomes @Name (from `names`, else the id), <#C1|name>
 * #name, <!here> @here, a link [label](url) in Markdown or its label in plain
 * text, and &lt; &gt; &amp; the characters Slack escaped.
 */
export function fromSlack(text: string, names: Readonly<Record<string, string>> = {}, format: "markdown" | "plain" = "markdown"): string {
  const readable = text.replace(/<([^<>]*)>/g, (_whole, inner: string) => {
    const bar = inner.indexOf("|")
    const target = bar === -1 ? inner : inner.slice(0, bar)
    const label = bar === -1 ? "" : inner.slice(bar + 1)
    if (target.startsWith("@")) return `@${label || names[target.slice(1)] || target.slice(1)}`
    if (target.startsWith("#")) return `#${label || target.slice(1)}`
    // <!here>, <!channel>, and labelled specials such as <!subteam^S1|@devs>
    if (target.startsWith("!")) return label || `@${target.slice(1)}`
    if (!label) return target
    return format === "plain" ? label : `[${label}](${target})`
  })
  return readable.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
}

export interface IntakeMeta {
  userName: string
  permalink: string
  botUserId: string
  /** The other agents' bots: their names are no part of the request's title. */
  otherAgentBots?: readonly string[]
  product: string
  /** Display names for the users the request mentions, by id. */
  names?: Readonly<Record<string, string>>
}

/**
 * The Triage issue an intake mention becomes. null when the mention carries
 * no request, only agents' names. The description keeps the other agents'
 * names; the title leaves them out.
 */
export function intakeIssue(text: string, meta: IntakeMeta): CreateIssueInput | null {
  const body = stripMention(text, meta.botUserId)
  const request = (meta.otherAgentBots ?? []).reduce((rest, bot) => stripMention(rest, bot), body)
  if (!request) return null
  const firstLine = request.split("\n").find((line) => line.trim())!.trim()
  return {
    title: truncateChars(fromSlack(firstLine, meta.names, "plain"), 80),
    description: `${fromSlack(body, meta.names)}\n\n---\nFiled from Slack by ${meta.userName}: ${meta.permalink}`,
    labels: [meta.product],
    state: "Triage",
  }
}

export interface SlackAnswer {
  ts: string
  userName: string
  text: string
  permalink: string | null
  /** When the person wrote it (ISO), and their person key (answer.ts personKey): the first answer counts (spec 6). */
  at?: string
  by?: string
}

export const ANSWERS_HEADING = "## Answers from Slack"

/** Where an answer came from: a Slack message, or an update or the Answer column on the Monday board (STEP-3289). */
export type AnswerSource = "slack" | "monday"

const ANSWER_SOURCES: Record<AnswerSource, { heading: string; link: string }> = {
  slack: { heading: ANSWERS_HEADING, link: "Slack" },
  monday: { heading: "## Answers from Monday", link: "Monday" },
}

/**
 * Appends once per message: an entry for the same message (the Slack ts, or
 * the Monday update's id) makes a redelivery a no-op. Linear rebuilds a
 * description from its own document model and may drop an HTML comment, so
 * the answer's link, when it has one, counts too. A bare marker with no
 * words is no answer: the real one takes its place. The entry goes at the
 * end of its own heading's section, never under whichever heading is last.
 */
export function appendAnswer(description: string, answer: SlackAnswer, source: AnswerSource = "slack"): string {
  const { heading, link: label } = ANSWER_SOURCES[source]
  const same = answerEntries(description).find((e) => e.source === source && e.id === answer.ts)
  if (same?.who || (answer.permalink && description.includes(`(${answer.permalink})`))) return description
  const meta = `${answer.at ? ` at=${answer.at}` : ""}${answer.by ? ` by=${answer.by}` : ""}`
  const link = answer.permalink ? ` ([${label}](${answer.permalink}))` : ""
  const entry = `<!-- ${source}:${answer.ts}${meta} -->\n**${answer.userName}**${link}: ${answer.text}`
  if (same) return description.replace(same.raw, () => entry)
  return insertUnder(description, heading, entry)
}

/**
 * What a person's answer does to the issue. It settles what asked for a
 * person: the question (awaiting-answer) and needs-human, wherever the issue
 * is (spec 6: an answered item is Done in both places). Only a parked issue
 * (On hold) moves: back to Ready when an agent had already refined it (a
 * worker asked), back to Refining when not (/refine asked). An issue a worker
 * is running keeps its state; the answer is still appended.
 */
export function answerTransition(issue: Pick<TrackerIssue, "state" | "labels">): { state?: string; removeLabels?: string[] } {
  const answered = ["awaiting-answer", "needs-human"].filter((l) => issue.labels.includes(l))
  const labels = answered.length ? { removeLabels: answered } : {}
  if (issue.state !== "On hold") return labels
  return { state: issue.labels.includes("agent-ready") ? "Ready" : "Refining", ...labels }
}
