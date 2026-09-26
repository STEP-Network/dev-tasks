/**
 * The Requests board (Wave 2, spec 4 and 6): one item per ask. A person's new
 * item in Active becomes a Linear Triage issue, the request's anchor. Each
 * poll brings every request up to date from its anchor and the anchor's
 * tasks: its Stage, Progress, Class, Type, Size, Target week, Linear and
 * Slack thread columns, and its group. A column is written again only when
 * Linear changes it, so a person's own edit stands. Each stage change is said
 * once, on the item and in the request's Slack thread. A released or
 * declined request is archived releasedDays later. A person's own change of
 * the Class column changes the request's class in Linear, a lowering through
 * the answer recorder's account (D1, hearClass).
 *
 * Every Slack ask gets its item here too (spec 4, Task 8): each open,
 * parentless intake/slack issue, whichever mini filed it. The poll after its
 * item is made, Linear links the item and the ask's thread is told where it is.
 */

import type { AgentConfig, AgentPaths } from "../config.ts"
import { changeClass, NeedsRecorder } from "../lower.ts"
import { appendLedger, type Logger } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import { isIssueGone, type ApprovalClass, type Tracker } from "../tracker.ts"
import type { ColumnChange, MondayApi, MondayBoard, MondayItem } from "./client.ts"
import type { LinearRequest, PeopleIssue, PeopleView } from "./people.ts"
import { INTAKE_SLACK, slackAskerOf, truncateChars } from "../slack/text.ts"
import { aboutText, requestIssue, say } from "./render.ts"
import { classOf, progressText, requestGroup, requestStage, typeOf, weekOf, workDone, type RequestWork, type Stage } from "./stage.ts"
import { dropRecord, readRecords, saveRecord, type ItemRecord } from "./store.ts"
import { slackThreadOf } from "./threads.ts"

export interface RequestsDeps {
  paths: AgentPaths
  config: AgentConfig
  log: Logger
  api: MondayApi
  tracker: Tracker
  people: PeopleView
  /** The bridge's own reply on an item, posted with the board's next replies. */
  reply(itemId: string, text: string, now: Date): void
  /** Runs fn once while agentd runs: a note that would repeat every poll. */
  once(key: string, fn: () => void): void
  /** The answer recorder's Linear transport, read when a person's lowering comes: null without its key (D1). */
  recorder?: () => LinearRequest | null
}

export interface RequestsPass {
  board: MondayBoard
  groups: Record<"active" | "released" | "closed", string>
  byId: Map<string, MondayItem>
  now: Date
}

type Person = { id: string; name: string }

const DAY = 86_400_000
/** The Class column's labels. */
const CLASSES = new Map<string, ApprovalClass>([["auto", "auto"], ["look", "look"], ["try", "try"]])
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const byCreated = <T extends { createdAt: string }>(a: T, b: T) => a.createdAt.localeCompare(b.createdAt)

/** The URL a link column holds, from its value. */
function linkUrl(column: { value: string | null } | undefined): string | null {
  try {
    const url = (JSON.parse(column?.value ?? "null") as { url?: unknown } | null)?.url
    return typeof url === "string" ? url : null
  } catch {
    return null
  }
}

/**
 * A person's new item as a Linear Triage issue, on either board: written down
 * before the board is touched, so from then on the item is that issue's
 * whatever fails next, and linked both ways. `link` writes the board's side.
 */
export async function fileRequest(
  deps: Pick<RequestsDeps, "paths" | "config" | "log" | "tracker" | "once">,
  item: MondayItem,
  who: Person,
  now: Date,
  link: (rec: ItemRecord, filed: { id: string; url: string }) => Promise<void>,
): Promise<void> {
  const cfg = deps.config.bridges.monday!
  const details = item.updates.filter((u) => u.creatorId === item.creatorId).sort(byCreated)
  const input = requestIssue(item, who, details.map((u) => u.text), { product: deps.config.repo.product, label: cfg.requestLabel })
  const filed = await deps.tracker.createIssue(input)
  if (!filed.labels.includes(cfg.requestLabel)) {
    deps.once("request-label", () => deps.log.warn(`Linear has no label ${cfg.requestLabel}, so requests from the board are filed without it (runbook, The Monday board)`))
  }
  const rec: ItemRecord = {
    key: `request-${item.id}`, kind: "request", issue: filed.id, itemId: item.id, state: "Needs you", bodyHash: null,
    createdAt: now.toISOString(), doneAt: null, handled: details.map((u) => u.id), linked: false,
  }
  saveRecord(deps.paths, rec)
  appendLedger(deps.paths, { type: "intake.filed", issue: filed.id, via: "monday" }, now)
  await deps.tracker.attachLink(filed.id, item.url, "Monday request").catch((error: unknown) => {
    deps.log.warn("monday request not linked from Linear", { issue: filed.id, error: message(error) })
  })
  await link(rec, filed)
}

