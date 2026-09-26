/**
 * An in-memory Monday account for the bridge's tests: boards with their
 * groups, items that move between them, connected items, and an activity log
 * of column changes. It records every call as the Monday API would take it.
 * Made-up people and ids, except today's board and its column ids, which are
 * public since STEP-3289.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew } from "../../fsq.ts"
import type { Logger } from "../../log.ts"
import type { OutboxMessage } from "../../outbox.ts"
import { saveThread } from "../../threads.ts"
import type { TrackerIssue } from "../../tracker.ts"
import { fakeTracker } from "../../__tests__/fakes.ts"
import { createMondayBridge } from "../bridge.ts"
import { MondayRefused, type ColumnChange, type MondayApi, type MondayColumn, type MondayItem } from "../client.ts"
import type { PeopleIssue, PeopleView } from "../people.ts"

export const BOARD = "5104953028"
export const AGENT = "900"
/** The Needs-you board's eight columns. */
export const NEEDS_COLUMNS = {
  person: "multiple_person_mm7hcr31", kind: "color_mm7hx8zq", state: "color_mm7hvyyt", agent: "dropdown_mm7hmyqg",
  linear: "link_mm7hz1nj", pr: "link_mm7h42x", due: "date_mm7hfrdv", answer: "long_text_mm7hzj39",
}
export const GROUPS = [
  { id: "g_needs", title: "Needs you" }, { id: "g_test", title: "Test day" }, { id: "g_req", title: "Requests" },
  { id: "g_work", title: "Agents working on" }, { id: "g_done", title: "Done" },
]
export const T0 = new Date("2026-09-25T09:00:00.000Z")

const pulse = (boardId: string, id: string) => `https://step.monday.com/boards/${boardId}/pulses/${id}`

