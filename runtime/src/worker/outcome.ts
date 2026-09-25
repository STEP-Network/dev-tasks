/**
 * Every way an SDK session can end, mapped onto four outcomes (spec 6.3):
 *   done         a valid report, status done, with a PR title
 *   needs_input  a valid report with a question for a product owner
 *   limited      the subscription limit ended it: nobody is pinged, it resumes later
 *   blocked      everything else, with a reason a person can read
 * A blocked outcome whose only fault is the report's form says so
 * (reportProblem): the runner asks the same session for the report once, and
 * with commits ahead titles the PR from them rather than strand the work.
 */

import { USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk"

export interface WorkerReport {
  status: "done" | "needs_input" | "blocked"
  summary: string
  prTitle?: string
  verification?: string[]
  question?: string
  notes?: string
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
  /** Set when the session ended well but its report was malformed: prTitle missing from a done report, or no valid report at all. */
  reportProblem?: "prTitle" | "report"
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
  return {
    status: v.status,
    summary: v.summary.trim(),
    prTitle: text(v.prTitle),
    verification: Array.isArray(v.verification) ? v.verification.filter((s): s is string => typeof s === "string") : [],
    question: text(v.question),
    notes: text(v.notes),
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
      const report = parseReport(result.structured_output)
      if (!report) return { ...blocked("the worker ended without a valid report"), reportProblem: "report" }
      if (report.status === "done") {
        return report.prTitle || ctx.requireTitle === false
          ? { status: "done", reason: "done", report, ...base }
          : { ...blocked("the report has no PR title", report), reportProblem: "prTitle" }
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
