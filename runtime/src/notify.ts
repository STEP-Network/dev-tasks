/**
 * The only place the runtime @-mentions a person (spec 6, Notifications): an
 * urgent ping, once per key, in the thread of the item it is about, and the
 * morning digest the coordinator's Monday bridge posts in #polads-questions.
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { AgentConfig, AgentPaths } from "./config.ts"
import { readJson, safeKey, writeJsonAtomic } from "./fsq.ts"
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
  reason: PingReason
  issue: string
  at: string
  /** Asked for outside working hours: the message waits here until flushPings sends it. */
  waiting?: OutboxMessage
}

const pingsDir = (paths: AgentPaths) => join(paths.state, "pings")

/**
 * Once per key. Outside working hours (08:00 to 18:00 in queue.timeZone) it
 * waits, and agentd sends it once they begin (flushPings): nobody is
 * @-mentioned at night. true when it was taken, sent or waiting.
 */
export function ping(paths: AgentPaths, config: AgentConfig, p: Ping, now: Date): boolean {
  const file = join(pingsDir(paths), `${safeKey(p.key)}.json`)
  if (readJson(file)) return false
  // The text may carry a worker's or an issue's words (a blocked reason): escaped, so only these mentions reach anyone.
  const text = `${mentionsFor(config, p.person)} ${slackSafe(p.text)}`
  const message: OutboxMessage = p.thread ? { kind: "reply", channelId: p.thread.channelId, threadTs: p.thread.threadTs, text } : { kind: "issue", issue: p.issue, text, question: false }
  const record: PingRecord = { reason: p.reason, issue: p.issue, at: now.toISOString() }
  if (!workingHours(now, config.queue.timeZone)) {
    writeJsonAtomic(file, { ...record, waiting: message })
    appendLedger(paths, { type: "ping.waiting", issue: p.issue, reason: p.reason }, now)
    return true
  }
  // Written first: a crash after it loses one ping, never sends two.
  writeJsonAtomic(file, record)
  enqueueSlack(paths, message, now)
  appendLedger(paths, { type: "ping", issue: p.issue, reason: p.reason }, now)
  return true
}

/** The pings that waited for working hours, sent in the order they came, once those hours begin. agentd calls it every minute. */
export function flushPings(paths: AgentPaths, config: AgentConfig, now: Date): number {
  if (!workingHours(now, config.queue.timeZone) || !existsSync(pingsDir(paths))) return 0
  const waiting = readdirSync(pingsDir(paths))
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ file: join(pingsDir(paths), name), record: readJson<PingRecord>(join(pingsDir(paths), name)) }))
    .filter((e): e is { file: string; record: PingRecord & { waiting: OutboxMessage } } => Boolean(e.record?.waiting))
    .sort((a, b) => a.record.at.localeCompare(b.record.at))
  for (const { file, record } of waiting) {
    const { waiting: message, ...sent } = record
    // Marked sent first: a crash after it loses one ping, never sends two.
    writeJsonAtomic(file, sent)
    enqueueSlack(paths, message, now)
    appendLedger(paths, { type: "ping", issue: record.issue, reason: record.reason, waited: true }, now)
  }
  return waiting.length
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
