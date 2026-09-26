/**
 * The only place the runtime @-mentions a person (spec 6, Notifications): an
 * urgent ping, once per key, in the thread of the item it is about, and the
 * morning digest the coordinator's Monday bridge posts in #polads-questions.
 */
import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { AgentConfig, AgentPaths } from "./config.ts"
import { readJson, safeKey, writeJsonAtomic } from "./fsq.ts"
import { listJobs } from "./jobs.ts"
import { appendLedger } from "./log.ts"
import { enqueueSlack, type OutboxMessage } from "./outbox.ts"
import { plainReason } from "./plain.ts"
import { truncateChars } from "./slack/text.ts"

export type PingReason = "blocked" | "money-legal-due" | "release-failed" | "testday-fail"

export interface Ping {
  /** Once per key: a second ping with it sends nothing. */
  key: string
  issue: string
  reason: PingReason
  text: string
  /** Their Slack id. Absent or not one of the people: all of them. */
  person?: string | null
  /** Another mini's thread; else the issue's own on this mini (opened when it has none). */
  thread?: { channelId: string; threadTs: string } | null
}

export interface DigestDays {
  at: string
  days: readonly number[]
  skipDates: readonly string[]
}

export interface DigestGroup {
  title: string
  one: string
  many: string
  items: Array<{ name: string; url: string }>
  testDay?: boolean
}

/** The people to @-mention: the one it is for when they are one of the people, else all of them. */

export function mentionsFor(config: AgentConfig, person?: string | null): string {
  const everyone = config.slack.allowedUsers
  return (person && everyone.includes(person) ? [person] : everyone).map((id) => `<@${id}>`).join(" ")
}

interface PingRecord {
  key: string
  reason: PingReason
  issue: string
  at: string
  /** Asked for at a quiet time: waiting here until flushPings sends it, with its mention or in the morning's one call. */
  waiting?: { person: string | null; thread: Ping["thread"] | null; text: string }
}

/** A sent ping's record is kept this long, for its once-per-key, then forgotten. */
const KEPT_DAYS = 14

/** Whether a ping may go now: in working hours on a working day, and a money or legal question due any day. */
function mayPing(reason: PingReason, now: Date, timeZone: string): boolean {
  const { weekday } = local(now, timeZone)
  return workingHours(now, timeZone) && (reason === "money-legal-due" || weekday <= 5)
}

const messageFor = (issue: string, thread: Ping["thread"] | null | undefined, text: string): OutboxMessage =>
  thread ? { kind: "reply", channelId: thread.channelId, threadTs: thread.threadTs, text } : { kind: "issue", issue, text, question: false }

/** A held ping for a blocked job that is no longer its issue's latest (retried, or another job since): nothing left to ask about. */
function outdated(paths: AgentPaths, record: PingRecord): boolean {
  if (record.reason !== "blocked" || !record.key.startsWith("blocked:")) return false
  const jobs = (["running", "pending", "done"] as const).flatMap((state) => listJobs(paths, state)).filter((j) => j.issue === record.issue)
  const latest = jobs.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)).at(-1)
  return latest !== undefined && latest.id !== record.key.slice("blocked:".length)
}

const pingsDir = (paths: AgentPaths) => join(paths.state, "pings")

/**
 * Once per key. Outside working hours (08:00 to 18:00 in queue.timeZone,
 * Monday to Friday; a money or legal question due asks on any day) it waits,
 * and agentd sends it once they begin (flushPings): nobody is @-mentioned at
 * night or at the weekend. true when it was taken, sent or waiting.
 */
export function ping(paths: AgentPaths, config: AgentConfig, p: Ping, now: Date): boolean {
  const file = join(pingsDir(paths), `${safeKey(p.key)}.json`)
  if (readJson(file)) return false
  // The text may carry a worker's or an issue's words (a blocked reason): escaped, so only these mentions reach anyone.
  const said = slackSafe(p.text)
  const record: PingRecord = { key: p.key, reason: p.reason, issue: p.issue, at: now.toISOString() }
  if (!mayPing(p.reason, now, config.queue.timeZone)) {
    writeJsonAtomic(file, { ...record, waiting: { person: p.person ?? null, thread: p.thread ?? null, text: said } })
    appendLedger(paths, { type: "ping.waiting", issue: p.issue, reason: p.reason }, now)
    return true
  }
  // Written first: a crash after it loses one ping, never sends two.
  writeJsonAtomic(file, record)
  enqueueSlack(paths, messageFor(p.issue, p.thread, `${mentionsFor(config, p.person)} ${said}`), now)
  appendLedger(paths, { type: "ping", issue: p.issue, reason: p.reason }, now)
  return true
}

/**
 * The pings that waited for a quiet time to pass, sent once it has, oldest
 * first. One alone goes as it would have. Several go to their threads without
 * a mention, and one post in #polads-questions calls the people to them all,
 * so a night of blocked jobs is one call, not a flood. A blocked job's ping
 * whose job is no longer the issue's latest is dropped. agentd calls it every
 * minute; it also forgets sent pings after KEPT_DAYS.
 */
