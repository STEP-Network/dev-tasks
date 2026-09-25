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
  [/^the worker process (failed|died)/, () => "my run stopped unexpectedly"],
  [/^the worker overran its wall clock of (\d+) minutes/, (m) => `I ran out of time (${m[1]} minutes)`],
  [/^the worker was still preparing its worktree/, () => "setting up my copy of the code took too long"],
  [/^the worker could not be started/, () => "my run could not start"],
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
