/**
 * How the mini talks to people in Slack. Every message a person sees says,
 * in words someone who does not write code follows:
 *   1. what happened,
 *   2. what the mini did about it,
 *   3. the one thing it needs from them, or "Nothing needed from you."
 * No words from inside the machine: not "self-check", "siblings", "report",
 * "checklist", "worker", "worktree", "session" or "mutation". A PR is
 * "PR #1704". The PolAds copy rules hold too: British English, no
 * semicolons, no em or en dashes. The front door follows the same rule
 * (plugin/skills/front-door/SKILL.md, Replies).
 */

export const NOTHING_NEEDED = "Nothing needed from you."

/** "1 message", "3 messages". */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Words a person should never have to learn to read the mini's messages. */
export const JARGON = /\b(self-check|siblings?|reports?|checklist|worker|worktree|session|mutations?|reportProblem|wall-clock|structured output)\b/i

/** "PR #1704" for a PR's link, the link itself for anything else. */
export function prRef(url: string): string {
  const number = /\/pull\/(\d+)/.exec(url)?.[1]
  return number ? `PR #${number}` : url
}

/**
 * A job's stop reason as a person reads it. The runner's own reasons are
 * mapped. A reason the worker wrote itself, which its rules ask it to write
 * plainly, stays as it is.
 */
const PLAIN: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^the wall-clock limit of (\d+) minutes/, (m) => `I ran out of time (${m[1]} minutes)`],
  [/^the turn limit of/, () => "I reached the most steps one job may take"],
  [/^the budget of USD ([\d.]+)/, (m) => `I reached the spending limit for one job (USD ${m[1]})`],
  [/self-check is incomplete|lists no mutation check/, () => "I did not finish my own double-checks"],
  [/no valid final report|without a valid report|has no PR title/, () => "I finished without writing down what I did"],
  [/made no commits/, () => "I finished without changing any code"],
  [/^the worker process failed/, () => "my run stopped unexpectedly"],
  [/^an API error|^an error during execution/, () => "the AI service returned an error"],
  [/^origin has no branch/, () => "the PR's branch is gone from GitHub"],
  [/^the worktree could not be prepared|^the main checkout/, () => "I could not get a clean copy of the code to work on"],
  [/^finishing the job failed/, () => "sending the work to GitHub failed"],
  [/^needs input but asked no question/, () => "I got stuck without being able to say on what"],
]

export function plainReason(reason: string): string {
  const text = reason.trim().replace(/[\s.!?:;,]+$/, "")
  for (const [re, say] of PLAIN) {
    const m = re.exec(text)
    if (m) return say(m)
  }
  return text
}

/** What a revise job works on, from the reasons agentd gave it: the review, the checks, or both. */
export function feedbackFor(reasons: readonly string[]): string {
  // "Claude review failed" is a check, whose content is a review.
  const review = reasons.some((r) => /changes requested|comment|asked|review/i.test(r))
  const checks = reasons.some((r) => /failed/i.test(r) && !/review/i.test(r))
  if (review && checks) return "the review comments and the failing checks"
  if (checks) return "the failing checks"
  return "the review comments"
}

/** A PR as a Slack link that reads "PR #1704". */
export function prLink(url: string): string {
  const ref = prRef(url)
  return ref === url ? url : `<${url}|${ref}>`
}

/**
 * A question a person must answer, as posted: the question, then the mini's
 * recommendation and how to take it (STEP-3293). A reply of "yes" agrees to
 * exactly that recommendation, which agentctl decide --agree records.
 */
export const RECOMMENDATION_LEAD = "My recommendation:"
export const RECOMMENDATION_TAIL = "Reply yes to go with it, or tell me what you want instead."

export function withRecommendation(question: string, recommendation: string): string {
  const rec = recommendation.trim().replace(/[\s.!?:;,]+$/, "")
  return `${question.trim()}\n\n${RECOMMENDATION_LEAD} ${rec}. ${RECOMMENDATION_TAIL}`
}

/** The recommendation a posted question carries, or null when it carries none. */
export function recommendationOf(question: string | null | undefined): string | null {
  if (!question) return null
  const at = question.lastIndexOf(RECOMMENDATION_LEAD)
  if (at === -1) return null
  const rest = question.slice(at + RECOMMENDATION_LEAD.length)
  const end = rest.indexOf(RECOMMENDATION_TAIL)
  const rec = (end === -1 ? rest : rest.slice(0, end)).trim().replace(/[\s.]+$/, "")
  return rec || null
}

/**
 * A hand-off: something a person must do that the agent cannot (STEP-3293
 * review). It carries no recommendation, so a "yes" agrees to nothing: it
 * asks them to say when it is done.
 */
export const HANDOFF_TAIL = "Reply done when it is done."

export function handoff(text: string): string {
  return `${text.trim()}\n\n${HANDOFF_TAIL}`
}

/** A worker's question as a person reads it: with its recommendation, or saying plainly there is none to agree to. */
export function askWithRecommendation(question: string, recommendation: string | undefined): string {
  return recommendation?.trim() ? withRecommendation(question, recommendation) : `${question.trim()}\n\nI have no recommendation of my own on this one. Tell me what you want.`
}
