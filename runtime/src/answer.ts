/**
 * A person's answer on an issue, wherever they gave it (STEP-3293): in Slack,
 * where the front door read it and closed it with agentctl decide, or on the
 * Monday board (monday/route.ts). One function records both, so an answer
 * reads the same on the issue and moves it the same way, and a bare "yes" is
 * never recorded bare: it is recorded as the recommendation it agreed to.
 */

import type { AgentPaths } from "./config.ts"
import { recommendationOf } from "./plain.ts"
import { answerTransition, appendAnswer } from "./slack/text.ts"
import { threadFor, saveThread } from "./threads.ts"
import type { Tracker, TrackerIssue } from "./tracker.ts"

const AGREE = "(yes|yep|yeah|y|ok|okay|sure|fine|agreed|agree|go|go ahead|go for it|go with it|go with that|do it|sounds good|lgtm|👍|:\\+1:|:thumbsup:)"
const POLITE = "(please|thanks|thank you)"
/** Words that agree and say nothing else ("yes", "ok, go ahead", "yes please"): a decision needs what was decided. */
export const BARE = new RegExp(`^\\s*(${POLITE}[\\s,.!]+)*${AGREE}([\\s,.!]+(${AGREE}|${POLITE}))*[\\s.!]*$`, "i")

/** What a person decided, when it is more than their own words. */
export type Decided = { agreed: true; recommendation: string } | { agreed: false; text: string }

export interface PersonAnswer {
  issue: string
  who: string
  /** Their words, as they wrote them (names for Slack's mention markup). */
  words: string
  /** Where the answer sits in the description: the Slack message ts, or the Monday update id. */
  ts: string
  permalink: string | null
  source: "slack" | "monday"
  /** Absent: their words stand on their own. */
  decided?: Decided
}

/** The answer as the issue keeps it: whose, what, and their own words beside it. */
export function answerText(a: Pick<PersonAnswer, "who" | "words" | "decided">): string {
  if (!a.decided) return a.words
  const said = `(Their words: "${a.words.replace(/\s+/g, " ").trim()}")`
  return a.decided.agreed ? `${a.who} agreed with the recommendation: ${a.decided.recommendation}. ${said}` : `${a.who} decided: ${a.decided.text}. ${said}`
}

/**
 * Their plain yes to a question that recommended something, as that
 * recommendation. null when the words say more than yes, when the question
 * recommended nothing, or on a person's to-do, where a yes means they will
 * do it.
 */
export function agreedTo(words: string, question: string | null | undefined, issue: Pick<TrackerIssue, "labels">): Decided | null {
  if (!BARE.test(words) || issue.labels.includes("human-todo")) return null
  const recommendation = recommendationOf(question)
  return recommendation ? { agreed: true, recommendation } : null
}

/**
 * Records the answer on the issue, under "## Answers from Slack" or "from
 * Monday", and moves a parked issue on as an answer always did (unless
 * `move` is false: an instruction leaves the issue for agentd). The issue's
 * Slack thread then has no question left open. Returns where the issue went.
 */
export async function recordAnswer(
  deps: { paths: AgentPaths; tracker: Tracker },
  a: PersonAnswer,
  opts: { current?: TrackerIssue; move?: boolean } = {},
): Promise<{ movedTo: string | null; recorded: string }> {
  const current = opts.current ?? (await deps.tracker.readIssue(a.issue))
  if (a.decided?.agreed && current.labels.includes("human-todo")) {
    throw new Error(`${a.issue} waits on a person to do something (human-todo), so a yes is not a decision: once they say it is done, record that with --text-file, and otherwise ack it`)
  }
  const recorded = answerText(a)
  const description = appendAnswer(current.description, { ts: a.ts, userName: a.who, text: recorded, permalink: a.permalink }, a.source)
  const move = opts.move === false ? {} : answerTransition(current)
  const patch = { ...(description !== current.description ? { description } : {}), ...move }
  if (Object.keys(patch).length) await deps.tracker.updateIssue(a.issue, patch)
  const thread = threadFor(deps.paths, a.issue)
  if (thread?.openQuestions) saveThread(deps.paths, { ...thread, openQuestions: 0 })
  return { movedTo: move.state ?? null, recorded }
}
