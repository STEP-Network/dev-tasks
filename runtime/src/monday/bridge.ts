/**
 * The Monday bridge (STEP-3289): the people-and-agents board kept in step
 * with Linear. Linear stays the engineering record; the board shows people
 * what they need to see or do. It runs inside agentd on exactly one
 * coordinator mini (bridges.monday.enabled), every pollMinutes, or less often
 * when the account's daily API calls would not stretch to that (apiShare):
 *
 *  1. Words first. A configured person's update on an item (or a reply under
 *     one), or their Answer column, goes through routeWords (route.ts): added
 *     to the issue always, and an instruction for agentd too where this mini
 *     has work of its own on the issue, else an answer that moves a parked
 *     issue on. They are marked handled once Linear has them, so they are
 *     acted on once. The item's State becomes Waiting on agent. On a Test day
 *     item only PASS or FAIL counts, and records the UAT verdict as
 *     review-uat does.
 *  2. Requests. A person's new item in Requests becomes a Linear Triage
 *     issue, linked both ways, and moves to Agents working on. It is Blocked
 *     while the issue is On hold, and Done once it is released. With the
 *     Requests board configured (Wave 2), requests live there instead
 *     (requests.ts), and each poll reads both boards.
 *  3. Needs you and Test day. One item per Linear id: this mini's open
 *     decisions, needs-human, and a question or to-do an issue is On hold
 *     for, in Needs you; this mini's product's Waiting for UAT in Test day,
 *     with the steps to check (another product's is archived). When Linear
 *     no longer needs a person, the item moves to Done.
 *     Once the board has its Slack thread column (Wave 2), each item has one
 *     Slack thread with the item's link, and what a person settles in one
 *     door is said in the other (spec 6).
 *  4. Done items are archived after archiveAfterDays.
 *  5. Replies queued for the board (agentd's answers to an instruction, and
 *     the bridge's own) are posted, with a like on the person's update.
 *
 * Item text is untrusted data. Only the configured people count: anyone
 * else's words and items are left alone, the agent's own included. Their
 * words reach an agent only through the classifier's fixed verbs
 * (slack/instruction.ts), or quoted, as an answer or a request, on the
 * issue. The token's user must be neither a Monday admin nor one of the
 * people: the bridge refuses to run otherwise.
 */

import { createHash } from "node:crypto"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { ack, fail, listNew } from "../fsq.ts"
import { appendLedger, redact, type Logger } from "../log.ts"
import { answeredSince, answerSaid, personKey, recordedAnswers, secondAnswerText } from "../answer.ts"
import { digestDue, digestText, dueSoon, ping, workingHours, type DigestGroup } from "../notify.ts"
import { enqueueSlack, lastQuestion } from "../outbox.ts"
import { prRef, recommendationOf } from "../plain.ts"
import { openDecisions, questionText, type Decision } from "../agentd/decisions.ts"
import { truncateChars } from "../slack/text.ts"
import { threadFor } from "../threads.ts"
import { extractAcceptanceCriteria, isIssueGone, type Tracker } from "../tracker.ts"
import { MondayRefused, type MondayApi, type MondayBoard, type MondayItem } from "./client.ts"
import type { PeopleIssue, PeopleView } from "./people.ts"
import { aboutText, lookBody, lookName, needBody, needKind, needName, plainText, planBody, planName, quote, say, stableUuid, toHtml, uatBody, uatName, type MondayKind, type NeedSource } from "./render.ts"
import { createRequests, fileRequest, type RequestsPass } from "./requests.ts"
import { routeWords, type Words } from "./route.ts"
import { requestGroup } from "./stage.ts"
import { slackMessage, threadTarget } from "./threads.ts"
import { parseVerdict, recordVerdict, verdictReply } from "../verdict.ts"
import { dropRecord, enqueueMonday, mondayOutbox, readCursor, readDigestDay, readRecords, saveRecord, writeCursor, writeDigestDay, type ItemRecord, type MondayReply, type MondayState } from "./store.ts"

export interface MondayBridgeDeps {
  paths: AgentPaths
  config: AgentConfig
  log: Logger
  now: () => Date
  api: MondayApi
  tracker: Tracker
  people: PeopleView
  /** Wave 3's test-day line for the morning digest ("Test day in progress (14 of 20 checked)."), in place of its count. */
  testDayLine?: () => string | null
}

export interface MondayBridge {
  /** One poll: words, requests, needs, archive, replies. */
  sync(): Promise<void>
  /** Only the replies waiting for the board: agentd calls it every loop, so an answer is not held for the next poll. */
  drain(): Promise<void>
  /** How long agentd waits between polls: pollMinutes, or longer to keep within apiShare of the account's daily calls. */
  pollEveryMs(): number
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** How far back the Answer column's history is read again, so a change logged late is not missed. */
const OVERLAP_MS = 5 * MINUTE
const WORDS_MAX = 4000
/** Free, Basic and Standard's daily API calls (developer.monday.com, Rate limits): what the bridge assumes when Monday does not say. */
const SMALLEST_PLAN_CALLS = 1000

type GroupKey = "needsYou" | "testDay" | "requests" | "working" | "done" | "approvePlan" | "looks" | "fyi"

/** What the board should show for one Linear id. */
interface Need {
  key: string
  kind: "needs" | "uat"
  group: GroupKey
  issue: PeopleIssue
  name: string
  body: string
  mondayKind: MondayKind
  agent: string | null
  pr: string | null
  due: string | null
  /** What a yes agrees to: the Recommendation column (spec 6). */
  recommendation: string | null
  /** The request item it belongs to, for the Request column. */
  request: string | null
}

interface Pass {
  board: MondayBoard
  /** The configured groups: a Wave 2 group absent from config is absent here, and no need asks for it. */
  groups: Partial<Record<GroupKey, string>>
  byId: Map<string, MondayItem>
  now: Date
}

type Person = { id: string; name: string }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const byCreated = <T extends { createdAt: string }>(a: T, b: T) => a.createdAt.localeCompare(b.createdAt)
const capitalised = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)
/** A group's id this pass. A need picks a Wave 2 group only when config names it, and groupIds found it or threw. */
const groupOf = (pass: Pass, key: GroupKey): string => pass.groups[key]!

