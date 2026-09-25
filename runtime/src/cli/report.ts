/** The two human-readable outputs of agentctl: status now, and the ledger over a period. */

import type { UsageSnapshot } from "../usage.ts"

export interface StatusInput {
  mini: string
  /** null when not paused; the reason otherwise ("" when none was given). */
  paused: string | null
  /** state/agentd.json, which agentd writes after every loop, with `error` when it could not start. */
  agentd: { pid: number; at: string; error?: string; frontDoorRefused?: string } | null
  frontDoor: { alive: boolean; lastWakeAt: Date | null; startsLastHour: number; waitUntil: string | null }
  worker: { issue: string; minutes: number; pid: number | null } | null
  pending: string[]
  /** Issues whose last two workers were lost early (heldBackIssues). */
  heldBack: string[]
  bridge: { at: string; connected: boolean; outboxWaiting: number; outboxFailed: number; error?: string; stopped?: boolean } | null
  usage: UsageSnapshot | null
  linear: { ok: true; email: string } | { ok: false; error: string }
  now: Date
}

/** agentd writes its heartbeat every 15 seconds. */
const AGENTD_STALE_MS = 2 * 60_000
/** The bridge writes its heartbeat every 30 seconds; agentd's health check allows the same. */
const BRIDGE_STALE_MS = 3 * 60_000

const minutes = (now: Date, then: Date) => Math.round((now.getTime() - then.getTime()) / 60_000)
const minutesAgo = (now: Date, then: Date) => `${minutes(now, then)} min ago`
const pct = (value: number | null) => (value === null ? "?" : `${Math.round(value)} percent`)

function agentdLine(s: StatusInput): string {
  const a = s.agentd
  if (!a) return "NEVER STARTED (no ~/.agentd/state/agentd.json)"
  // It exits when it cannot start (a config problem), with the reason here, and launchd leaves it down.
  if (a.error) return `NOT RUNNING: ${a.error}`
  const at = new Date(a.at)
  if (s.now.getTime() - at.getTime() > AGENTD_STALE_MS) return `NO HEARTBEAT for ${minutes(s.now, at)} min (pid ${a.pid})`
  return `running, pid ${a.pid}`
}

function bridgeLine(s: StatusInput): string {
  const b = s.bridge
  if (!b) return "NO HEARTBEAT (never written)"
  // The bridge writes its heartbeat every 30 seconds, error or not. A fresh one
  // with an error is Slack refusing the app: the outbox is paused and the bridge
  // runs. A stale one, or one its halt marked stopped, is a bridge that is gone.
  const at = new Date(b.at)
  const fresh = s.now.getTime() - at.getTime() <= BRIDGE_STALE_MS
  if (b.stopped || (!fresh && b.error)) return `STOPPED: ${b.error ?? "no reason recorded"}`
  if (!fresh) return `NO HEARTBEAT for ${minutes(s.now, at)} min`
  const paused = b.error ? `, OUTBOX PAUSED: ${b.error}` : ""
  return `${b.connected ? "connected" : "DISCONNECTED"}${paused}, heartbeat ${minutesAgo(s.now, at)}, outbox ${b.outboxWaiting} waiting, ${b.outboxFailed} failed`
}

export function statusReport(s: StatusInput): string {
  const fd = s.frontDoor
  return [
    `${s.mini}${s.paused !== null ? ` PAUSED (${s.paused || "no reason given"}). agentctl resume lifts it` : ""}`,
    `agentd: ${agentdLine(s)}`,
    `front door: ${fd.alive ? "running" : "NOT RUNNING"}, last wakeup ${fd.lastWakeAt ? minutesAgo(s.now, fd.lastWakeAt) : "never"}, ${fd.startsLastHour} start(s) in the last hour${fd.waitUntil ? `, waiting until ${fd.waitUntil}` : ""}${s.agentd?.frontDoorRefused ? `, NOT STARTED: ${s.agentd.frontDoorRefused}` : ""}`,
    `worker: ${s.worker ? `${s.worker.issue}, ${s.worker.minutes} min${s.worker.pid ? `, pid ${s.worker.pid}` : ""}` : "idle"}${s.pending.length ? `, queued: ${s.pending.join(", ")}` : ""}`,
    ...(s.heldBack.length
      ? [`held back: ${s.heldBack.join(", ")}. Its last two workers were lost early. agentctl job submit --issue <id> runs one by hand`]
      : []),
    `bridge: ${bridgeLine(s)}`,
    `usage: ${s.usage ? `5h ${pct(s.usage.fiveHourPct)}, 7d ${pct(s.usage.sevenDayPct)}` : "no snapshot yet"}`,
    `linear: ${s.linear.ok ? `ok (${s.linear.email})` : `ERROR ${s.linear.error}`}`,
  ].join("\n")
}

type LedgerLine = { at: string; type: string } & Record<string, unknown>

function median(values: number[]): string | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return String(Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2))
}

export function summariseLedger(events: LedgerLine[], since: Date): string {
  const recent = events.filter((e) => typeof e.at === "string" && Date.parse(e.at) >= since.getTime())
  const of = (type: string) => recent.filter((e) => e.type === type)
  const ends = of("worker.end")
  const byStatus = new Map<string, number>()
  for (const e of ends) byStatus.set(String(e.status), (byStatus.get(String(e.status)) ?? 0) + 1)
  const doneMinutes = ends.filter((e) => e.status === "done" && typeof e.minutes === "number").map((e) => e.minutes as number)
  const spend = ends.reduce((sum, e) => sum + (typeof e.costUsd === "number" ? e.costUsd : 0), 0)
  const asked = of("question.asked")
  const answered = of("answer.applied")
  const latencies = answered
    .map((a) => {
      const q = [...asked].reverse().find((x) => x.issue === a.issue && x.at <= a.at)
      return q ? (Date.parse(a.at) - Date.parse(q.at)) / 60_000 : null
    })
    .filter((x): x is number => x !== null)
  const usage = of("usage").at(-1)
  const answerMedian = median(latencies)
  return [
    `since ${since.toISOString().slice(0, 10)}`,
    `jobs: ${ends.length} (${[...byStatus].map(([k, v]) => `${k} ${v}`).join(", ") || "none"})`,
    `PRs opened: ${of("pr.opened").length}, median job minutes for a PR: ${median(doneMinutes) ?? "n/a"}`,
    // STEP-3284's measure starts here: how often a report had to be asked for again, and how often review sent a PR back.
    `reports asked for again: ${of("report.corrected").length}, gone out with self-check gaps: ${of("report.selfCheckGaps").length}, titled from commits: ${of("report.fromCommits").length}, revise rounds: ${of("pr.revise").length}`,
    `estimated spend: USD ${spend.toFixed(2)}`,
    `questions: ${asked.length} asked, ${answered.length} answered, median answer ${answerMedian === null ? "n/a" : `${answerMedian} min`}`,
    `front door starts: ${of("frontdoor.start").length}, claims released: ${of("released").length}, pauses: ${of("paused").length}`,
    `latest usage: ${usage ? `5h ${usage.fiveHourPct ?? "?"} percent, 7d ${usage.sevenDayPct ?? "?"} percent` : "none recorded"}`,
  ].join("\n")
}
