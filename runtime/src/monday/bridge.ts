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
 *     while the issue is On hold, and Done once it is released.
 *  3. Needs you and Test day. One item per Linear id: this mini's open
 *     decisions, needs-human, and a question or to-do an issue is On hold
 *     for, in Needs you; this mini's product's Waiting for UAT in Test day,
 *     with the steps to check (another product's is archived). When Linear
 *     no longer needs a person, the item moves to Done.
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
import { lastQuestion } from "../outbox.ts"
import { prRef } from "../plain.ts"
import { openDecisions, questionText, type Decision } from "../agentd/decisions.ts"
import { truncateChars } from "../slack/text.ts"
import { extractAcceptanceCriteria, isIssueGone, type Tracker } from "../tracker.ts"
import { MondayRefused, type MondayApi, type MondayBoard, type MondayItem } from "./client.ts"
import type { PeopleIssue, PeopleView } from "./people.ts"
import { aboutText, needBody, needKind, needName, plainText, quote, requestIssue, say, stableUuid, toHtml, uatBody, uatName, type MondayKind, type NeedSource } from "./render.ts"
import { routeWords, type Words } from "./route.ts"
import { dropRecord, enqueueMonday, mondayOutbox, readCursor, readRecords, saveRecord, writeCursor, type ItemRecord, type MondayReply, type MondayState } from "./store.ts"

export interface MondayBridgeDeps {
  paths: AgentPaths
  config: AgentConfig
  log: Logger
  now: () => Date
  api: MondayApi
  tracker: Tracker
  people: PeopleView
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

type GroupKey = "needsYou" | "testDay" | "requests" | "working" | "done"

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
}

interface Pass {
  board: MondayBoard
  groups: Record<GroupKey, string>
  byId: Map<string, MondayItem>
  now: Date
}

type Person = { id: string; name: string }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const byCreated = <T extends { createdAt: string }>(a: T, b: T) => a.createdAt.localeCompare(b.createdAt)
const capitalised = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

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
    // One read a poll, within apiShare of what the whole account may call in a day.
    return Math.max(floor, Math.ceil(DAY / MINUTE / (limit.calls * cfg!.apiShare)) * MINUTE)
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
      if (item.groupId !== pass.groups.done) await api.moveItem(item.id, pass.groups.done)
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
    const routed = await routeWords({ paths, tracker, mini: deps.config.mini }, { issue: rec.issue, request: rec.kind === "request", itemId: item.id, who, words, now: pass.now })
    mark(rec, words.id)
    // agentd answers an instruction itself, once it has acted (agentd/instructions.ts).
    if (routed.to === "issue") reply(item.id, words, say.answered(who.name, routed.movedTo), pass.now)
    // Words from before the newest question: the item still needs them, for that one.
    if (routed.to === "newer-question") {
      reply(item.id, words, say.newerQuestion(who.name, routed.question), pass.now)
      return
    }
    // A request's State follows its issue in Linear (requests below).
    if (rec.kind !== "request") await after("state", rec, () => setState(rec, "Waiting on agent"))
  }

  /**
   * A person's PASS or FAIL on a Test day item, written as the PolAds
   * review-uat skill writes a person's verdict (its Step 10, and
   * references/linear-io.md). PASS: a comment naming them, Approved, and for
   * a UAT fix its parent back to Agent UAT once none of its fixes is open.
   * FAIL: a UAT fix sub-issue with what they saw (Ready, bug, the product,
   * agent, the parent's priority), a comment naming it, Needs Correction.
   */
  async function verdict(rec: ItemRecord, item: MondayItem, who: Person, words: Words, pass: Pass): Promise<void> {
    const m = /^\s*(pass|fail)\b[\s:.,!-]*/i.exec(words.text)
    if (!m) {
      reply(item.id, words, say.onlyVerdicts(), pass.now, false)
      return mark(rec, words.id)
    }
    const current = await tracker.readIssue(rec.issue)
    if (current.state !== "Waiting for UAT") {
      reply(item.id, words, say.notWaiting(), pass.now, false)
      return mark(rec, words.id)
    }
    const seen = words.text.slice(m[0].length).trim()
    const where = words.permalink ?? item.url
    if (m[1].toLowerCase() === "pass") {
      await tracker.comment(rec.issue, `UAT PASS from ${who.name} on the Monday board (${where})${seen ? `: ${seen}` : "."}`)
      await tracker.updateIssue(rec.issue, { state: "Approved" })
      mark(rec, words.id)
      if (current.title.startsWith("UAT fix:")) await after("closing the loop", rec, () => closeTheLoop(current.id, who))
      reply(item.id, words, say.passed(who.name), pass.now)
    } else {
      // Named by the person's update, so a retry after a crash finds this issue rather than filing a second.
      const sub = await tracker.createIssue({
        title: truncateChars(`UAT fix: ${plainText(current.title)}`, 80),
        description: [
          `${who.name} tried ${current.id} on test day, and it did not work. What they saw, as they wrote it on the Monday board:`,
          "",
          quote(seen || "(no details given)"),
          "",
          `Part of ${current.id}. Monday: ${where}`,
          "",
          "## Acceptance criteria",
          "",
          `- [ ] What ${who.name} saw no longer happens, and ${current.id}'s own acceptance criteria hold.`,
        ].join("\n"),
        labels: ["bug", deps.config.repo.product, "agent"],
        state: "Ready",
        clientId: stableUuid(`monday-uat-fail:${words.id}`),
      })
      await people.adoptFix(sub.uuid, current.uuid, current.priority)
      await tracker.comment(rec.issue, `UAT FAIL from ${who.name} on the Monday board (${where}). The fix is tracked in ${sub.id}.`)
      await tracker.updateIssue(rec.issue, { state: "Needs Correction" })
      mark(rec, words.id)
      reply(item.id, words, say.failed(who.name, sub.id), pass.now)
    }
    appendLedger(paths, { type: "uat.verdict", issue: rec.issue, verdict: m[1].toLowerCase(), by: who.name, via: "monday" }, pass.now)
  }

  /** review-uat's "Closing the loop": the parent of an approved UAT fix goes back to Agent UAT once none of its fixes is open. */
  async function closeTheLoop(fix: string, who: Person): Promise<void> {
    const parent = await people.parentOf(fix)
    if (!parent || parent.state !== "Needs Correction" || parent.openFixes.length) return
    await tracker.comment(parent.id, `${fix} is fixed and approved (${who.name}, on the Monday board), so ${parent.id} goes back for its review against its full acceptance criteria.`)
    await tracker.updateIssue(parent.id, { state: "Agent UAT" })
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
    if (item.groupId !== pass.groups.working) await api.moveItem(item.id, pass.groups.working)
    rec.linked = true
    rec.state = "Waiting on agent"
    save(rec)
    const who = item.creatorId ? person.get(item.creatorId) : undefined
    if (who) reply(item.id, null, say.filed(who.name, issue.id), pass.now)
  }

  async function fileRequest(item: MondayItem, who: Person, pass: Pass): Promise<void> {
    const details = item.updates.filter((u) => u.creatorId === item.creatorId).sort(byCreated)
    const input = requestIssue(item, who, details.map((u) => u.text), { product: deps.config.repo.product, label: cfg!.requestLabel })
    const filed = await tracker.createIssue(input)
    if (!filed.labels.includes(cfg!.requestLabel)) {
      once("request-label", () => log.warn(`Linear has no label ${cfg!.requestLabel}, so requests from the board are filed without it (runbook, The Monday board)`))
    }
    // Written down before the board is touched: from here on the item is this issue's, whatever fails next.
    const rec: ItemRecord = {
      key: `request-${item.id}`, kind: "request", issue: filed.id, itemId: item.id, state: "Needs you", bodyHash: null,
      createdAt: pass.now.toISOString(), doneAt: null, handled: details.map((u) => u.id), linked: false,
    }
    save(rec)
    appendLedger(paths, { type: "intake.filed", issue: filed.id, via: "monday" }, pass.now)
    await tracker.attachLink(filed.id, item.url, "Monday request").catch((error: unknown) => {
      log.warn("monday request not linked from Linear", { issue: filed.id, error: message(error) })
    })
    await link(rec, item, filed, pass)
  }

  async function requests(pass: Pass): Promise<void> {
    const tracked = new Set(readRecords(paths).map((r) => r.itemId))
    for (const item of pass.board.items) {
      if (item.groupId !== pass.groups.requests || tracked.has(item.id)) continue
      const who = item.creatorId ? person.get(item.creatorId) : undefined
      if (!who) {
        once(`request:${item.id}`, () => log.info("monday request from someone not on bridges.monday.people, left alone", { item: item.id }))
        continue
      }
      // One at a time: a request Linear refuses waits for the next poll, and the others go on.
      try {
        await fileRequest(item, who, pass)
      } catch (error) {
        log.warn("monday request not filed yet", { item: item.id, error: message(error) })
      }
    }

    const open = readRecords(paths).filter((r) => r.kind === "request" && r.state !== "Done")
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

  function decisionNeed(d: Decision, issue: PeopleIssue): Need {
    const timeZone = deps.config.queue.timeZone
    return {
      key: `needs-${issue.id}`, kind: "needs", group: "needsYou", issue,
      name: needName("decision", issue.title, agentLabel),
      body: needBody("decision", { title: issue.title, agent: agentLabel, question: questionText(d, timeZone, "monday") }),
      mondayKind: needKind("decision"), agent: agentLabel, pr: d.url || issue.prUrl, due: dateIn(new Date(d.deadlineAt), timeZone),
    }
  }

  function linearNeed(issue: PeopleIssue): Need {
    const parked = issue.state === "On hold"
    const source: NeedSource =
      parked && issue.labels.includes("awaiting-answer") ? "awaiting-answer" : parked && issue.labels.includes("human-todo") ? "human-todo" : "needs-human"
    const agent = agentFor(issue)
    const question = source === "needs-human" ? null : (lastQuestion(paths, issue.id)?.text ?? null)
    return {
      key: `needs-${issue.id}`, kind: "needs", group: "needsYou", issue,
      name: needName(source, issue.title, agent),
      body: needBody(source, { title: issue.title, agent, question, about: aboutText(issue.description) }),
      mondayKind: needKind(source), agent, pr: issue.prUrl, due: issue.dueDate,
    }
  }

  function uatNeed(issue: PeopleIssue): Need {
    const steps = issue.uatSteps ?? extractAcceptanceCriteria(issue.description)
    return {
      key: `uat-${issue.id}`, kind: "uat", group: "testDay", issue,
      name: uatName(issue.title), body: uatBody(issue.title, steps ? plainText(steps) : null),
      mondayKind: "Check", agent: agentFor(issue), pr: issue.prUrl, due: issue.dueDate,
    }
  }

  async function upsert(need: Need, found: ItemRecord | null, pass: Pass): Promise<void> {
    const hash = createHash("sha256").update(`${need.name}\n${need.body}`).digest("hex").slice(0, 16)
    const group = pass.groups[need.group]
    let rec = found
    if (rec && !pass.byId.has(rec.itemId)) {
      // A person deleted or archived the item: it is not put back while this need lasts. A later need gets a new one.
      if (rec.state !== "Done") return
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
      }
      save(rec)
      if (!adopted) appendLedger(paths, { type: "monday.item", issue: need.issue.id, kind: need.kind }, pass.now)
    } else if (rec.bodyHash !== hash || rec.state === "Done") {
      // A new question, or a need back after it was settled: the item asks again.
      await api.setColumns(cfg!.boardId, rec.itemId, columnsFor(need, false))
      if (pass.byId.get(rec.itemId)?.groupId !== group) await api.moveItem(rec.itemId, group)
    }
    if (rec.bodyHash === hash && rec.state !== "Done") return
    await api.postUpdate(rec.itemId, toHtml(need.body))
    rec.bodyHash = hash
    rec.state = "Needs you"
    rec.doneAt = null
    save(rec)
  }

  async function needs(pass: Pass): Promise<void> {
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

    const wanted = new Map<string, Need>()
    for (const [id, d] of decisions) {
      const issue = known.get(id)
      if (issue) wanted.set(`needs-${id}`, decisionNeed(d, issue))
    }
    for (const issue of linear) if (!wanted.has(`needs-${issue.id}`)) wanted.set(`needs-${issue.id}`, linearNeed(issue))
    for (const issue of uat) wanted.set(`uat-${issue.id}`, uatNeed(issue))

    const recs = readRecords(paths).filter((r) => r.kind !== "request")
    const byKey = new Map(recs.map((r) => [r.key, r]))
    for (const need of wanted.values()) {
      try {
        await upsert(need, byKey.get(need.key) ?? null, pass)
      } catch (error) {
        log.error("monday item not written", { key: need.key, error: message(error) })
      }
    }
    for (const rec of recs) {
      if (elsewhere.has(rec.key)) await dropElsewhere(rec, pass)
      else if (!wanted.has(rec.key) && rec.state !== "Done") await resolve(rec, pass, null)
    }
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

  function groupIds(groups: MondayBoard["groups"]): Record<GroupKey, string> {
    const byTitle = new Map(groups.map((g) => [g.title.trim().toLowerCase(), g.id]))
    const ids = {} as Record<GroupKey, string>
    const missing: string[] = []
    for (const [key, title] of Object.entries(cfg!.groups) as Array<[GroupKey, string]>) {
      const id = byTitle.get(title.trim().toLowerCase())
      if (id) ids[key] = id
      else missing.push(`"${title}"`)
    }
    if (missing.length) throw new Error(`monday: board ${cfg!.boardId} has no group named ${missing.join(", ")} (bridges.monday.groups)`)
    return ids
  }

  return {
    async sync() {
      if (!(await allowed())) return
      const now = deps.now()
      await readLimit(now)
      const since = readCursor(paths) ?? new Date(now.getTime() - 2 * OVERLAP_MS)
      const board = await api.readBoard(cfg.boardId, Object.values(cfg.columns), { columnId: cfg.columns.answer, since: new Date(since.getTime() - OVERLAP_MS) })
      const pass: Pass = { board, groups: groupIds(board.groups), byId: new Map(board.items.map((i) => [i.id, i])), now }
      // Each part on its own: Linear down stops the needs, not the replies.
      const part = async (name: string, fn: () => Promise<void>) => {
        try {
          await fn()
        } catch (error) {
          log.error(`monday ${name} failed`, { error: message(error) })
        }
      }
      await part("words", () => hearWords(pass))
      await part("requests", () => requests(pass))
      await part("needs", () => needs(pass))
      await part("archive", () => archive(pass))
      await part("replies", drain)
    },
    drain,
    pollEveryMs,
  }
}
