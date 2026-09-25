import { describe, expect, it } from "vitest"
import type { Lesson } from "../lessons.ts"
import { baselineLine, firstPassTrend, METRICS, weekMetrics, worse, type LedgerLine } from "../metrics.ts"

const PR = (n: number) => `https://github.com/STEP-Network/v0-politiske-annoncer/pull/${n}`
const FROM = new Date("2026-09-18T12:00:00.000Z")
const TO = new Date("2026-09-25T12:00:00.000Z")

/** A week of Eve's, in the ledger's own shape, with one event on each side of the window. */
const LEDGER: LedgerLine[] = [
  { at: "2026-09-17T10:00:00.000Z", type: "pr.closed", url: PR(1690), state: "MERGED", rounds: 0, otherCommits: 0 },
  { at: "2026-09-19T09:00:00.000Z", type: "pr.opened", issue: "STEP-1", url: PR(1700) },
  { at: "2026-09-19T10:00:00.000Z", type: "pr.opened", issue: "STEP-2", url: PR(1701) },
  { at: "2026-09-20T10:00:00.000Z", type: "pr.opened", issue: "STEP-3", url: PR(1702) },
  { at: "2026-09-21T09:00:00.000Z", type: "pr.revise", issue: "STEP-1", url: PR(1700), round: 1 },
  { at: "2026-09-21T11:00:00.000Z", type: "pr.revise", issue: "STEP-1", url: PR(1700), round: 2 },
  { at: "2026-09-22T09:00:00.000Z", type: "pr.revise", issue: "STEP-2", url: PR(1701), round: 1 },
  // Merged: one after two rounds, one first time, one first time but a person pushed a fix, and one closed unmerged.
  { at: "2026-09-23T09:00:00.000Z", type: "pr.closed", url: PR(1700), state: "MERGED", rounds: 2, otherCommits: 0 },
  { at: "2026-09-23T10:00:00.000Z", type: "pr.closed", url: PR(1702), state: "MERGED", rounds: 0, otherCommits: 0 },
  { at: "2026-09-23T11:00:00.000Z", type: "pr.closed", url: PR(1703), state: "MERGED", rounds: 0, otherCommits: 1 },
  { at: "2026-09-23T12:00:00.000Z", type: "pr.closed", url: PR(1701), state: "CLOSED", rounds: 1, otherCommits: 0 },
  { at: "2026-09-19T09:30:00.000Z", type: "worker.end", issue: "STEP-1", status: "done", costUsd: 4, minutes: 40 },
  { at: "2026-09-19T10:30:00.000Z", type: "worker.end", issue: "STEP-2", status: "done", costUsd: 2, minutes: 20 },
  { at: "2026-09-21T09:30:00.000Z", type: "worker.end", issue: "STEP-1", status: "done", costUsd: 3, minutes: 30 },
  { at: "2026-09-22T09:30:00.000Z", type: "worker.end", issue: "STEP-4", status: "blocked", costUsd: 1, minutes: 10 },
  { at: "2026-09-22T12:00:00.000Z", type: "instruction.received", issue: "STEP-1" },
  { at: "2026-09-22T13:00:00.000Z", type: "answer.applied", issue: "STEP-4" },
  { at: "2026-09-26T09:00:00.000Z", type: "worker.end", issue: "STEP-9", status: "blocked", costUsd: 9, minutes: 90 },
]

const lesson = (at: string, category: Lesson["category"], pr: string | null): Lesson => ({ at, mini: "eve", issue: "STEP-1", pr, category, source: "github", text: "x", key: `${category}:${at}:${pr}` })
const LESSONS: Lesson[] = [
  lesson("2026-09-21T08:00:00.000Z", "fix", PR(1700)),
  lesson("2026-09-21T08:01:00.000Z", "fix", PR(1700)),
  lesson("2026-09-22T08:00:00.000Z", "fix", PR(1701)),
  lesson("2026-09-22T08:30:00.000Z", "review", PR(1703)),
  lesson("2026-09-10T08:00:00.000Z", "fix", PR(1680)),
]

describe("the week's numbers (STEP-3290)", () => {
  it("counts first-pass merges, PRs with a must-fix finding, rounds, blocks, interventions, and cost and minutes per issue", () => {
    const m = weekMetrics(LEDGER, LESSONS, FROM, TO)
    expect(m).toMatchObject({
      prsMerged: 3,
      // PR 1700 needed two rounds and 1703 a person's commit: only 1702 went in the first time.
      firstPass: 1,
      // 1700, 1701, 1702, and 1703 from its closing and its review.
      prsSeen: 4,
      prsWithFix: 2,
      reviseRounds: 3,
      blockedJobs: 1,
      interventions: 2,
      issues: 3,
      costUsd: 10,
      minutes: 100,
    })
    expect(METRICS.firstPassRate.show(m)).toBe("1 of 3 (33 percent)")
    expect(METRICS.fixRate.show(m)).toBe("2 of 4 (50 percent)")
    expect(METRICS.roundsPerPr.show(m)).toBe("0.8")
    expect(METRICS.costPerIssue.show(m)).toBe("USD 3.33")
    expect(METRICS.minutesPerIssue.show(m)).toBe("33")
  })

  it("says none, and has no rate, for a week with nothing in it", () => {
    const m = weekMetrics([], [], FROM, TO)
    expect(METRICS.firstPassRate.value(m)).toBeNull()
    expect(METRICS.firstPassRate.show(m)).toBe("none")
    expect(METRICS.costPerIssue.show(m)).toBe("n/a")
  })

  it("knows which way is better for each number, and never calls a missing one worse", () => {
    expect(worse("firstPassRate", 0.5, 0.4)).toBe(true)
    expect(worse("firstPassRate", 0.4, 0.5)).toBe(false)
    expect(worse("fixRate", 0.2, 0.5)).toBe(true)
    expect(worse("fixRate", 0.5, 0.5)).toBe(false)
    expect(worse("blockedJobs", null, 3)).toBe(false)
    expect(worse("blockedJobs", 1, null)).toBe(false)
  })

  it("carries the baseline, and the first-pass trend week by week", () => {
    expect(baselineLine()).toBe("1 of 9 (11 percent) on 2026-09-25: 8 of Eve's first 9 PRs needed a second pass")
    expect(firstPassTrend(LEDGER, LESSONS, TO, 2)).toBe("week to 2026-09-18: 1 of 1, week to 2026-09-25: 1 of 3")
  })
})