/** An in-memory account that records every call, as the Monday API would take it. `boards` maps each board to its groups. */
export function fakeMonday(
  me = { id: AGENT, name: "PolAds agents", isAdmin: false },
  dailyLimit: number | null | Error = null,
  boards: Record<string, Array<{ id: string; title: string }>> = { [BOARD]: GROUPS },
) {
  const items = new Map<string, MondayItem>()
  /** Which board each item is on. */
  const boardOf = new Map<string, string>()
  const columns: Record<string, MondayColumn[]> = {}
  const logs: ColumnChange[] = []
  const calls: Array<{ method: string; args: unknown[] }> = []
  /** Items Monday cannot be reached for, as in an outage: their updates fail, and are not refused. */
  const down = new Set<string>()
  /** Calls Monday cannot be reached for at all, by method. */
  const broken = new Set<string>()
  let next = 1000
  let clock = T0
  const record = (method: string, args: unknown[]) => calls.push({ method, args })
  const find = (id: string) => {
    const hit = items.get(id)
    // As Monday answers for an item that is gone: a GraphQL error.
    if (!hit) throw new MondayRefused(`Monday: Item ${id} not found`)
    return hit
  }
  const setValues = (item: MondayItem, values: Record<string, unknown>) => {
    for (const [id, v] of Object.entries(values)) {
      // A text column takes a plain string; a connect-boards column takes { item_ids }.
      if (typeof v === "string") {
        item.columns[id] = { text: v, value: JSON.stringify(v) }
        continue
      }
      const value = (v ?? {}) as { label?: string; labels?: string[]; url?: string; text?: string; date?: string; item_ids?: number[] }
      if (Array.isArray(value.item_ids)) {
        item.columns[id] = { text: null, value: JSON.stringify(v), linked: value.item_ids.map(String) }
        continue
      }
      item.columns[id] = { text: value.label ?? value.labels?.join(", ") ?? value.text ?? value.date ?? null, value: JSON.stringify(v) }
    }
  }
  const api: MondayApi = {
    async me() {
      record("me", [])
      return me
    },
    async readBoard(boardId, columnIds, watch) {
      record("readBoard", [boardId, columnIds, watch.columnIds, watch.since.toISOString()])
      const groups = boards[boardId]
      if (!groups) throw new MondayRefused(`Monday: no board ${boardId}, or the token's user cannot see it`)
      const on = [...items.values()].filter((i) => boardOf.get(i.id) === boardId)
      const changes = logs.filter((l) => boardOf.get(l.itemId) === boardId && watch.columnIds.includes(l.columnId) && l.at >= watch.since.toISOString())
      return { groups, items: structuredClone(on), changes: structuredClone(changes) }
    },
    async dailyLimit() {
      record("dailyLimit", [])
      if (dailyLimit instanceof Error) throw dailyLimit
      return dailyLimit
    },
    async createItem(boardId, groupId, name, values) {
      record("createItem", [boardId, groupId, name, values])
      const id = String(next++)
      const item: MondayItem = { id, name, url: pulse(boardId, id), groupId, creatorId: me.id, createdAt: clock.toISOString(), columns: {}, updates: [] }
      setValues(item, values)
      items.set(id, item)
      boardOf.set(id, boardId)
      return id
    },
    async setColumns(boardId, itemId, values) {
      record("setColumns", [boardId, itemId, values])
      if (broken.has("setColumns")) throw new Error("Monday: gave up after 3 attempts (status 503)")
      setValues(find(itemId), values)
    },
    async moveItem(itemId, groupId) {
      record("moveItem", [itemId, groupId])
      find(itemId).groupId = groupId
    },
    async postUpdate(itemId, html, threadId = null) {
      record("postUpdate", [itemId, html, threadId])
      if (down.has(itemId)) throw new Error("Monday: gave up after 3 attempts (status 503)")
      const id = `u${next++}`
      find(itemId).updates.push({ id, creatorId: me.id, text: html, createdAt: clock.toISOString(), threadId: threadId ?? id })
      return id
    },
    async like(updateId) {
      record("like", [updateId])
    },
    async archiveItem(itemId) {
      record("archiveItem", [itemId])
      items.delete(itemId)
    },
    async boardColumns(boardId) {
      record("boardColumns", [boardId])
      return structuredClone(columns[boardId] ?? [])
    },
    async moveItemToBoard(boardId, groupId, itemId, mapping) {
      record("moveItemToBoard", [boardId, groupId, itemId, mapping])
      const item = find(itemId)
      const moved: MondayItem["columns"] = {}
      for (const { source, target } of mapping) if (target && item.columns[source]) moved[target] = item.columns[source]
      item.columns = moved
      item.groupId = groupId
      item.url = pulse(boardId, itemId)
      boardOf.set(itemId, boardId)
    },
  }
  return {
    api,
    items,
    calls,
    down,
    broken,
    called: (method: string) => calls.filter((c) => c.method === method).map((c) => c.args),
    writes: () => calls.filter((c) => !["me", "readBoard", "dailyLimit", "boardColumns"].includes(c.method)),
    at: (t: Date) => {
      clock = t
    },
    /** Which board an item is on. */
    boardOf: (itemId: string) => boardOf.get(itemId),
    /** What boardColumns answers for a board. */
    columnsOf(boardId: string, list: MondayColumn[]) {
      columns[boardId] = structuredClone(list)
    },
    /** A connect-boards column linking these items. */
    link(itemId: string, columnId: string, ids: string[]) {
      find(itemId).columns[columnId] = { text: null, value: null, linked: [...ids] }
    },
    /** A person's update on an item (a reply when threadId is given). */
    says(itemId: string, userId: string, text: string, threadId?: string) {
      const id = `p${next++}`
      find(itemId).updates.push({ id, creatorId: userId, text, createdAt: clock.toISOString(), threadId: threadId ?? id })
      return id
    },
    /** A person's new item in a group, with an optional first update. */
    request(userId: string, name: string, detail?: string, groupId = "g_req", boardId = BOARD) {
      const id = String(next++)
      items.set(id, { id, name, url: pulse(boardId, id), groupId, creatorId: userId, createdAt: clock.toISOString(), columns: {}, updates: [] })
      boardOf.set(id, boardId)
      if (detail) this.says(id, userId, detail)
      return id
    },
    /** A person changing a column, the Answer column unless another is named, as the activity log records it. */
    answers(itemId: string, userId: string, text: string, columnId: string = NEEDS_COLUMNS.answer) {
      const id = `log${next++}`
      logs.push({ id, itemId, userId, text, at: clock.toISOString(), columnId })
      return id
    },
    item: (name: RegExp) => [...items.values()].find((i) => name.test(i.name)),
  }
}

