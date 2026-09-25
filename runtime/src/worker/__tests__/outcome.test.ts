import { describe, expect, it } from "vitest"
import { SWEEP } from "../../__tests__/fakes.ts"
import { checklistGaps, parseReport, toOutcome, type ResultMessageLike, type WorkerReport } from "../outcome.ts"

const limits = { maxTurns: 250, maxBudgetUsd: 15, wallClockMinutes: 90 }
const ctx = { abortedByClock: false, thrown: null, limits }
const result = (over: Partial<ResultMessageLike>): ResultMessageLike => ({
  type: "result", subtype: "success", total_cost_usd: 3.1, num_turns: 42, session_id: "s-1", ...over,
})
const report = { status: "done", prTitle: "fix: the notice date", summary: "Uses the publication date.", verification: ["pnpm typecheck: pass"], checklist: SWEEP }

describe("toOutcome", () => {
  it("is done with the report, the cost and the turns", () => {
    expect(toOutcome(result({ structured_output: report }), ctx)).toMatchObject({
      status: "done", report: { prTitle: "fix: the notice date" }, costUsd: 3.1, turns: 42, sessionId: "s-1",
    })
  })

  it("is needs_input only with a question, and blocked otherwise", () => {
    expect(toOutcome(result({ structured_output: { status: "needs_input", summary: "Two readings.", question: "Which date?" } }), ctx).status).toBe("needs_input")
    expect(toOutcome(result({ structured_output: { status: "needs_input", summary: "Two readings." } }), ctx)).toMatchObject({ status: "blocked", reason: "needs input but asked no question" })
  })

  it("is blocked when done has no PR title, or the report is missing or malformed", () => {
    expect(toOutcome(result({ structured_output: { ...report, prTitle: undefined } }), ctx).reason).toBe("the report has no PR title")
    expect(toOutcome(result({ structured_output: undefined }), ctx).reason).toBe("the worker ended without a valid report")
    expect(toOutcome(result({ structured_output: { status: "finished", summary: "x" } }), ctx).status).toBe("blocked")
  })

  it("marks a block whose only fault is the report's form, and no other", () => {
    // The runner asks the same session once more for these, and with commits ahead titles the PR from them (STEP-3270).
    expect(toOutcome(result({ structured_output: { ...report, prTitle: undefined } }), ctx).reportProblem).toBe("prTitle")
    expect(toOutcome(result({ structured_output: { ...report, prTitle: "  " } }), ctx).reportProblem).toBe("prTitle")
    expect(toOutcome(result({ structured_output: undefined }), ctx).reportProblem).toBe("report")
    expect(toOutcome(result({ structured_output: { status: "done" } }), ctx).reportProblem).toBe("report")
    expect(toOutcome(result({ subtype: "error_max_structured_output_retries" }), ctx).reportProblem).toBe("report")
    for (const other of [
      toOutcome(result({ structured_output: report }), ctx),
      toOutcome(result({ structured_output: { status: "blocked", summary: "The migration needs a person." } }), ctx),
      toOutcome(result({ structured_output: { status: "needs_input", summary: "Two readings." } }), ctx),
      toOutcome(result({ subtype: "error_max_turns" }), ctx),
      toOutcome(result({ structured_output: report }), { ...ctx, abortedByClock: true }),
      toOutcome(null, { ...ctx, thrown: "Claude Code process exited with code 1" }),
    ]) {
      expect(other.reportProblem, other.reason).toBeUndefined()
    }
  })

  it("is blocked with the worker's own first line when it reports blocked, without its full stop", () => {
    expect(toOutcome(result({ structured_output: { status: "blocked", summary: "pnpm install fails offline.\nThe lockfile names a package the store lacks." } }), ctx)).toMatchObject({
      status: "blocked", reason: "pnpm install fails offline", report: { status: "blocked" },
    })
    expect(toOutcome(result({ structured_output: { status: "blocked", summary: "...\nsee below" } }), ctx).reason).toBe("the worker reported blocked")
  })

  it("names each limit that stopped the session", () => {
    expect(toOutcome(result({ subtype: "error_max_turns" }), ctx).reason).toBe("the turn limit of 250")
    expect(toOutcome(result({ subtype: "error_max_budget_usd" }), ctx).reason).toBe("the budget of USD 15")
    expect(toOutcome(result({ subtype: "error_max_structured_output_retries" }), ctx).reason).toBe("no valid final report")
    expect(toOutcome(null, { ...ctx, abortedByClock: true }).reason).toBe("the wall-clock limit of 90 minutes")
  })

  it("is blocked by the wall clock even when a result arrived after the abort", () => {
    expect(toOutcome(result({ structured_output: report }), { ...ctx, abortedByClock: true })).toMatchObject({ status: "blocked", reason: "the wall-clock limit of 90 minutes" })
  })

  it("is limited, not blocked, when the subscription limit ended it", () => {
    expect(toOutcome(result({ subtype: "error_during_execution", errors: ["Claude usage limit reached"] }), ctx).status).toBe("limited")
    expect(toOutcome(result({ subtype: "error_during_execution", api_error_status: 429, errors: [] }), ctx).status).toBe("limited")
    expect(toOutcome(null, { ...ctx, thrown: "rate_limit_error: 429" }).status).toBe("limited")
  })

  it("reads a limit the way the SDK reports it: an API error on a success result, in the CLI's own words", () => {
    const hit = result({ is_error: true, api_error_status: 429, result: "You've hit your limit · resets 5pm (Europe/Copenhagen)" })
    expect(toOutcome(hit, ctx)).toMatchObject({ status: "limited", reason: "the subscription usage limit" })
    expect(toOutcome(result({ is_error: true, result: "You've hit your limit · resets 5pm" }), ctx).status).toBe("limited")
    expect(toOutcome(result({ subtype: "error_during_execution", errors: ["You've reached your weekly limit"] }), ctx).status).toBe("limited")
  })

  it("is blocked with the text of any other API error", () => {
    expect(toOutcome(result({ is_error: true, api_error_status: 500, result: "API Error: 500 Internal server error" }), ctx)).toMatchObject({
      status: "blocked", reason: "an API error: API Error: 500 Internal server error",
    })
  })

  it("is blocked with the message when the process failed or threw", () => {
    expect(toOutcome(null, { ...ctx, thrown: "spawn claude ENOENT" })).toMatchObject({ status: "blocked", reason: "the worker process failed: spawn claude ENOENT" })
    expect(toOutcome(null, ctx)).toMatchObject({ status: "blocked", reason: "the worker process failed: no result message" })
    expect(toOutcome(result({ subtype: "error_during_execution", errors: ["tool crashed"] }), ctx).reason).toBe("an error during execution: tool crashed")
    // The reason reaches Slack: no semicolons.
    expect(toOutcome(result({ subtype: "error_during_execution", errors: ["tool crashed", "the hook failed"] }), ctx).reason).toBe("an error during execution: tool crashed. the hook failed")
  })
})

