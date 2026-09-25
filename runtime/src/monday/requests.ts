/**
 * The Requests board (Wave 2, spec 4 and 6): one item per ask. A person's new
 * item in Active becomes a Linear Triage issue, the request's anchor. Each
 * poll brings every request up to date from its anchor and the anchor's
 * tasks: its Stage, Progress, Class, Type, Size, Target week, Linear and
 * Slack thread columns, and its group. A column is written again only when
 * Linear changes it, so a person's own edit stands. Each stage change is said
 * once, on the item and in the request's Slack thread. A released or
 * declined request is archived releasedDays later.
 */

import type { AgentConfig, AgentPaths } from "../config.ts"
import { appendLedger, type Logger } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import type { Tracker } from "../tracker.ts"
import type { MondayApi, MondayBoard, MondayItem } from "./client.ts"
import type { PeopleIssue, PeopleView } from "./people.ts"
import { requestIssue, say } from "./render.ts"
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
}

export interface RequestsPass {
  board: MondayBoard
  groups: Record<"active" | "released" | "closed", string>
  byId: Map<string, MondayItem>
  now: Date
}

type Person = { id: string; name: string }

const DAY = 86_400_000
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const byCreated = <T extends { createdAt: string }>(a: T, b: T) => a.createdAt.localeCompare(b.createdAt)

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

  /** A released or declined request stays releasedDays, then its item is archived. */
  async function archive(pass: RequestsPass): Promise<void> {
    const cutoff = pass.now.getTime() - rcfg.releasedDays * DAY
    for (const rec of readRecords(paths)) {
      if (rec.kind !== "request" || !rec.doneAt || Date.parse(rec.doneAt) > cutoff) continue
      if (pass.byId.has(rec.itemId)) await api.archiveItem(rec.itemId)
      dropRecord(paths, rec.key)
    }
  }

  return { fromBoard, update, archive }
}
