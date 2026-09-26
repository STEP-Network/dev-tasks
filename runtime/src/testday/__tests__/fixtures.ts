/** Test day's shared test data: a run in the shape the controller keeps, made-up ids only. */
import type { TestDayRun } from "../types.ts"

export const T0 = new Date("2026-10-02T08:00:00.000Z")

export function run(over: Partial<TestDayRun> = {}): TestDayRun {
  return {
    id: "2026-10-02", key: "testday-2026-10-02", phase: "testing", startedBy: "Ada", startedAt: T0.toISOString(), itemId: "4000",
    cut: { requestId: "testday-2026-10-02", dispatchedAt: null, runUrl: null, prUrl: null, done: null, problem: null, replace: false, sha: null },
    deployedAt: null, guide: null, docId: null, checkpoints: [], holds: {}, release: null, sessions: {}, problem: null, lastVerdictReadAt: null,
    ...over,
  }
}

/** Checkpoint 4, for STEP-7: it failed, and asks fix before release or next week. */
export const FAILED_WAITING = {
  n: 4, issue: "STEP-7", title: "Pay", role: "Advertiser" as const, kind: "try" as const, subitemId: "701", status: "fail" as const, verdict: null,
  decision: { askedAt: T0.toISOString(), itemId: "4100", answer: null, by: null }, fix: null, prNumbers: [101],
}