export function createRequests(deps: RequestsDeps) {
  const { paths, log, api, tracker, people } = deps
  const cfg = deps.config.bridges.monday!
  const rcfg = cfg.requests!
  const c = rcfg.columns
  const person = new Map(cfg.people.map((p) => [p.id, p]))
  const save = (rec: ItemRecord) => saveRecord(paths, rec)

  /** Only the columns whose value changed since the bridge last wrote them. */
  async function write(rec: ItemRecord, item: MondayItem, values: Record<string, unknown>): Promise<void> {
    const changed = Object.fromEntries(Object.entries(values).filter(([col, v]) => rec.written?.[col] !== JSON.stringify(v)))
    if (!Object.keys(changed).length) return
    await api.setColumns(rcfg.boardId, item.id, changed)
    rec.written = { ...rec.written, ...Object.fromEntries(Object.entries(changed).map(([col, v]) => [col, JSON.stringify(v)])) }
    save(rec)
  }

  /** The item's side of a new request: its Linear link, its Requester and Stage New, and thanks to its person. */
  async function link(rec: ItemRecord, item: MondayItem, filed: { id: string; url: string }, now: Date): Promise<void> {
    const who = item.creatorId ? person.get(item.creatorId) : undefined
    await write(rec, item, {
      [c.linear]: { url: filed.url, text: filed.id },
      [c.stage]: { label: "New" },
      ...(who ? { [c.requester]: { personsAndTeams: [{ id: Number(who.id), kind: "person" }] } } : {}),
    })
    rec.linked = true
    rec.stage = "New"
    save(rec)
    if (who) deps.reply(item.id, say.filedRequest(who.name, filed.id), now)
  }

  async function fromBoard(pass: RequestsPass): Promise<void> {
    const tracked = new Set(readRecords(paths).map((r) => r.itemId))
    for (const item of pass.board.items) {
      // A new ask starts in Active: an item a person put straight into another group is not one.
      if (item.groupId !== pass.groups.active || tracked.has(item.id)) continue
      const who = item.creatorId ? person.get(item.creatorId) : undefined
      if (!who) {
        deps.once(`request:${item.id}`, () => log.info("monday request from someone not on bridges.monday.people, left alone", { item: item.id }))
        continue
      }
      // One at a time: a request Linear refuses waits for the next poll, and the others go on.
      try {
        await fileRequest(deps, item, who, pass.now, (rec, filed) => link(rec, item, filed, pass.now))
      } catch (error) {
        log.warn("monday request not filed yet", { item: item.id, error: message(error) })
      }
    }
  }

  /** The columns Linear decides. */
  function columnsFor(work: RequestWork, stage: Stage, progress: string, anchor: PeopleIssue | null, rec: ItemRecord): Record<string, unknown> {
    const tasks = work.children.length > 0 || Boolean(anchor?.project)
    const cls = classOf(anchor?.labels ?? [])
    const type = typeOf(anchor?.labels ?? [])
    const week = weekOf(anchor?.project?.targetDate ?? anchor?.dueDate ?? null)
    const thread = rec.slack?.permalink ?? anchor?.slackThread ?? null
    return {
      [c.stage]: { label: stage },
      [c.progress]: progress,
      ...(cls ? { [c.class]: { label: cls } } : {}),
      ...(type ? { [c.type]: { label: type } } : {}),
      ...(tasks ? { [c.size]: { label: anchor?.project ? "Project" : "Task" } } : {}),
      ...(week ? { [c.targetWeek]: { week } } : {}),
      ...(anchor ? { [c.linear]: anchor.project ? { url: anchor.project.url, text: anchor.project.name } : { url: anchor.url, text: anchor.id } } : {}),
      ...(thread ? { [c.slackThread]: { url: thread, text: "Slack thread" } } : {}),
    }
  }

  /** "The thread links to the item and gets its updates" (spec 4): each stage change, once, on the item and in the request's thread. */
  function tellStage(rec: ItemRecord, anchor: PeopleIssue, stage: Stage, progress: string, now: Date): void {
    const text = say.stage(anchor.id, stage, progress)
    deps.reply(rec.itemId, text, now)
    const thread = slackThreadOf(rec.slack?.permalink ?? anchor.slackThread)
    if (thread) enqueueSlack(paths, { kind: "reply", channelId: thread.channelId, threadTs: thread.threadTs, text }, now)
  }

  /** Each open Slack ask without an item gets one, in Active (Task 8). */
  async function adopt(pass: RequestsPass): Promise<void> {
    const asks = await people.slackRequests()
    if (!asks.length) return
    const known = new Set(readRecords(paths).filter((r) => r.kind === "request").map((r) => r.issue))
    for (const ask of asks) {
      if (known.has(ask.id)) continue
      try {
        const asker = slackAskerOf(ask.description)
        const named = asker ? cfg.people.find((p) => p.slackId === asker) : undefined
        const requester = named ?? person.get(cfg.defaultPerson)!
        const values: Record<string, unknown> = {
          [c.linear]: { url: ask.url, text: ask.id },
          [c.requester]: { personsAndTeams: [{ id: Number(requester.id), kind: "person" }] },
          [c.stage]: { label: "New" },
          ...(ask.slackThread ? { [c.slackThread]: { url: ask.slackThread, text: "Slack thread" } } : {}),
        }
        // The board is the record too: an item a crash left unrecorded is taken over, not made twice.
        const found = pass.board.items.find((i) => linkUrl(i.columns[c.linear]) === ask.url)
        const itemId = found?.id ?? (await api.createItem(rcfg.boardId, pass.groups.active, truncateChars(ask.title, 250), values))
        const rec: ItemRecord = {
          key: `request-${itemId}`, kind: "request", issue: ask.id, itemId, state: "Waiting on agent", bodyHash: null,
          createdAt: pass.now.toISOString(), doneAt: null, handled: [], linked: true, stage: "New", announced: false,
          ...(ask.slackThread ? { slack: { permalink: ask.slackThread } } : {}),
          ...(found ? {} : { written: Object.fromEntries(Object.entries(values).map(([col, v]) => [col, JSON.stringify(v)])) }),
        }
        save(rec)
        if (!found) {
          deps.reply(itemId, say.askedInSlack(named?.name ?? "Someone", aboutText(ask.description)), pass.now)
          appendLedger(paths, { type: "monday.item", issue: ask.id, kind: "request", via: INTAKE_SLACK }, pass.now)
        }
      } catch (error) {
        log.warn("monday Slack request not given its item yet", { issue: ask.id, error: message(error) })
      }
    }
  }

  /** The poll after a Slack request's item is made (its link known from the board): Linear links it, and its thread is told once. */
  async function announce(rec: ItemRecord, item: MondayItem, anchor: PeopleIssue, now: Date): Promise<void> {
    await tracker.attachLink(anchor.id, item.url, "Monday request")
    const thread = slackThreadOf(rec.slack?.permalink ?? anchor.slackThread)
    if (thread) enqueueSlack(paths, { kind: "reply", channelId: thread.channelId, threadTs: thread.threadTs, text: say.onRequestsBoard(anchor.id, item.url) }, now)
    rec.announced = true
    save(rec)
  }

  /** Released first: a comment that fails then leaves the state right, and one that is written never says what did not happen. */
  async function completeAnchor(anchor: PeopleIssue): Promise<void> {
    await tracker.updateIssue(anchor.id, { state: "Released" })
    await tracker.comment(anchor.id, "Every task of this request is released or closed, so the request is done.")
  }

  async function update(pass: RequestsPass): Promise<void> {
    const recs = readRecords(paths).filter((r) => r.kind === "request" && pass.byId.has(r.itemId))
    if (!recs.length) return
    const anchors = new Map((await people.byIdentifiers(recs.map((r) => r.issue))).map((i) => [i.id, i]))
    const children = await people.childrenOf([...anchors.values()].map((a) => a.uuid))
    for (const rec of recs) {
      const item = pass.byId.get(rec.itemId)!
      const anchor = anchors.get(rec.issue) ?? null
      try {
        // Filed, then stopped before its link was written: the link now.
        if (!rec.linked && anchor) await link(rec, item, anchor, pass.now)
        // Linear refusing the link waits for the next poll, and holds nothing else up.
        if (rec.announced === false && anchor) {
          await announce(rec, item, anchor, pass.now).catch((error: unknown) => log.warn("monday request not announced yet", { issue: rec.issue, error: message(error) }))
        }
        const work: RequestWork = { anchor, children: anchor ? (children.get(anchor.id) ?? []) : [] }
        const stage = requestStage(work)
        const progress = progressText(work, stage, typeOf(anchor?.labels ?? []) === "Question")
        await write(rec, item, columnsFor(work, stage, progress, anchor, rec))
        const group = pass.groups[requestGroup(stage)]
        if (item.groupId !== group) await api.moveItem(item.id, group)
        if (rec.stage && rec.stage !== stage && anchor) {
          tellStage(rec, anchor, stage, progress, pass.now)
          // Said: saved at once, so a failure below never says it twice.
          rec.stage = stage
          save(rec)
        }
        if (anchor && anchor.stateType !== "completed" && workDone(work)) await completeAnchor(anchor)
        rec.stage = stage
        rec.doneAt = stage === "Released" || stage === "Declined" ? (rec.doneAt ?? pass.now.toISOString()) : null
        save(rec)
      } catch (error) {
        log.warn("monday request not brought up to date", { item: item.id, issue: rec.issue, error: message(error) })
      }
    }
  }

  /**
   * A person's Class change on their request (D1). The log is read a few
   * minutes back every poll, so only the newest change in a read counts, and
   * never one made at or before the last one settled (classAt): a change read
   * again is acted on once, and a replayed lowering cannot undo a raise made
   * since (review, 2026-09-25). One Linear cannot take yet is kept until it
   * can, or until a newer change takes its place.
   */
  async function hearClass(pass: RequestsPass): Promise<void> {
    const recs = new Map(readRecords(paths).filter((r) => r.kind === "request" && pass.byId.has(r.itemId)).map((r) => [r.itemId, r]))
    const byItem = new Map<string, Array<Pick<ColumnChange, "id" | "userId" | "text" | "at">>>()
    const add = (itemId: string, change: Pick<ColumnChange, "id" | "userId" | "text" | "at">) => byItem.set(itemId, [...(byItem.get(itemId) ?? []), change])
    for (const rec of recs.values()) if (rec.classRetry) add(rec.itemId, rec.classRetry)
    // The agent's own writes, and anyone not on the list: never a person's.
    for (const change of pass.board.changes) if (change.columnId === c.class && person.has(change.userId) && recs.has(change.itemId)) add(change.itemId, change)
    for (const [itemId, changes] of byItem) {
      const rec = recs.get(itemId)!
      const newest = changes.sort((a, b) => a.at.localeCompare(b.at)).at(-1)!
      if (rec.classAt && newest.at <= rec.classAt) continue
      // A column a person cleared, or a label that is no class, changes nothing, and still takes a kept change's place.
      const to = CLASSES.get(newest.text.trim().toLowerCase())
      if (to) {
        const who = person.get(newest.userId)!.name
        const where = pass.byId.get(itemId)!.url
        try {
          const out = await changeClass({ tracker, people, recorder: () => deps.recorder?.() ?? null }, { issue: rec.issue, to, who, where, via: "on Monday" })
          if (out.outcome !== "same") deps.reply(itemId, say.classChanged(rec.issue, to, who), pass.now)
          if (out.outcome === "lowered") enqueueSlack(paths, { kind: "post", channel: "agents", text: say.lowered(rec.issue, out.from, to, who, "on Monday", where) }, pass.now)
        } catch (error) {
          if (error instanceof NeedsRecorder) {
            deps.reply(itemId, say.classNeedsLinear(rec.issue, to), pass.now)
            // The column goes back to the class Linear has, at this poll's write.
            const { [c.class]: _, ...written } = rec.written ?? {}
            rec.written = written
          } else if (isIssueGone(error)) {
            deps.reply(itemId, say.gone(rec.issue), pass.now)
          } else {
            rec.classRetry = { id: newest.id, userId: newest.userId, text: newest.text, at: newest.at }
            save(rec)
            log.warn("monday class change not made yet", { item: itemId, issue: rec.issue, error: message(error) })
            continue
          }
        }
      }
      rec.classAt = newest.at
      delete rec.classRetry
      save(rec)
    }
  }

  /** A released or declined request stays releasedDays, then its item is archived. */
  async function archive(pass: RequestsPass): Promise<void> {
    const cutoff = pass.now.getTime() - rcfg.releasedDays * DAY
    for (const rec of readRecords(paths)) {
      if (rec.kind !== "request" || !rec.doneAt || Date.parse(rec.doneAt) > cutoff) continue
      if (pass.byId.has(rec.itemId)) await api.archiveItem(rec.itemId)
      dropRecord(paths, rec.key)
    }
  }

  return { fromBoard, adopt, hearClass, update, archive }
}