/**
 * The people's view of the fake tracker's issues, with the fields only
 * Linear's people-facing reads carry. `parents` maps a sub-issue to its parent.
 */
export function fakePeople(issues: Map<string, TrackerIssue>, extra: Record<string, Partial<PeopleIssue>> = {}, parents: Record<string, string> = {}) {
  const types: Record<string, string> = { Released: "completed", Canceled: "canceled", Duplicate: "duplicate", Triage: "triage" }
  const view = (i: TrackerIssue): PeopleIssue => ({
    id: i.id, uuid: i.uuid, title: i.title, description: i.description, url: i.url, state: i.state, stateType: types[i.state] ?? "started",
    labels: i.labels, owner: null, requester: null, dueDate: null, prUrl: null, uatSteps: null,
    parent: parents[i.id] ?? null, slackThread: null, project: null, ...extra[i.id],
  })
  const parentOf = new Map(Object.entries(parents))
  const byUuid = (uuid: string) => [...issues.values()].find((i) => i.uuid === uuid)
  const adopted: Array<[string, string, number]> = []
  const people: PeopleView = {
    async needsYou() {
      return [...issues.values()]
        .filter((i) => !["Released", "Canceled"].includes(i.state))
        .filter((i) => i.labels.includes("needs-human") || (i.state === "On hold" && (i.labels.includes("human-todo") || i.labels.includes("awaiting-answer"))))
        .map(view)
    },
    async waitingForUat() {
      return [...issues.values()].filter((i) => i.state === "Waiting for UAT").map(view)
    },
    async byIdentifiers(ids) {
      return ids.flatMap((id) => (issues.has(id) ? [view(issues.get(id)!)] : []))
    },
    async adoptFix(child, parent, priority) {
      adopted.push([child, parent, priority])
      const c = byUuid(child)
      const p = byUuid(parent)
      if (c && p) parentOf.set(c.id, p.id)
    },
    async slackRequests() {
      return [...issues.values()]
        .filter((i) => i.labels.includes("intake/slack") && !i.labels.includes("intake/monday") && !["Released", "Canceled", "Duplicate"].includes(i.state) && !parentOf.has(i.id))
        .map(view)
    },
    async childrenOf(anchorUuids) {
      const anchors = [...issues.values()].filter((i) => anchorUuids.includes(i.uuid)).map((i) => i.id)
      return new Map(anchors.map((a) => [a, [...parentOf].filter(([, p]) => p === a).flatMap(([c]) => (issues.has(c) ? [view(issues.get(c)!)] : []))]))
    },
    async parentOf(id) {
      const parent = issues.get(parentOf.get(id) ?? "")
      if (!parent) return null
      const fixes = [...parentOf].filter(([, p]) => p === parent.id).map(([c]) => issues.get(c)!)
      const openFixes = fixes.filter((f) => f.title.startsWith("UAT fix:") && !["Approved", "Released", "Canceled"].includes(f.state)).map((f) => f.id)
      return { id: parent.id, state: parent.state, openFixes }
    },
  }
  return { people, adopted }
}

/** Wave 2's Needs-you board: its six groups, and the two a board keeps until the Requests board takes them. */
export const LAYOUT = [
  { id: "g_needs", title: "Decide" }, { id: "g_plan", title: "Approve plan" }, { id: "g_looks", title: "Looks good?" }, { id: "g_test", title: "Test day" },
  { id: "g_fyi", title: "FYI" }, { id: "g_done", title: "Done" }, { id: "g_req", title: "Requests" }, { id: "g_work", title: "Agents working on" },
]
export const THREAD = "https://acme.slack.com/archives/CQ/p1790000000000100"
/** The Requests board (Wave 2): its three groups and nine columns, made up. */
export const REQ = "777"
export const REQUEST_GROUPS = [{ id: "r_active", title: "Active" }, { id: "r_released", title: "Released" }, { id: "r_closed", title: "Declined and on hold" }]
export const REQUEST_COLUMNS = {
  requester: "r_person", type: "r_type", class: "r_class", size: "r_size", stage: "r_stage", progress: "r_progress", targetWeek: "r_week", linear: "r_linear", slackThread: "r_thread",
}

