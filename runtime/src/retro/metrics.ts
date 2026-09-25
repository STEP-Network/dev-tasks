/**
 * The week's numbers the retro judges itself by (STEP-3290), from the ledger
 * and the lessons. `agentctl report` shows them too, with the trend.
 *
 *   first-pass merges   merged PRs that needed no revise round and no one
 *                       else's commit, of all merged PRs
 *   FIX rate            PRs that drew a must-fix finding, of the PRs seen
 *   revise rounds       per PR seen
 *   blocked jobs        jobs that ended blocked
 *   human interventions a person's instruction or answer in Slack
 *   cost, minutes       per issue a job ran for
 *
 * The baseline, 2026-09-25: 8 of Eve's first 9 PRs needed a second pass.
 */

import type { Lesson } from "./lessons.ts"

export type LedgerLine = { at: string; type: string } & Record<string, unknown>

export interface WeekMetrics {
  from: string
  to: string
  prsMerged: number
  firstPass: number
  prsSeen: number
  prsWithFix: number
  reviseRounds: number
  blockedJobs: number
  interventions: number
  issues: number
  costUsd: number
  minutes: number
}

export const BASELINE = { date: "2026-09-25", firstPass: 1, merged: 9 } as const

const inWindow = (at: unknown, from: Date, to: Date) => typeof at === "string" && Date.parse(at) >= from.getTime() && Date.parse(at) < to.getTime()
const str = (v: unknown) => (typeof v === "string" ? v : null)

export function weekMetrics(events: LedgerLine[], lessons: Lesson[], from: Date, to: Date): WeekMetrics {
  const recent = events.filter((e) => inWindow(e.at, from, to))
  const of = (type: string) => recent.filter((e) => e.type === type)
  const merged = of("pr.closed").filter((e) => e.state === "MERGED")
  const firstPass = merged.filter((e) => Number(e.rounds ?? 0) === 0 && Number(e.otherCommits ?? 0) === 0)
  const week = lessons.filter((l) => inWindow(l.at, from, to))
  const seen = new Set<string>()
  for (const e of [...of("pr.opened"), ...of("pr.revise"), ...of("pr.closed")]) {
    const url = str(e.url)
    if (url) seen.add(url)
  }
  for (const l of week) if (l.pr) seen.add(l.pr)
  const withFix = new Set(week.filter((l) => l.category === "fix" && l.pr).map((l) => l.pr as string))
  const ends = of("worker.end")
  const issues = new Set(ends.map((e) => str(e.issue)).filter((i): i is string => Boolean(i)))
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    prsMerged: merged.length,
    firstPass: firstPass.length,
    prsSeen: seen.size,
    prsWithFix: withFix.size,
    reviseRounds: of("pr.revise").length,
    blockedJobs: ends.filter((e) => e.status === "blocked").length,
    interventions: of("instruction.received").length + of("answer.applied").length,
    issues: issues.size,
    costUsd: ends.reduce((sum, e) => sum + (typeof e.costUsd === "number" ? e.costUsd : 0), 0),
    minutes: ends.reduce((sum, e) => sum + (typeof e.minutes === "number" ? e.minutes : 0), 0),
  }
}

export const METRIC_KEYS = ["firstPassRate", "fixRate", "roundsPerPr", "blockedJobs", "interventions", "costPerIssue", "minutesPerIssue"] as const
export type MetricKey = (typeof METRIC_KEYS)[number]

interface MetricDef {
  label: string
  /** Which way is better. */
  better: "higher" | "lower"
  value(m: WeekMetrics): number | null
  show(m: WeekMetrics): string
}

const ratio = (a: number, b: number) => (b ? a / b : null)
const percent = (a: number, b: number) => (b ? `${a} of ${b} (${Math.round((a / b) * 100)} percent)` : "none")
const one = (v: number | null, unit = "") => (v === null ? "n/a" : `${unit}${Math.round(v * 10) / 10}`)

export const METRICS: Record<MetricKey, MetricDef> = {
  firstPassRate: {
    label: "First-pass merges",
    better: "higher",
    value: (m) => ratio(m.firstPass, m.prsMerged),
    show: (m) => percent(m.firstPass, m.prsMerged),
  },
  fixRate: {
    label: "PRs with a must-fix finding",
    better: "lower",
    value: (m) => ratio(m.prsWithFix, m.prsSeen),
    show: (m) => percent(m.prsWithFix, m.prsSeen),
  },
  roundsPerPr: {
    label: "Revise rounds per PR",
    better: "lower",
    value: (m) => ratio(m.reviseRounds, m.prsSeen),
    show: (m) => one(ratio(m.reviseRounds, m.prsSeen)),
  },
  blockedJobs: { label: "Blocked jobs", better: "lower", value: (m) => m.blockedJobs, show: (m) => String(m.blockedJobs) },
  interventions: { label: "Human interventions", better: "lower", value: (m) => m.interventions, show: (m) => String(m.interventions) },
  costPerIssue: {
    label: "Cost per issue",
    better: "lower",
    value: (m) => ratio(m.costUsd, m.issues),
    show: (m) => (m.issues ? `USD ${(m.costUsd / m.issues).toFixed(2)}` : "n/a"),
  },
  minutesPerIssue: {
    label: "Minutes per issue",
    better: "lower",
    value: (m) => ratio(m.minutes, m.issues),
    show: (m) => (m.issues ? String(Math.round(m.minutes / m.issues)) : "n/a"),
  },
}

/** Whether `now` is worse than `before` on a metric. No number on either side is not worse. */
export function worse(key: MetricKey, before: number | null, now: number | null): boolean {
  if (before === null || now === null) return false
  return METRICS[key].better === "higher" ? now < before : now > before
}

/** The baseline, as the report and the retro show it. */
export function baselineLine(): string {
  return `${BASELINE.firstPass} of ${BASELINE.merged} (${Math.round((BASELINE.firstPass / BASELINE.merged) * 100)} percent) on ${BASELINE.date}: 8 of Eve's first 9 PRs needed a second pass`
}

/** The first-pass merges of each of the last `weeks` weeks up to `to`, oldest first. */
export function firstPassTrend(events: LedgerLine[], lessons: Lesson[], to: Date, weeks = 4): string {
  const DAY = 86_400_000
  const parts: string[] = []
  for (let w = weeks - 1; w >= 0; w--) {
    const end = new Date(to.getTime() - w * 7 * DAY)
    const m = weekMetrics(events, lessons, new Date(end.getTime() - 7 * DAY), end)
    parts.push(`week to ${end.toISOString().slice(0, 10)}: ${m.prsMerged ? `${m.firstPass} of ${m.prsMerged}` : "none merged"}`)
  }
  return parts.join(", ")
}