export function flushPings(paths: AgentPaths, config: AgentConfig, now: Date): number {
  if (!existsSync(pingsDir(paths))) return 0
  const entries = readdirSync(pingsDir(paths))
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ file: join(pingsDir(paths), name), record: readJson<PingRecord>(join(pingsDir(paths), name)) }))
    .filter((e): e is { file: string; record: PingRecord } => e.record !== null)
  const forgetBefore = now.getTime() - KEPT_DAYS * 86_400_000
  for (const { file, record } of entries) if (!record.waiting && Date.parse(record.at) < forgetBefore) rmSync(file, { force: true })
  const due = entries
    .filter((e): e is { file: string; record: PingRecord & { waiting: NonNullable<PingRecord["waiting"]> } } => Boolean(e.record.waiting) && mayPing(e.record.reason, now, config.queue.timeZone))
    .sort((a, b) => a.record.at.localeCompare(b.record.at))
  const live = due.filter((e) => !outdated(paths, e.record))
  // Marked sent first, the outdated ones too: a crash after it loses a ping, never sends two.
  for (const { file, record } of due) {
    const { waiting: _, ...sent } = record
    writeJsonAtomic(file, sent)
  }
  if (live.length === 1) {
    const { record } = live[0]
    enqueueSlack(paths, messageFor(record.issue, record.waiting.thread, `${mentionsFor(config, record.waiting.person)} ${record.waiting.text}`), now)
  } else if (live.length > 1) {
    for (const { record } of live) enqueueSlack(paths, messageFor(record.issue, record.waiting.thread, record.waiting.text), now)
    const people = new Set(live.map((e) => e.record.waiting.person))
    const mentions = mentionsFor(config, people.size === 1 ? [...people][0] : null)
    // One line each: the whole text is in its thread.
    const list = live.map((e) => `- ${truncateChars(e.record.waiting.text.replace(/\s+/g, " ").trim(), 200)}`).join("\n")
    enqueueSlack(paths, { kind: "post", channel: "questions", text: `${mentions} ${live.length} things needed you while it was quiet, each in its own thread:\n${list}` }, now)
  }
  for (const { record } of live) appendLedger(paths, { type: "ping", issue: record.issue, reason: record.reason, waited: true }, now)
  return live.length
}

export const slackSafe = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "")

/** The local date and time in a time zone, as numbers. */
function local(now: Date, timeZone: string): { day: string; weekday: number; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  )
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1, minutes: Number(parts.hour) * 60 + Number(parts.minute) }
}

export function digestDue(now: Date, timeZone: string, cfg: DigestDays, postedDay: string | null): string | null {
  const { day, weekday, minutes } = local(now, timeZone)
  if (day === postedDay || !cfg.days.includes(weekday) || cfg.skipDates.includes(day)) return null
  const [h, m] = cfg.at.split(":").map(Number)
  // A mini down at 08:00 still posts until noon. After that, the day is missed: a digest at 15:00 is noise.
  return minutes >= h * 60 + m && minutes < 12 * 60 ? day : null
}

export function dueSoon(due: string | null, now: Date, timeZone: string): boolean {
  if (!due) return false
  const tomorrow = local(new Date(now.getTime() + 24 * 60 * 60_000), timeZone).day
  return due <= tomorrow
}

export const workingHours = (now: Date, timeZone: string) => {
  const { minutes } = local(now, timeZone)
  return minutes >= 8 * 60 && minutes < 18 * 60
}

const LINKS = 5
const list = (parts: string[]) => (parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`)

export function digestText(groups: DigestGroup[], extra: { testDay?: string | null; requests?: { active: number; readyToTest: number } | null }): string {
  // Wave 3's own line says how test day stands, in place of its count.
  const waiting = groups.filter((g) => g.items.length && !(extra.testDay && g.testDay))
  const counts = waiting.map((g) => `${g.items.length} ${g.items.length === 1 ? g.one : g.many}`)
  const head = counts.length ? `Good morning. Waiting for you: ${list(counts)}.` : extra.testDay ? "Good morning." : "Good morning. Nothing needs you this morning."
  const lines = [head]
  for (const g of waiting) {
    const links = g.items.slice(0, LINKS).map((i) => `<${i.url}|${slackSafe(truncateChars(i.name, 60))}>`)
    const more = g.items.length > LINKS ? `, and ${g.items.length - LINKS} more` : ""
    lines.push(`${g.title}: ${links.join(", ")}${more}`)
  }
  if (extra.testDay) lines.push(extra.testDay)
  if (extra.requests) lines.push(`Requests: ${extra.requests.active} active, ${extra.requests.readyToTest} ready to test.`)
  return lines.join("\n")
}

/**
 * A job that ended blocked (spec 6): the people are called, once per job, in
 * its issue's thread. With the reason when nothing was said there (a worker
 * that died); without it, as a call to the question the runner just asked.
 */
export function blockedPing(jobId: string, issue: string, reason: string | null): Ping {
  return {
    key: `blocked:${jobId}`,
    issue,
    reason: "blocked",
    text: reason
      ? `${issue} is blocked: ${plainReason(reason)}. Reply "retry" here once the cause is fixed, or "leave it" to take it over.`
      : `${issue} is blocked. What happened, and what you can reply, is just above.`,
  }
}