describe("the self-check a done report carries (STEP-3284)", () => {
  const done = (checklist: WorkerReport["checklist"]): WorkerReport => ({ status: "done", summary: "x", checklist })

  it("names every checklist answer that is missing, and each search answer without its command", () => {
    expect(checklistGaps(done(SWEEP))).toEqual([])
    expect(checklistGaps(done(undefined))).toEqual(["siblings", "publicOutputs", "caches", "coupled", "docs", "translations"])
    expect(checklistGaps(done({ ...SWEEP, caches: "  ", translations: undefined }))).toEqual(["caches", "translations"])
    // A search is shown by its command, not claimed: "grepped" or "none" is not a search.
    expect(checklistGaps(done({ ...SWEEP, siblings: "none: I grepped and found nothing", docs: "none" }))).toEqual(["siblings (no search command)", "docs (no search command)"])
    for (const command of ["git grep -n limiter", "`rg -n limiter app`: none", "grep -rn limiter lib"]) {
      expect(checklistGaps(done({ ...SWEEP, siblings: command })), command).toEqual([])
    }
  })

  it("takes a reason instead of a search command for a small change, unless the answer says it searched (Eve, PR #1704)", () => {
    const small = (checklist: WorkerReport["checklist"]): WorkerReport => ({ ...done(checklist), small: true })
    // A revise round that only answered the review: there was nothing to search.
    const answered = { ...SWEEP, siblings: "none: this round only answers the reviewer, no code changed", docs: "none: no doc describes the notice date" }
    expect(checklistGaps(small(answered))).toEqual([])
    // An answer that says it searched shows the command, small or not.
    expect(checklistGaps(small({ ...SWEEP, siblings: "searched the routes, nothing else", docs: "checked the docs" }))).toEqual(["siblings (no search command)", "docs (no search command)"])
    // A bare "none" gives no reason.
    expect(checklistGaps(small({ ...SWEEP, docs: "none" }))).toEqual(["docs (no search command)"])
    // A larger change still shows its commands.
    expect(checklistGaps(done(answered))).toEqual(["siblings (no search command)", "docs (no search command)"])
    // The runner says the change is small. A worker's own claim to it is dropped.
    expect(toOutcome(result({ structured_output: { ...report, checklist: answered } }), { ...ctx, small: true })).toMatchObject({ status: "done", report: { small: true } })
    expect(toOutcome(result({ structured_output: { ...report, small: true, checklist: answered } }), ctx)).toMatchObject({ status: "blocked", reportProblem: "checklist" })
  })

  it("blocks a done report with an incomplete checklist, as a problem of its form, for develop and revise alike", () => {
    const partial = { ...report, checklist: { ...SWEEP, caches: undefined, docs: "none" } }
    for (const requireTitle of [true, false]) {
      expect(toOutcome(result({ structured_output: partial }), { ...ctx, requireTitle })).toMatchObject({
        status: "blocked",
        reason: "the report's self-check is incomplete: caches, docs (no search command)",
        reportProblem: "checklist",
        report: { prTitle: "fix: the notice date" },
      })
    }
    // A missing title is the first problem, and asks for the whole report again anyway.
    expect(toOutcome(result({ structured_output: { ...partial, prTitle: undefined } }), ctx).reportProblem).toBe("prTitle")
    // Neither blocked nor needs_input reports carry the sweep.
    expect(toOutcome(result({ structured_output: { status: "blocked", summary: "No." } }), ctx).reportProblem).toBeUndefined()
  })

  it("keeps the checklist keys and whole mutation checks, and drops the rest", () => {
    const parsed = parseReport({
      status: "done", summary: "x",
      checklist: { ...SWEEP, caches: "  none: no cache  ", extra: "dropped", docs: 3 },
      mutations: [{ test: "a.test.ts", mutation: "m", result: "failed" }, { test: "b.test.ts", mutation: "m" }, "no"],
    })
    expect(parsed?.checklist).toEqual({ ...Object.fromEntries(Object.entries(SWEEP).filter(([k]) => k !== "docs")), caches: "none: no cache" })
    expect(parsed?.mutations).toEqual([{ test: "a.test.ts", mutation: "m", result: "failed" }])
  })
})

describe("parseReport", () => {
  it("keeps the strings it knows, trims them, and drops anything else", () => {
    expect(parseReport({ status: "done", summary: "  x  ", prTitle: " fix: y ", verification: ["a", 3], extra: true })).toEqual({
      status: "done", summary: "x", prTitle: "fix: y", verification: ["a"], question: undefined, notes: undefined, mutations: [],
    })
    expect(parseReport({ status: "done", summary: "   " })).toBeNull()
  })
})