/**
 * A bridge on the Wave 2 layout (made-up people Ada and Ben), or on today's
 * with newLayout false: the new groups and columns switch on only with their
 * config.
 */
export function doorsSetup(
  seed: TrackerIssue[] = [],
  opts: {
    extra?: Record<string, Partial<PeopleIssue>>
    parents?: Record<string, string>
    newLayout?: boolean
    /** The Requests board configured (Task 7): the Needs-you board then keeps no request groups, unless keepOldGroups. */
    requests?: boolean
    keepOldGroups?: boolean
    requestsBoardMissing?: boolean
    dailyLimit?: number | null
    /** When the clock starts (T0 unless named). */
    start?: Date
    /** The morning digest switched on (go-live). */
    digest?: boolean
    /** Wave 3's test-day line for the digest. */
    testDayLine?: () => string | null
  } = {},
) {
  const newLayout = opts.newLayout ?? true
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-doors-")))
  const config = ConfigSchema.parse({
    mini: "eve", repo: { path: "/r", product: "polads" }, pluginRoot: "/p", slack: { allowedUsers: ["UADA", "UBEN", "UCY"] },
    bridges: {
      monday: {
        enabled: true,
        people: [{ id: "111", name: "Ada", slackId: "UADA" }, { id: "222", name: "Ben", slackId: "UBEN" }],
        defaultPerson: "111",
        ...(newLayout
          ? { columns: { recommendation: "col_rec", request: "col_request", slackThread: "col_thread" }, groups: { needsYou: "Decide", approvePlan: "Approve plan", looks: "Looks good?", fyi: "FYI" } }
          : {}),
        ...(opts.requests ? { requests: { boardId: REQ, columns: REQUEST_COLUMNS } } : {}),
        ...(opts.digest ? { digest: { enabled: true } } : {}),
      },
    },
  })
  const fake = fakeTracker(seed)
  const needsBoard = opts.requests && !opts.keepOldGroups ? LAYOUT.filter((g) => g.id !== "g_req" && g.id !== "g_work") : LAYOUT
  const monday = fakeMonday(undefined, opts.dailyLimit ?? null, {
    [BOARD]: newLayout ? needsBoard : GROUPS,
    ...(opts.requests && !opts.requestsBoardMissing ? { [REQ]: REQUEST_GROUPS } : {}),
  })
  const { people } = fakePeople(fake.issues, opts.extra, opts.parents)
  const warned: string[] = []
  const log: Logger = { info: () => {}, warn: (m) => warned.push(m), error: (m) => warned.push(m) }
  let now = opts.start ?? T0
  monday.at(now)
  const bridge = createMondayBridge({ paths, config, log, now: () => now, api: monday.api, tracker: fake.tracker, people, ...(opts.testDayLine ? { testDayLine: opts.testDayLine } : {}) })
  const later = (minutes: number) => {
    now = new Date(now.getTime() + minutes * 60_000)
    monday.at(now)
  }
  const slack = () => listNew<OutboxMessage & { queuedAt: string }>(paths.outbox).map((e) => e.payload)
  const texts = (itemId: string) => monday.items.get(itemId)?.updates.map((u) => u.text) ?? []
  return { paths, config, fake, monday, people, bridge, later, slack, texts, warned }
}

/** The issue's own Slack thread on this mini, as send.ts saves it. */
export const ownThread = (paths: ReturnType<typeof agentPaths>, issueId: string, askedAt: string | null = null) =>
  saveThread(paths, { issue: issueId, channelId: "CQ", ts: "1790000000.000100", permalink: THREAD, createdAt: T0.toISOString(), lastQuestionAt: askedAt })
