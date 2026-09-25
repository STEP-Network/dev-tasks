/**
 * A person's verdict on a change waiting to be tried (Wave 2, spec 3 and 6):
 * a PASS or FAIL on a Test day item, or on a Look "looks good" or "change:",
 * from either door. The Monday board read one before (STEP-3289); Slack reads
 * one now too, through agentctl verdict. Both write what the PolAds
 * review-uat skill writes for a person's verdict (its Step 10, and
 * references/linear-io.md). PASS: a comment naming them and the door,
 * Approved, and for a UAT fix its parent back to Agent UAT once none of its
 * fixes is open. FAIL: a UAT fix sub-issue with what they saw (Ready, bug,
 * the product, agent, the parent's priority), a comment naming it, Needs
 * Correction.
 *
 * The verdict comes from the person's own words (parseVerdict), never from
 * a model's reading of them: spec 9's fixed verbs.
 */

import { BARE } from "./answer.ts"
import type { AgentPaths } from "./config.ts"
import { appendLedger, type Logger } from "./log.ts"
import type { PeopleView } from "./monday/people.ts"
import { plainText, quote, say, stableUuid } from "./monday/render.ts"
import { truncateChars } from "./slack/text.ts"
import type { Tracker } from "./tracker.ts"

export type Verdict = { verdict: "pass" | "fail"; note: string }

/**
 * What may follow a verdict word: the end, a new line, or punctuation that
 * ends it (a dash with a space after it). Never a question mark or more
 * words: "pass me the link again?" and "fail to see why" are not verdicts.
 */
const ENDED = String.raw`(?=[ \t]*(?:$|\n|[:.,!]|[-–—](?:\s|$)))[\s:.,!\-–—]*`
const VERDICT = new RegExp(String.raw`^\s*(pass|fail)${ENDED}`, "i")
const LOOKS_RIGHT = new RegExp(String.raw`^\s*looks (?:good|right|fine)(?: to me)?${ENDED}`, "i")
/** A Look's change says what should change, after a colon. */
const CHANGE = /^\s*change\s*:\s*/i

/**
 * A verdict when their words are one: PASS or FAIL on its own, or followed by
 * punctuation and what they saw ("FAIL: the date is wrong"). On a Look also
 * "looks good", "looks right" or "looks fine" (pass), and "change:" with what
 * should change (fail). A plain yes on a Look agrees with its recommendation,
 * "Looks good".
 */
export function parseVerdict(text: string, look: boolean): Verdict | null {
  const m = VERDICT.exec(text)
  if (m) return { verdict: m[1].toLowerCase() === "pass" ? "pass" : "fail", note: text.slice(m[0].length).trim() }
  if (!look) return null
  const change = CHANGE.exec(text)
  if (change) return { verdict: "fail", note: text.slice(change[0].length).trim() }
  const right = LOOKS_RIGHT.exec(text)
  if (right) return { verdict: "pass", note: text.slice(right[0].length).trim() }
  return BARE.test(text) ? { verdict: "pass", note: "" } : null
}

export interface VerdictDeps {
  paths: AgentPaths
  tracker: Tracker
  people: Pick<PeopleView, "adoptFix" | "parentOf">
  product: string
  now: () => Date
  log?: Pick<Logger, "warn">
}

export interface VerdictInput {
  issue: string
  who: string
  verdict: Verdict
  /** A link to their words: the Slack message, or the Monday update. */
  where: string
  source: "slack" | "monday"
  /** Names the fix issue, so a retry files no second one: the Monday update id, or <channel>:<ts>. */
  key: string
}

export type VerdictOutcome = { outcome: "passed" } | { outcome: "failed"; fix: string } | { outcome: "not-waiting"; state: string }

/** A UAT fix's parent back for its review, once none of its fixes is open (review-uat's own rule). */
async function closeTheLoop(deps: VerdictDeps, fix: string, who: string, door: string): Promise<void> {
  const parent = await deps.people.parentOf(fix)
  if (!parent || parent.state !== "Needs Correction" || parent.openFixes.length) return
  await deps.tracker.comment(parent.id, `${fix} is fixed and approved (${who}, ${door}), so ${parent.id} goes back for its review against its full acceptance criteria.`)
  await deps.tracker.updateIssue(parent.id, { state: "Agent UAT" })
}

/** Records the verdict on an issue waiting to be tried, and nothing on one that is not. */
export async function recordVerdict(deps: VerdictDeps, v: VerdictInput): Promise<VerdictOutcome> {
  const current = await deps.tracker.readIssue(v.issue)
  if (current.state !== "Waiting for UAT") return { outcome: "not-waiting", state: current.state }
  const door = v.source === "slack" ? "in Slack" : "on the Monday board"
  const seen = v.verdict.note
  let out: VerdictOutcome
  if (v.verdict.verdict === "pass") {
    await deps.tracker.comment(v.issue, `UAT PASS from ${v.who} ${door} (${v.where})${seen ? `: ${seen}` : "."}`)
    await deps.tracker.updateIssue(v.issue, { state: "Approved" })
    if (current.title.startsWith("UAT fix:")) {
      try {
        await closeTheLoop(deps, current.id, v.who, door)
      } catch (error) {
        // The verdict is recorded: the loop closes by hand, or at the next review.
        deps.log?.warn(`${v.source} closing the loop failed after the words were recorded`, { issue: v.issue, error: String(error) })
      }
    }
    out = { outcome: "passed" }
  } else {
    // Named by their words, so a retry after a crash finds this issue rather than filing a second.
    const sub = await deps.tracker.createIssue({
      title: truncateChars(`UAT fix: ${plainText(current.title)}`, 80),
      description: [
        `${v.who} tried ${current.id} on test day, and it did not work. What they saw, as they wrote it ${door}:`,
        "",
        quote(seen || "(no details given)"),
        "",
        `Part of ${current.id}. ${v.source === "slack" ? "Slack" : "Monday"}: ${v.where}`,
        "",
        "## Acceptance criteria",
        "",
        `- [ ] What ${v.who} saw no longer happens, and ${current.id}'s own acceptance criteria hold.`,
      ].join("\n"),
      labels: ["bug", deps.product, "agent"],
      state: "Ready",
      clientId: stableUuid(`${v.source}-uat-fail:${v.key}`),
    })
    await deps.people.adoptFix(sub.uuid, current.uuid, current.priority)
    await deps.tracker.comment(v.issue, `UAT FAIL from ${v.who} ${door} (${v.where}). The fix is tracked in ${sub.id}.`)
    await deps.tracker.updateIssue(v.issue, { state: "Needs Correction" })
    out = { outcome: "failed", fix: sub.id }
  }
  appendLedger(deps.paths, { type: "uat.verdict", issue: v.issue, verdict: v.verdict.verdict, by: v.who, via: v.source }, deps.now())
  return out
}

/** What the person is told, in either door: the Monday board's own words. */
export function verdictReply(who: string, out: VerdictOutcome): string {
  if (out.outcome === "passed") return say.passed(who)
  if (out.outcome === "failed") return say.failed(who, out.fix)
  return say.notWaiting()
}
