/**
 * Every way an SDK session can end, mapped onto four outcomes (spec 6.3):
 *   done         a valid report, status done, with a PR title
 *   needs_input  a valid report with a question for a product owner
 *   limited      the subscription limit ended it: nobody is pinged, it resumes later
 *   blocked      everything else, with a reason a person can read
 * A blocked outcome whose only fault is the report's form says so
 * (reportProblem): the runner asks the same session for the report once, and
 * with commits ahead titles the PR from them rather than strand the work.
 * A done report's self-check (STEP-3284) is part of its form: the one-hop
 * sweep's checklist, and a mutation check for each new guard test. Its gaps
 * never strand work: after the one correction, the work goes out with them
 * named on the PR, a revise round's included.
 */

import { USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk"

/**
 * The one-hop sweep a done report answers (STEP-3284), in the order the PR
 * shows it. Reviews of Eve's first nine PRs found each of these missed.
 */
export const CHECKLIST = [
  { key: "siblings", label: "Sibling call sites", search: true },
  { key: "publicOutputs", label: "Public outputs and exports", search: false },
  { key: "caches", label: "Caches and version keys", search: false },
  { key: "coupled", label: "Crons, reminders and emails", search: false },
  { key: "docs", label: "Docs and comments", search: true },
  { key: "translations", label: "Translations", search: false },
] as const

export type ChecklistKey = (typeof CHECKLIST)[number]["key"]

/** One deliberate mutation of an invariant a new guard test covers: what was changed, and how the test failed on it. */
export interface MutationCheck {
  test: string
  mutation: string
  result: string
}

export interface WorkerReport {
  status: "done" | "needs_input" | "blocked"
  summary: string
  prTitle?: string
  verification?: string[]
  question?: string
  /** With a question: the answer the worker recommends, which a reply of "yes" agrees to (STEP-3293). */
  recommendation?: string
  notes?: string
  checklist?: Partial<Record<ChecklistKey, string>>
  mutations?: MutationCheck[]
  /**
   * Set by the runner, never by the worker: the job's own change is small
   * (SMALL_CHANGE_FILES code files at most, none for a revise round that
   * only answers), so a search answer may give a reason instead of a command.
   */
  small?: boolean
}

/** A change this small, in code files (tests aside), needs no search command in its sweep: a reason will do. */
export const SMALL_CHANGE_FILES = 3

/** A search, as the sweep's answers must show it: the command, not a claim. */
const SEARCH_RE = /(^|[\s`'"(])(rg|grep|git grep|ag|ack)\s/
/** An answer that says a search was done: then it must show the command. */
const CLAIMS_SEARCH_RE = /\b(search(ed|ing)?|grepp?ed|looked|scanned|swept|checked|found)\b/i
/** "none" with no reason. */
const BARE_RE = /^(none|n\/a|nothing|no)[\s.:]*$/i

/**
 * What a report's checklist lacks: each missing answer, and each search
 * answer that names no search command. A search answer may give a reason
 * instead ("none: only the copy changed") when the change is small, unless
 * it says a search was done: that one shows the command.
 */
export function checklistGaps(report: WorkerReport): string[] {
  const gaps: string[] = []
  for (const item of CHECKLIST) {
    const answer = report.checklist?.[item.key]?.trim()
    if (!answer) gaps.push(item.key)
    else if (item.search && !SEARCH_RE.test(answer) && (CLAIMS_SEARCH_RE.test(answer) || BARE_RE.test(answer) || !report.small)) gaps.push(`${item.key} (no search command)`)
  }
  return gaps
}

/** The fields of the SDK's result message this module reads. */
export interface ResultMessageLike {
  type: "result"
  subtype: string
  structured_output?: unknown
  errors?: string[]
  /** true on a "success" whose turn ended on an API error. Its text is then in `result`. */
  is_error?: boolean
  result?: string
  total_cost_usd?: number
  num_turns?: number
  session_id?: string
  api_error_status?: number | null
}

export interface Outcome {
  status: "done" | "needs_input" | "blocked" | "limited"
  reason: string
  report: WorkerReport | null
  costUsd: number | null
  turns: number | null
  sessionId: string | null
  /**
   * Set when the session ended well but its report was malformed: prTitle
   * missing from a done report, no valid report at all, the sweep's checklist
   * incomplete, or no mutation check for a branch that changes tests.
   */
  reportProblem?: "prTitle" | "report" | "checklist" | "mutations"
}

const LIMIT_RE = /usage limit|rate.?limit|\b429\b|limit reached/i

/** A sentence without its closing punctuation, so the caller can end it: "blocked: <reason>." never reads "..". */
export function clause(text: string): string {
  return text.trim().replace(/[\s.!?:;,]+$/, "")
}

/** The SDK's own list of the CLI's "a usage limit was reached" messages ("You've hit your limit · resets 5pm"), and a rate limit. */
function isLimit(text: string, status?: number | null): boolean {
  return status === 429 || LIMIT_RE.test(text) || USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.includes(prefix))
}

export function parseReport(value: unknown): WorkerReport | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (v.status !== "done" && v.status !== "needs_input" && v.status !== "blocked") return null
  if (typeof v.summary !== "string" || !v.summary.trim()) return null
  const text = (x: unknown) => (typeof x === "string" ? x.trim() : undefined)
  const given = v.checklist && typeof v.checklist === "object" ? (v.checklist as Record<string, unknown>) : null
  const checklist = given ? Object.fromEntries(CHECKLIST.flatMap((item) => (text(given[item.key]) ? [[item.key, text(given[item.key])!]] : []))) : undefined
  const mutations = Array.isArray(v.mutations)
    ? v.mutations.flatMap((m): MutationCheck[] => {
        const e = m && typeof m === "object" ? (m as Record<string, unknown>) : {}
        const [test, mutation, result] = [text(e.test), text(e.mutation), text(e.result)]
        return test && mutation && result ? [{ test, mutation, result }] : []
      })
    : []
  return {
    status: v.status,
    summary: v.summary.trim(),
    prTitle: text(v.prTitle),
    verification: Array.isArray(v.verification) ? v.verification.filter((s): s is string => typeof s === "string") : [],
    question: text(v.question),
    recommendation: text(v.recommendation),
    notes: text(v.notes),
    ...(checklist ? { checklist } : {}),
    mutations,
  }
}

export function toOutcome(
  result: ResultMessageLike | null,
  ctx: {
    abortedByClock: boolean
    thrown: string | null
    limits: { maxTurns: number; maxBudgetUsd: number; wallClockMinutes: number }
    /** false for a revise job: its PR has a title already. */
    requireTitle?: boolean
    /** The job's own change is small: see WorkerReport.small. */
    small?: boolean
  },
): Outcome {
  const base = { costUsd: result?.total_cost_usd ?? null, turns: result?.num_turns ?? null, sessionId: result?.session_id ?? null }
  const blocked = (reason: string, report: WorkerReport | null = null): Outcome => ({ status: "blocked", reason, report, ...base })
  const limited: Outcome = { status: "limited", reason: "the subscription usage limit", report: null, ...base }

  if (ctx.abortedByClock) return blocked(`the wall-clock limit of ${ctx.limits.wallClockMinutes} minutes`)
  if (!result) {
    const thrown = ctx.thrown ?? "no result message"
    return isLimit(thrown) ? limited : blocked(`the worker process failed: ${thrown}`)
  }
  switch (result.subtype) {
    case "error_max_turns":
      return blocked(`the turn limit of ${ctx.limits.maxTurns}`)
    case "error_max_budget_usd":
      return blocked(`the budget of USD ${ctx.limits.maxBudgetUsd}`)
    case "error_max_structured_output_retries":
      return { ...blocked("no valid final report"), reportProblem: "report" }
    case "error_during_execution": {
      // The reason reaches Slack, where the copy rules allow no semicolons.
      const text = (result.errors ?? []).join(". ")
      if (isLimit(text, result.api_error_status)) return limited
      return blocked(`an error during execution: ${text || "unknown"}`)
    }
    case "success": {
      // The SDK reports a turn that ended on an API error, a usage limit
      // included, as a success with is_error set and the error as its text.
      if (result.is_error) {
        const text = (result.result ?? "").trim()
        return isLimit(text, result.api_error_status) ? limited : blocked(`an API error: ${text || "unknown"}`)
      }
      const parsed = parseReport(result.structured_output)
      if (!parsed) return { ...blocked("the worker ended without a valid report"), reportProblem: "report" }
      const report: WorkerReport = ctx.small ? { ...parsed, small: true } : parsed
      if (report.status === "done") {
        if (!report.prTitle && ctx.requireTitle !== false) return { ...blocked("the report has no PR title", report), reportProblem: "prTitle" }
        const gaps = checklistGaps(report)
        if (gaps.length) return { ...blocked(`the report's self-check is incomplete: ${gaps.join(", ")}`, report), reportProblem: "checklist" }
        return { status: "done", reason: "done", report, ...base }
      }
      if (report.status === "needs_input") {
        return report.question
          ? { status: "needs_input", reason: "a question for a product owner", report, ...base }
          : blocked("needs input but asked no question", report)
      }
      return blocked(clause(report.summary.split("\n")[0]) || "the worker reported blocked", report)
    }
    default:
      return blocked(`an unknown result subtype ${result.subtype}`)
  }
}