/** The URL a link column holds, from its value. */
function linkUrl(column: { value: string | null } | undefined): string | null {
  try {
    const url = (JSON.parse(column?.value ?? "null") as { url?: unknown } | null)?.url
    return typeof url === "string" ? url : null
  } catch {
    return null
  }
}

/** YYYY-MM-DD in the mini's time zone. */
function dateIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
}

export function createMondayBridge(deps: MondayBridgeDeps): MondayBridge {
  const { paths, log, api, tracker, people } = deps
  const cfg = deps.config.bridges.monday
  if (!cfg) throw new Error("monday: bridges.monday is not in config.json")
  const agentLabel = cfg.agentLabel ?? capitalised(deps.config.mini)
  const agentLabels = cfg.agentLabels ?? [agentLabel]
  const person = new Map(cfg.people.map((p) => [p.id, p]))
  /** The two doors (spec 6), open once the board has its Slack thread column: until go-live the bridge runs as before. */
  const doors = Boolean(cfg.columns.slackThread)
  const noted = new Set<string>()
  const once = (key: string, fn: () => void) => {
    if (noted.has(key)) return
    noted.add(key)
    fn()
  }
  let checked = false
  let refused: string | null = null
  /** The account's API calls a day, and when they were last read: the plan decides them, so once a day is enough. */
  let limit: { calls: number; readAt: number } | null = null

  /** The token's own user, once: an admin's token, or one of the people's, and the bridge does nothing at all. */
  async function allowed(): Promise<boolean> {
    if (refused) return false
    if (checked) return true
    const me = await deps.api.me()
    refused = me.isAdmin
      ? "the token in ~/.config/agentd/monday.env belongs to a Monday admin. The bridge takes only the agent's own Monday user, with access to this board alone (runbook, The Monday board)"
      : person.has(me.id)
        ? `the token's Monday user (${me.id}) is one of bridges.monday.people, so the bridge would read its own updates as that person's`
        : null
    if (refused) {
      log.error("monday bridge refused", { reason: refused })
      return false
    }
    checked = true
    return true
  }

  function pollEveryMs(): number {
    const floor = cfg!.pollMinutes * MINUTE
    if (!limit) return floor
    // Each poll reads every board once, within apiShare of what the whole account may call in a day.
    const reads = cfg!.requests ? 2 : 1
    return Math.max(floor, Math.ceil(((DAY / MINUTE) * reads) / (limit.calls * cfg!.apiShare)) * MINUTE)
  }

  async function readLimit(now: Date): Promise<void> {
    if (limit && now.getTime() - limit.readAt < DAY) return
    const before = pollEveryMs()
    let calls: number | null = null
    let why = "monday gave no number"
    try {
      calls = await api.dailyLimit()
    } catch (error) {
      why = message(error)
    }
    if (!calls) {
      // Unknown, it is the smallest plan's: too slow a poll costs minutes, too fast a one the whole account's API for the day.
      once("daily-limit", () => log.warn(`monday did not say the account's daily API limit, so the bridge assumes ${SMALLEST_PLAN_CALLS} (the smallest plan)`, { error: why }))
      calls = SMALLEST_PLAN_CALLS
    }
    limit = { calls, readAt: now.getTime() }
    if (pollEveryMs() !== before) log.info("monday poll", { dailyLimit: calls, everyMinutes: pollEveryMs() / MINUTE })
  }

  /** A reply on the item: under the person's thread, with a like beside it only when it says the thing was done. */
  const reply = (itemId: string, words: Pick<Words, "threadId" | "updateId"> | null, text: string, now: Date, like = true) =>
    enqueueMonday(paths, { itemId, threadId: words?.threadId ?? null, text, like: like ? (words?.updateId ?? null) : null }, now)

  const save = (rec: ItemRecord) => saveRecord(paths, rec)

  const requestsBoard = cfg.requests
    ? createRequests({ paths, config: deps.config, log, api, tracker, people, once, reply: (itemId, text, now) => reply(itemId, null, text, now) })
    : null

  async function setState(rec: ItemRecord, state: MondayState): Promise<void> {
    if (rec.state === state) return
    await api.setColumns(cfg!.boardId, rec.itemId, { [cfg!.columns.state]: { label: state } })
    rec.state = state
    save(rec)
  }

  async function resolve(rec: ItemRecord, pass: Pass, note: string | null): Promise<void> {
    const item = pass.byId.get(rec.itemId)
    if (item) {
      await api.setColumns(cfg!.boardId, item.id, { [cfg!.columns.state]: { label: "Done" } })
      if (item.groupId !== groupOf(pass, "done")) await api.moveItem(item.id, groupOf(pass, "done"))
      if (note) reply(item.id, null, note, pass.now)
    }
    rec.state = "Done"
    rec.doneAt = pass.now.toISOString()
    save(rec)
  }

  function personFor(issue: PeopleIssue): string {
    const byEmail = (email: string | undefined) => cfg!.people.find((p) => p.linearEmail && email && p.linearEmail.toLowerCase() === email.toLowerCase())
    return (byEmail(issue.owner?.email) ?? byEmail(issue.requester?.email))?.id ?? cfg!.defaultPerson
  }

  /** The Agent column's label for the Linear account holding the issue, when it is one of the agents. */
  function agentFor(issue: PeopleIssue): string | null {
    const owner = issue.owner?.name.trim().toLowerCase()
    return agentLabels.find((label) => label.toLowerCase() === owner) ?? null
  }

  function columnsFor(need: Need, first: boolean): Record<string, unknown> {
    const c = cfg!.columns
    const values: Record<string, unknown> = {
      [c.kind]: { label: need.mondayKind },
      [c.state]: { label: "Needs you" },
      [c.linear]: { url: need.issue.url, text: need.issue.id },
    }
    // The Person is chosen once: a person who hands an item on keeps it handed on.
    if (first) values[c.person] = { personsAndTeams: [{ id: Number(personFor(need.issue)), kind: "person" }] }
    // Asked again, the item starts with an empty Answer, not the last one.
    else values[c.answer] = ""
    if (need.agent) values[c.agent] = { labels: [need.agent] }
    if (need.pr) values[c.pr] = { url: need.pr, text: prRef(need.pr) }
    if (need.due) values[c.due] = { date: need.due }
    // Wave 2's columns, only where the board has them. A question asked again without a recommendation clears the last one.
    if (c.recommendation && need.recommendation) values[c.recommendation] = need.recommendation
    else if (c.recommendation && !first) values[c.recommendation] = ""
    if (c.request && need.request) values[c.request] = { item_ids: [Number(need.request)] }
    return values
  }

  // 1. Words ----------------------------------------------------------------

  async function hearWords(pass: Pass): Promise<void> {
    const byItem = new Map(readRecords(paths).map((r) => [r.itemId, r]))
    const tried = new Set<string>()
    for (const item of pass.board.items) {
      const rec = byItem.get(item.id)
      if (!rec) continue
      for (const u of [...item.updates].sort(byCreated)) {
        if (rec.handled.includes(u.id)) continue
        const who = u.creatorId ? person.get(u.creatorId) : undefined
        // The agent's own updates, and anyone not on the list: never a person's words.
        if (!who) continue
        // A reply's link opens its thread's update. Each link is its own: appendAnswer knows an answer by it too.
        const permalink = u.threadId === u.id ? `${item.url}/posts/${u.id}` : `${item.url}/posts/${u.threadId}?reply=reply-${u.id}`
        await hear(rec, item, who, { id: u.id, text: u.text, updateId: u.id, threadId: u.threadId, permalink, at: u.createdAt }, pass)
      }
    }
    for (const change of pass.board.changes) {
      // Only the Answer column holds words: another watched column (the Class column, Task 12) is not an answer.
      if (change.columnId !== cfg!.columns.answer) continue
      const rec = byItem.get(change.itemId)
      const item = pass.byId.get(change.itemId)
      const who = person.get(change.userId)
      const id = `log:${change.id}`
      if (!rec || !item || !who || rec.handled.includes(id)) continue
      tried.add(id)
      await hear(rec, item, who, { id, text: change.text, updateId: null, threadId: null, permalink: null, at: change.at }, pass)
    }
    // Answer column changes Linear refused, from their copy: the log has moved on from them.
    for (const rec of byItem.values()) {
      for (const [id, kept] of Object.entries(rec.retry ?? {})) {
        const item = pass.byId.get(rec.itemId)
        const who = person.get(kept.userId)
        if (tried.has(id) || rec.handled.includes(id) || !item || !who) continue
        await hear(rec, item, who, { id, text: kept.text, updateId: null, threadId: null, permalink: null, at: kept.at ?? null }, pass)
      }
    }
    writeCursor(paths, pass.now)
  }

  function mark(rec: ItemRecord, id: string): void {
    rec.handled.push(id)
    if (rec.failing?.[id]) {
      const { [id]: _, ...rest } = rec.failing
      rec.failing = rest
    }
    if (rec.retry?.[id]) {
      const { [id]: _, ...rest } = rec.retry
      rec.retry = rest
    }
    save(rec)
  }

  async function hear(rec: ItemRecord, item: MondayItem, who: Person, raw: Words, pass: Pass): Promise<void> {
    const words: Words = { ...raw, text: truncateChars(redact(raw.text).trim(), WORDS_MAX) }
    if (!words.text) return mark(rec, words.id)
    try {
      // Each marks the words handled once their Linear write has landed: whatever fails after, they are never routed twice.
      if (rec.kind === "uat") await verdict(rec, item, who, words, pass)
      else await answer(rec, item, who, words, pass)
    } catch (error) {
      if (isIssueGone(error)) {
        reply(item.id, words, say.gone(rec.issue), pass.now, false)
        return mark(rec, words.id)
      }
      const first = rec.failing?.[words.id]
      if (first && pass.now.getTime() - Date.parse(first) > DAY) {
        reply(item.id, words, say.refused(rec.issue), pass.now, false)
        log.error("monday words given up", { issue: rec.issue, item: item.id, error: message(error) })
        return mark(rec, words.id)
      }
      if (!first) rec.failing = { ...rec.failing, [words.id]: pass.now.toISOString() }
      if (words.updateId === null) rec.retry = { ...rec.retry, [words.id]: { userId: who.id, text: words.text, ...(words.at ? { at: words.at } : {}) } }
      save(rec)
      log.warn("monday words not acted on yet", { issue: rec.issue, item: item.id, error: message(error) })
    }
  }

  /** What follows words already recorded in Linear: a failure is logged, never a reason to hear them again. */
  async function after(what: string, rec: ItemRecord, fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (error) {
      log.warn(`monday ${what} failed after the words were recorded`, { issue: rec.issue, error: message(error) })
    }
  }

  /** Words on a Needs you or a request item, through the one router (route.ts). */
  async function answer(rec: ItemRecord, item: MondayItem, who: Person, words: Words, pass: Pass): Promise<void> {
    const request = rec.kind === "request"
    const routed = await routeWords(
      { paths, tracker, mini: deps.config.mini },
      {
        issue: rec.issue, request, itemId: item.id, who, words, now: pass.now,
        // The first answer after the item asked counts (spec 6). A request asks nothing.
        since: request ? null : (rec.askedAt ?? lastQuestion(paths, rec.issue)?.at ?? rec.createdAt),
        by: personKey(deps.config, { monday: who.id }),
        // What the item recommends (its Recommendation column): a yes agrees to it where this mini asked nothing (another mini's plan).
        recommendation: cfg!.columns.recommendation ? (item.columns[cfg!.columns.recommendation]?.text?.trim() || null) : null,
      },
    )
    mark(rec, words.id)
    if (routed.to === "same") {
      reply(item.id, words, say.sameAnswer(who.name, routed.first.who), pass.now)
      return
    }
    if (routed.to === "second") {
      // Asked back: their next words answer this, and a third person's count only after it.
      reply(item.id, words, secondAnswerText(routed.first), pass.now)
      rec.askedAt = pass.now.toISOString()
      save(rec)
      return
    }
    // agentd answers an instruction itself, once it has acted (agentd/instructions.ts).
    if (routed.to === "issue") {
      reply(item.id, words, say.answered(who.name, routed.movedTo), pass.now)
      if (rec.kind === "needs") settledHere(rec, say.mirrored(who.name, "on Monday", answerSaid(routed.recorded)), pass.now)
    }
    // Words from before the newest question: the item still needs them, for that one.
    if (routed.to === "newer-question") {
      reply(item.id, words, say.newerQuestion(who.name, routed.question), pass.now)
      return
    }
    // Nothing recorded: the item still waits for what they mean.
    if (routed.to === "unclear") {
      reply(item.id, words, say.planYes(who.name), pass.now, false)
      return
    }
    // A request's State follows its issue in Linear (requests below).
    if (rec.kind !== "request") await after("state", rec, () => setState(rec, "Waiting on agent"))
  }

  /**
   * A person's verdict on a Test day or a Looks good? item: PASS or FAIL, and
   * on a Look also "looks good" or "change" (spec 3). Written through the one
   * verdict recorder Slack uses too (verdict.ts), as review-uat writes it.
   */
  async function verdict(rec: ItemRecord, item: MondayItem, who: Person, words: Words, pass: Pass): Promise<void> {
    const current = await tracker.readIssue(rec.issue)
    const look = current.labels.includes("approval/look")
    const v = parseVerdict(words.text, look)
    if (!v) {
      reply(item.id, words, say.onlyVerdicts(look), pass.now, false)
      return mark(rec, words.id)
    }
    const out = await recordVerdict(
      { paths, tracker, people, product: deps.config.repo.product, now: () => pass.now, log },
      { issue: rec.issue, who: who.name, verdict: v, where: words.permalink ?? item.url, source: "monday", key: words.id },
    )
    mark(rec, words.id)
    reply(item.id, words, verdictReply(who.name, out), pass.now, out.outcome !== "not-waiting")
    if (out.outcome !== "not-waiting") settledHere(rec, say.mirroredVerdict(who.name, "on Monday", out), pass.now)
  }

  /** Settled on this board: said in the item's Slack thread, and no note from the other door when it goes to Done. */
  function settledHere(rec: ItemRecord, text: string, now: Date): void {
    if (!doors) return
    mirrorToSlack(rec, text, now)
    rec.answeredHere = true
    save(rec)
  }

  // 2. Requests -------------------------------------------------------------

  async function link(rec: ItemRecord, item: MondayItem, issue: { id: string; url: string }, pass: Pass): Promise<void> {
    const c = cfg!.columns
    await api.setColumns(cfg!.boardId, item.id, {
      [c.linear]: { url: issue.url, text: issue.id },
      [c.kind]: { label: "Request" },
      [c.state]: { label: "Waiting on agent" },
      ...(item.creatorId ? { [c.person]: { personsAndTeams: [{ id: Number(item.creatorId), kind: "person" }] } } : {}),
    })
    const working = pass.groups.working
    if (working && item.groupId !== working) await api.moveItem(item.id, working)
    rec.linked = true
    rec.state = "Waiting on agent"
    save(rec)
    const who = item.creatorId ? person.get(item.creatorId) : undefined
    if (who) reply(item.id, null, say.filed(who.name, issue.id), pass.now)
  }


  async function requests(pass: Pass): Promise<void> {
    await fileRequests(pass)
    await updateRequests(pass)
  }

  /** A person's new item in the Requests group, filed. */
  async function fileRequests(pass: Pass): Promise<void> {
    const tracked = new Set(readRecords(paths).map((r) => r.itemId))
    for (const item of pass.board.items) {
      if (item.groupId !== groupOf(pass, "requests") || tracked.has(item.id)) continue
      const who = item.creatorId ? person.get(item.creatorId) : undefined
      if (!who) {
        once(`request:${item.id}`, () => log.info("monday request from someone not on bridges.monday.people, left alone", { item: item.id }))
        continue
      }
      // One at a time: a request Linear refuses waits for the next poll, and the others go on.
      try {
        await fileRequest({ paths, config: deps.config, log, tracker, once }, item, who, pass.now, (rec, filed) => link(rec, item, filed, pass))
      } catch (error) {
        log.warn("monday request not filed yet", { item: item.id, error: message(error) })
      }
    }
  }

  /**
   * Each request item on this board kept in step with its issue. With the
   * Requests board configured, only the ones still here (the migration,
   * Task 11, moves them): that board's own are its part's.
   */
  async function updateRequests(pass: Pass): Promise<void> {
    const open = readRecords(paths).filter((r) => r.kind === "request" && r.state !== "Done" && pass.byId.has(r.itemId))
    if (!open.length) return
    const issues = new Map((await people.byIdentifiers(open.map((r) => r.issue))).map((i) => [i.id, i]))
    for (const rec of open) {
      const item = pass.byId.get(rec.itemId)
      const issue = issues.get(rec.issue)
      if (!item || !issue) continue
      try {
        if (!rec.linked) await link(rec, item, issue, pass)
        if (issue.stateType === "completed") await resolve(rec, pass, say.released(issue.id))
        else if (issue.stateType === "canceled" || issue.stateType === "duplicate") await resolve(rec, pass, say.closed(issue.id))
        else await setState(rec, issue.state === "On hold" ? "Blocked" : "Waiting on agent")
      } catch (error) {
        log.warn("monday request not brought up to date", { item: item.id, issue: rec.issue, error: message(error) })
      }
    }
  }

  // 3. Needs you and Test day ------------------------------------------------

  function decisionNeed(d: Decision, issue: PeopleIssue, request: string | null): Need {
    const timeZone = deps.config.queue.timeZone
    const question = questionText(d, timeZone, "monday")
    return {
      key: `needs-${issue.id}`, kind: "needs", group: "needsYou", issue,
      name: needName("decision", issue.title, agentLabel),
      body: needBody("decision", { title: issue.title, agent: agentLabel, question }),
      mondayKind: needKind("decision"), agent: agentLabel, pr: d.url || issue.prUrl, due: dateIn(new Date(d.deadlineAt), timeZone),
      // The recommendation as Slack words it: the default option (the board's own text lists the options).
      recommendation: recommendationOf(questionText(d, timeZone)), request,
    }
  }

  function linearNeed(issue: PeopleIssue, request: string | null): Need {
    const parked = issue.state === "On hold"
    const source: NeedSource =
      parked && issue.labels.includes("awaiting-answer") ? "awaiting-answer" : parked && issue.labels.includes("human-todo") ? "human-todo" : "needs-human"
    const agent = agentFor(issue)
    const question = source === "needs-human" ? null : (lastQuestion(paths, issue.id)?.text ?? null)
    const base = { key: `needs-${issue.id}`, kind: "needs" as const, issue, agent, pr: issue.prUrl, due: issue.dueDate, request }
    // A Try plan asking for its OK (spec 4): its own group, once the board has it.
    if (cfg!.groups.approvePlan && source === "awaiting-answer" && issue.labels.includes("plan-to-approve")) {
      return {
        ...base, group: "approvePlan", name: planName(issue.title, agent), body: planBody({ title: issue.title, agent, question }),
        mondayKind: "Approval", recommendation: recommendationOf(question),
      }
    }
    return {
      ...base, group: "needsYou",
      name: needName(source, issue.title, agent),
      body: needBody(source, { title: issue.title, agent, question, about: aboutText(issue.description) }),
      mondayKind: needKind(source), recommendation: recommendationOf(question),
    }
  }

  function uatNeed(issue: PeopleIssue, request: string | null): Need {
    const base = { key: `uat-${issue.id}`, kind: "uat" as const, issue, mondayKind: "Check" as const, agent: agentFor(issue), pr: issue.prUrl, due: issue.dueDate, request }
    // A Look (spec 3): the browser test's screenshots, and "looks good" or "change". Its own group, once the board has it.
    if (cfg!.groups.looks && issue.labels.includes("approval/look")) {
      return { ...base, group: "looks", name: lookName(issue.title), body: lookBody(issue.title, issue.prUrl, issue.url), recommendation: "Looks good" }
    }
    const steps = issue.uatSteps ?? extractAcceptanceCriteria(issue.description)
    return { ...base, group: "testDay", name: uatName(issue.title), body: uatBody(issue.title, steps ? plainText(steps) : null), recommendation: null }
  }

  /** The request a need belongs to: its issue's, or its parent's (a task under a request). */
  function requestItemFor(issue: PeopleIssue, requests: ItemRecord[]): string | null {
    return requests.find((r) => r.issue === issue.id || (issue.parent !== null && r.issue === issue.parent))?.itemId ?? null
  }

  async function upsert(need: Need, found: ItemRecord | null, pass: Pass): Promise<ItemRecord | null> {
    const hash = createHash("sha256").update(`${need.name}\n${need.body}`).digest("hex").slice(0, 16)
    const group = groupOf(pass, need.group)
    let rec = found
    if (rec && !pass.byId.has(rec.itemId)) {
      // A person deleted or archived the item: it is not put back while this need lasts. A later need gets a new one.
      if (rec.state !== "Done") return null
      dropRecord(paths, rec.key)
      rec = null
    }
    if (!rec) {
      // The board is the record too: an item a crash left unrecorded is taken over, not made twice.
      const adopted = pass.board.items.find((i) => i.groupId === group && linkUrl(i.columns[cfg!.columns.linear]) === need.issue.url)
      const itemId = adopted?.id ?? (await api.createItem(cfg!.boardId, group, truncateChars(need.name, 250), columnsFor(need, true)))
      rec = {
        key: need.key, kind: need.kind, issue: need.issue.id, itemId, state: "Needs you", bodyHash: null,
        createdAt: pass.now.toISOString(), doneAt: null, handled: adopted ? adopted.updates.map((u) => u.id) : [],
        // Its Slack thread, once the board has the column: before that it waits like any older item.
        ...(doors ? { thread: { state: "wanted" as const } } : {}),
        // A new item carries its Request link already (columnsFor), where the board has the column; an adopted one gets it below.
        ...(cfg!.columns.request && need.request && !adopted ? { requestItem: need.request } : {}),
      }
      save(rec)
      if (!adopted) appendLedger(paths, { type: "monday.item", issue: need.issue.id, kind: need.kind }, pass.now)
    } else if (rec.bodyHash !== hash || rec.state === "Done") {
      // A new question, or a need back after it was settled: the item asks again.
      await api.setColumns(cfg!.boardId, rec.itemId, columnsFor(need, false))
      if (pass.byId.get(rec.itemId)?.groupId !== group) await api.moveItem(rec.itemId, group)
      if (cfg!.columns.request && need.request) rec.requestItem = need.request
    }
    // The request it belongs to, once that is known, or when it changes: one write, then never again while it stands.
    const requestColumn = cfg!.columns.request
    if (requestColumn && need.request && need.request !== rec.requestItem) {
      await api.setColumns(cfg!.boardId, rec.itemId, { [requestColumn]: { item_ids: [Number(need.request)] } })
      rec.requestItem = need.request
      save(rec)
    }
    if (rec.bodyHash === hash && rec.state !== "Done") return rec
    await api.postUpdate(rec.itemId, toHtml(need.body))
    // The item asks: the first answer after this counts, in either door.
    rec.askedAt = pass.now.toISOString()
    rec.answeredHere = false
    rec.bodyHash = hash
    rec.state = "Needs you"
    rec.doneAt = null
    save(rec)
    return rec
  }

  /**
   * Spec 6: a money or legal question due today or tomorrow pings its person
   * once per due date, in working hours, in its thread, with the item's link.
   * A new item is pinged on the next poll, when the board gives its link.
   */
  function pingIfDue(need: Need, rec: ItemRecord | null, pass: Pass): void {
    const timeZone = deps.config.queue.timeZone
    if (need.kind !== "needs" || !need.due || !need.issue.labels.some((l) => l === "money" || l === "regulatory")) return
    if (!dueSoon(need.due, pass.now, timeZone) || !workingHours(pass.now, timeZone)) return
    const item = rec ? pass.byId.get(rec.itemId) : undefined
    if (!item) return
    const target = threadTarget(paths, need.issue.id, need.issue.slackThread)
    ping(
      paths,
      deps.config,
      {
        key: `money-legal:${need.issue.id}:${need.due}`,
        issue: need.issue.id,
        reason: "money-legal-due",
        text: say.moneyLegalDue(need.issue.id, need.due, item.url),
        person: cfg!.people.find((p) => p.id === personFor(need.issue))?.slackId ?? null,
        thread: target.kind === "linked" ? { channelId: target.channelId, threadTs: target.threadTs } : null,
      },
      pass.now,
    )
  }

  /** Each need's issue's Slack thread link, as Linear keeps it: where threads() posts. */
  async function needs(pass: Pass): Promise<Map<string, string | null>> {
    const linear = await people.needsYou()
    // Test day is what a person can try on the test site: this mini's product, and no other's.
    const product = deps.config.repo.product
    const waiting = await people.waitingForUat()
    const uat = waiting.filter((i) => i.labels.includes(product))
    const elsewhere = new Set(waiting.filter((i) => !i.labels.includes(product)).map((i) => `uat-${i.id}`))
    // This mini's open questions, the newest per issue.
    const decisions = new Map(openDecisions(paths).map((d) => [d.issue, d]))
    const known = new Map(linear.map((i) => [i.id, i]))
    const unknown = [...decisions.keys()].filter((id) => !known.has(id))
    if (unknown.length) for (const i of await people.byIdentifiers(unknown)) known.set(i.id, i)

    const requests = readRecords(paths).filter((r) => r.kind === "request")
    const wanted = new Map<string, Need>()
    for (const [id, d] of decisions) {
      const issue = known.get(id)
      if (issue) wanted.set(`needs-${id}`, decisionNeed(d, issue, requestItemFor(issue, requests)))
    }
    for (const issue of linear) if (!wanted.has(`needs-${issue.id}`)) wanted.set(`needs-${issue.id}`, linearNeed(issue, requestItemFor(issue, requests)))
    for (const issue of uat) wanted.set(`uat-${issue.id}`, uatNeed(issue, requestItemFor(issue, requests)))

    const recs = readRecords(paths).filter((r) => r.kind !== "request")
    const byKey = new Map(recs.map((r) => [r.key, r]))
    for (const need of wanted.values()) {
      let rec: ItemRecord | null
      try {
        rec = await upsert(need, byKey.get(need.key) ?? null, pass)
      } catch (error) {
        log.error("monday item not written", { key: need.key, error: message(error) })
        continue
      }
      try {
        pingIfDue(need, rec, pass)
      } catch (error) {
        log.warn("monday ping not sent", { key: need.key, error: message(error) })
      }
    }
    // What settled the ones going to Done, when it was the other door: read once.
    const settling = recs.filter((r) => !elsewhere.has(r.key) && !wanted.has(r.key) && r.state !== "Done")
    const settled = new Map((doors && settling.length ? await people.byIdentifiers(settling.map((r) => r.issue)) : []).map((i) => [i.id, i]))
    for (const rec of recs) {
      if (elsewhere.has(rec.key)) await dropElsewhere(rec, pass)
      else if (!wanted.has(rec.key) && rec.state !== "Done") await resolve(rec, pass, settledNote(rec, settled.get(rec.issue)))
    }
    return new Map([...known.values(), ...uat].map((i) => [i.id, i.slackThread]))
  }

  /** What settled an item in the other door: the Slack answer that did, or where a tried change went. null when this door settled it. */
  function settledNote(rec: ItemRecord, issue: PeopleIssue | undefined): string | null {
    if (!issue || rec.answeredHere) return null
    if (rec.kind === "uat") return issue.state === "Approved" ? say.settled(issue.id, "approved") : issue.state === "Needs Correction" ? say.settled(issue.id, "sent back to be fixed") : null
    const since = rec.askedAt ?? rec.createdAt
    const answer = recordedAnswers(issue.description).filter((a) => a.source === "slack" && a.applied && a.at !== null && answeredSince(a.at, since)).at(-1)
    return answer ? say.mirrored(answer.who, "in Slack", answerSaid(answer.text)) : null
  }

  /** Spec 6: every Needs-you item has one Slack thread, with the item's link. */
  async function threads(pass: Pass, linked: Map<string, string | null>): Promise<void> {
    for (const rec of readRecords(paths)) {
      if (rec.kind === "request" || rec.state === "Done") continue
      // An item made this pass waits for the next one: the board gives its link then.
      const item = pass.byId.get(rec.itemId)
      if (!item) continue
      // An item made before Wave 2 gets its thread now, except a per-issue Test day item: the one exception to spec 6 (Decisions).
      if (!rec.thread) {
        if (item.groupId === groupOf(pass, "testDay")) continue
        rec.thread = { state: "wanted" }
      }
      try {
        const permalink = threadFor(paths, rec.issue)?.permalink ?? linked.get(rec.issue) ?? null
        if (rec.thread.state === "wanted") {
          const message = slackMessage(threadTarget(paths, rec.issue, permalink), rec.issue, say.onMonday(item.url), true)
          if (message) enqueueSlack(paths, message, pass.now)
          rec.thread = { ...rec.thread, state: "posted" }
          save(rec)
        }
        // The thread's link on the item, once it is known: one write, and again only if it changes.
        if (permalink && rec.thread.permalink !== permalink) {
          await api.setColumns(cfg!.boardId, rec.itemId, { [cfg!.columns.slackThread!]: { url: permalink, text: "Slack thread" } })
          rec.thread = { ...rec.thread, permalink }
          save(rec)
        }
      } catch (error) {
        log.warn("monday Slack thread link not written yet", { issue: rec.issue, item: rec.itemId, error: message(error) })
      }
    }
  }

  /** The other door (spec 6): what a person settled on Monday, said in the item's Slack thread. Nothing when it has none. */
  function mirrorToSlack(rec: ItemRecord, text: string, now: Date): void {
    const message = slackMessage(threadTarget(paths, rec.issue, rec.thread?.permalink ?? null), rec.issue, text, false)
    if (message) enqueueSlack(paths, message, now)
  }

  /**
   * A Test day item made for another product's issue (before Test day kept to
   * one product): archived at once, with nothing said on it. Nobody was asked
   * to do anything there, so there is nothing to close.
   */
  async function dropElsewhere(rec: ItemRecord, pass: Pass): Promise<void> {
    try {
      if (pass.byId.has(rec.itemId)) await api.archiveItem(rec.itemId)
      dropRecord(paths, rec.key)
      log.info("monday Test day item archived: another product's issue", { issue: rec.issue, item: rec.itemId })
    } catch (error) {
      log.warn("monday Test day item not archived yet", { issue: rec.issue, item: rec.itemId, error: message(error) })
    }
  }

  // 4. Archive --------------------------------------------------------------

  async function archive(pass: Pass): Promise<void> {
    const cutoff = pass.now.getTime() - cfg!.archiveAfterDays * DAY
    for (const rec of readRecords(paths)) {
      if (rec.state !== "Done" || !rec.doneAt || Date.parse(rec.doneAt) > cutoff) continue
      if (pass.byId.has(rec.itemId)) await api.archiveItem(rec.itemId)
      dropRecord(paths, rec.key)
    }
  }

  // 5. Replies --------------------------------------------------------------

  async function drain(): Promise<void> {
    const waiting = listNew<MondayReply & { queuedAt: string }>(mondayOutbox(paths))
    if (!waiting.length || !(await allowed())) return
    for (const { key, payload } of waiting) {
      try {
        await api.postUpdate(payload.itemId, toHtml(`${agentLabel}: ${payload.text}`), payload.threadId)
      } catch (error) {
        const stale = deps.now().getTime() - Date.parse(payload.queuedAt) > DAY
        // Refused (the item is gone, say): it would be refused again, and the others go on.
        if (error instanceof MondayRefused || stale) {
          fail(mondayOutbox(paths), key)
          log.error("monday reply given up", { item: payload.itemId, error: message(error) })
        } else {
          log.warn("monday reply not posted yet", { item: payload.itemId, error: message(error) })
        }
        if (error instanceof MondayRefused) continue
        // Out of reach is Monday, not this item: every reply waits for the next loop, in order, and agentd goes on.
        return
      }
      ack(mondayOutbox(paths), key)
      // The board's ✅, beside the words.
      if (payload.like) await api.like(payload.like).catch((error: unknown) => log.warn("monday like failed", { update: payload.like, error: message(error) }))
    }
  }

  function groupIds(groups: MondayBoard["groups"]): Partial<Record<GroupKey, string>> {
    const byTitle = new Map(groups.map((g) => [g.title.trim().toLowerCase(), g.id]))
    const ids: Partial<Record<GroupKey, string>> = {}
    const missing: string[] = []
    for (const [key, title] of Object.entries(cfg!.groups) as Array<[GroupKey, string | undefined]>) {
      // A Wave 2 group not in config (its type allows none; JSON config never gives one).
      if (!title) continue
      // With the Requests board, this board keeps no request groups.
      if (cfg!.requests && (key === "requests" || key === "working")) continue
      const id = byTitle.get(title.trim().toLowerCase())
      if (id) ids[key] = id
      else missing.push(`"${title}"`)
    }
    if (missing.length) throw new Error(`monday: board ${cfg!.boardId} has no group named ${missing.join(", ")} (bridges.monday.groups)`)
    return ids
  }

  /** The morning digest (spec 6, D5): once a working day, from 08:00 until noon, in #polads-questions. */
  async function digest(pass: Pass, requests: RequestsPass | null): Promise<void> {
    const d = cfg!.digest
    if (!d.enabled) return
    const day = digestDue(pass.now, deps.config.queue.timeZone, d, readDigestDay(paths))
    if (!day) return
    // Written before the post: a restart loses one digest at worst, and never posts two.
    writeDigestDay(paths, day)
    const open = readRecords(paths).filter((r) => r.kind !== "request" && r.state !== "Done" && pass.byId.has(r.itemId))
    const NOUNS: Partial<Record<GroupKey, [string, string]>> = {
      needsYou: ["decision", "decisions"],
      approvePlan: ["plan to approve", "plans to approve"],
      looks: ["look", "looks"],
      testDay: ["change to try on test day", "changes to try on test day"],
    }
    const groups: DigestGroup[] = []
    for (const [key, [one, many]] of Object.entries(NOUNS) as Array<[GroupKey, [string, string]]>) {
      const id = pass.groups[key]
      if (!id) continue
      const title = pass.board.groups.find((g) => g.id === id)?.title ?? key
      const items = open.map((r) => pass.byId.get(r.itemId)!).filter((i) => i.groupId === id).map((i) => ({ name: i.name, url: i.url }))
      groups.push({ title, one, many, items, testDay: key === "testDay" })
    }
    const reqs = requests ? readRecords(paths).filter((r) => r.kind === "request" && requests.byId.has(r.itemId)) : null
    const text = digestText(groups, {
      testDay: deps.testDayLine?.() ?? null,
      requests: reqs ? { active: reqs.filter((r) => r.stage && requestGroup(r.stage) === "active").length, readyToTest: reqs.filter((r) => r.stage === "Ready to test").length } : null,
    })
    enqueueSlack(paths, { kind: "post", channel: "questions", text }, pass.now)
    appendLedger(paths, { type: "digest.posted", day }, pass.now)
  }

  /** The Requests board, read once a poll: its items, and its three groups found by title. */
  async function readRequests(now: Date, since: Date): Promise<RequestsPass> {
    const r = cfg!.requests!
    const board = await api.readBoard(r.boardId, Object.values(r.columns), { columnIds: [], since })
    const byTitle = new Map(board.groups.map((g) => [g.title.trim().toLowerCase(), g.id]))
    const find = (title: string) => {
      const id = byTitle.get(title.trim().toLowerCase())
      if (!id) throw new Error(`monday: board ${r.boardId} has no group named "${title}" (bridges.monday.requests.groups)`)
      return id
    }
    return { board, groups: { active: find(r.groups.active), released: find(r.groups.released), closed: find(r.groups.closed) }, byId: new Map(board.items.map((i) => [i.id, i])), now }
  }

  return {
    async sync() {
      if (!(await allowed())) return
      const now = deps.now()
      await readLimit(now)
      const since = readCursor(paths) ?? new Date(now.getTime() - 2 * OVERLAP_MS)
      const board = await api.readBoard(cfg.boardId, Object.values(cfg.columns).filter((c): c is string => Boolean(c)), { columnIds: [cfg.columns.answer], since: new Date(since.getTime() - OVERLAP_MS) })
      const pass: Pass = { board, groups: groupIds(board.groups), byId: new Map(board.items.map((i) => [i.id, i])), now }
      // Each part on its own: Linear down stops the needs, not the replies.
      const part = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
        try {
          return await fn()
        } catch (error) {
          log.error(`monday ${name} failed`, { error: message(error) })
          return null
        }
      }
      // The Requests board on its own read: a problem there stops only the requests.
      const asked = requestsBoard ? await part("requests board", () => readRequests(now, since)) : null
      await part("words", () => hearWords(pass))
      if (asked) await part("request words", () => hearWords({ board: asked.board, groups: {}, byId: asked.byId, now }))
      if (!requestsBoard) await part("requests", () => requests(pass))
      else {
        // New asks come to the Requests board. Those still on this one stay in step until the migration moves them.
        if (asked) await part("requests", () => requestsBoard.fromBoard(asked))
        if (asked) await part("slack requests", () => requestsBoard.adopt(asked))
        await part("old requests", () => updateRequests(pass))
      }
      const linked = await part("needs", () => needs(pass))
      // Not without the needs: an item whose issue has a thread on another mini would get a second one.
      if (doors && linked) await part("threads", () => threads(pass, linked))
      if (requestsBoard && asked) await part("request stages", () => requestsBoard.update(asked))
      await part("digest", () => digest(pass, asked))
      await part("archive", () => archive(pass))
      if (requestsBoard && asked) await part("request archive", () => requestsBoard.archive(asked))
      await part("replies", drain)
    },
    drain,
    pollEveryMs,
  }
}
