/**
 * Spec 8's move to two boards, the part that touches items and issues. The
 * board's own structure (its name, groups and columns, and the new Requests
 * board) is changed by hand with the setup token first (runbook). Run with
 * the bridge off; a second run finds nothing left to do.
 *
 * What Monday's move keeps, and what it does not (review, 2026-09-26):
 * - Only the Linear link and the Person carry over; every other column is
 *   dropped by the move and kept in the snapshot, which the way back restores.
 * - A connected-items column (the Request column) is restored as item ids:
 *   Monday reads it as linkedPulseIds and takes it as item_ids.
 * - Subitems and files cannot be moved or restored through the API, so an item
 *   with either stays where it is, with the reason, until a person moves them
 *   off or removes them.
 * - Columns Monday computes (formula, mirror, creation log and the like) are
 *   never written back.
 */

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { readJson, writeJsonAtomic } from "../fsq.ts"
import { appendLedger } from "../log.ts"
import { INTAKE_SLACK } from "../slack/text.ts"
import type { Tracker } from "../tracker.ts"
import type { MondayApi, MondayColumn } from "./client.ts"
import type { PeopleView } from "./people.ts"
import { dropRecord, migratingPath, migrationsDir, readCursor, readRecords, syncingPath } from "./store.ts"

export interface MigrateDeps {
  config: AgentConfig
  paths: AgentPaths
  api: MondayApi
  tracker: Tracker
  people: Pick<PeopleView, "openIssuesFiledFromSlack">
}

export interface MigrationPlan {
  moves: Array<{ itemId: string; name: string; from: string; to: "active" | "released" }>
  /** Items the move would lose something of: they stay, with the reason, until a person has dealt with it. */
  refused: Array<{ itemId: string; name: string; why: string }>
  mapping: Array<{ source: string; target: string | null }>
  label: Array<{ issue: string; title: string }>
}

export interface MigrationSnapshot {
  at: string
  needsBoard: string
  requestsBoard: string
  /** Every column's value as Monday gave it, and the group: what the way back restores. */
  items: Array<{ itemId: string; name: string; groupId: string; columns: Record<string, string | null> }>
  labelled: string[]
  /** The items this run has moved, written before each move: absent in a snapshot older than that, so any of them may have moved. */
  moved?: string[]
  /** The item it was moving when it last wrote: a run cut short then may have moved it. */
  moving?: string
}

type Failed = Array<{ what: string; error: string }>

const MINUTE = 60_000
/** Column types Monday's API cannot write, or not as a column value: never restored. */
const READ_ONLY = new Set(["auto_number", "button", "creation_log", "doc", "direct_doc", "file", "formula", "item_id", "last_updated", "mirror", "progress", "subtasks", "time_tracking", "vote"])
/** What a move cannot carry: an item with any of these stays. */
const LOST_ON_MOVE: Record<string, (c: MondayColumn) => string> = { subtasks: () => "subitems", file: (c) => `files in ${c.title}` }
/** Read as linkedPulseIds, written as item_ids. */
const CONNECTED = new Set(["board_relation", "dependency"])

/** What a move would lose of this item, or null. */
function lostOnMove(columns: MondayColumn[], values: Record<string, { text: string | null } | undefined>): string | null {
  const lost = columns.filter((c) => LOST_ON_MOVE[c.type] && values[c.id]?.text?.trim()).map((c) => LOST_ON_MOVE[c.type](c))
  return lost.length ? `it has ${lost.join(" and ")}, which the move would lose: move them off or remove them by hand, then run again` : null
}

/** What a planned move of the Requests groups looks like. `only`: that one item alone, and no labels (a first try, runbook). */
export async function planMigration(deps: MigrateDeps, only?: string): Promise<MigrationPlan> {
  const cfg = deps.config.bridges.monday
  if (!cfg?.requests) throw new Error("bridges.monday.requests is not in config.json: add the Requests board's ids first (runbook)")
  const columns = (await deps.api.boardColumns(cfg.boardId)).filter((c) => c.id !== "name")
  const board = await deps.api.readBoard(cfg.boardId, columns.map((c) => c.id), { columnIds: [], since: new Date() })
  const titleOf = new Map(board.groups.map((g) => [g.id, g.title]))
  const from = new Set([cfg.groups.requests, cfg.groups.working].map((t) => t.trim().toLowerCase()))
  const done = new Set(readRecords(deps.paths).filter((r) => r.kind === "request" && r.state === "Done").map((r) => r.itemId))
  const candidates = board.items.filter((i) => from.has((titleOf.get(i.groupId) ?? "").trim().toLowerCase())).filter((i) => !only || i.id === only)
  if (only && !candidates.length) throw new Error(`item ${only} is not in the Requests or Agents working on group of board ${cfg.boardId}`)
  const refused = candidates.flatMap((i) => {
    const why = lostOnMove(columns, i.columns)
    return why ? [{ itemId: i.id, name: i.name, why }] : []
  })
  const moves = candidates
    .filter((i) => !refused.some((r) => r.itemId === i.id))
    .map((i) => ({ itemId: i.id, name: i.name, from: titleOf.get(i.groupId)!, to: done.has(i.id) ? ("released" as const) : ("active" as const) }))
  // Monday wants every column mapped: the Linear link and the person carry over, and the rest is the Needs-you board's own.
  const carry: Record<string, string> = { [cfg.columns.linear]: cfg.requests.columns.linear, [cfg.columns.person]: cfg.requests.columns.requester }
  const mapping = columns.map((c) => ({ source: c.id, target: carry[c.id] ?? null }))
  const label = only ? [] : (await deps.people.openIssuesFiledFromSlack())
    .filter((i) => i.parent === null && !i.labels.includes(INTAKE_SLACK) && !i.labels.includes("intake/monday"))
    .map((i) => ({ issue: i.id, title: i.title }))
  return { moves, refused, mapping, label }
}

const OFF_FIRST = "turn the Monday bridge off first (bridges.monday.enabled false, then restart agentd): it must not poll while its items move"

/** How long a migration waits for a bridge poll under way to end, and how often it looks. Tests shorten them. */
export const BRIDGE_WAIT = { waitMs: 120_000, stepMs: 1_000 }

/** Whether a process runs with this pid: a mark left by one that died holds nothing up. */
function alive(pid: unknown): boolean {
  if (typeof pid !== "number") return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Runs fn with the migration's lock (state/monday/migrating), which the
 * bridge honours: it does not poll or post while it is there. The lock is
 * taken first and the bridge's own mark (state/monday/syncing) checked after,
 * as the bridge marks first and checks the lock after, so the two never run
 * together. Refused while the config has the bridge on, while another run
 * holds the lock, while the bridge is in a poll, and while agentd still polls
 * (its last read is within pollMinutes: it runs with the config it started
 * with).
 */
async function alone<T>(deps: MigrateDeps, fn: () => Promise<T>): Promise<T> {
  const cfg = deps.config.bridges.monday!
  if (cfg.enabled) throw new Error(OFF_FIRST)
  const lock = migratingPath(deps.paths)
  mkdirSync(dirname(lock), { recursive: true })
  let fd: number
  try {
    fd = openSync(lock, "wx", 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    throw new Error(`a migration is running on this mini, or one stopped half-way: check that none runs (ps), then remove ${lock} and run this again`)
  }
  writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
  closeSync(fd)
  try {
    // A poll under way ends within seconds: it is waited for, a while, and a mark whose process is gone is none.
    const deadline = Date.now() + BRIDGE_WAIT.waitMs
    while (alive(readJson<{ pid?: unknown }>(syncingPath(deps.paths))?.pid)) {
      if (Date.now() >= deadline) {
        throw new Error(`the Monday bridge is still reading the board after ${Math.round(BRIDGE_WAIT.waitMs / 1000)} seconds: restart agentd with the bridge off, and run this again`)
      }
      await new Promise((resolve) => setTimeout(resolve, BRIDGE_WAIT.stepMs))
    }
    const polled = readCursor(deps.paths)
    const ago = polled ? Date.now() - polled.getTime() : Infinity
    if (ago < cfg.pollMinutes * MINUTE) {
      throw new Error(`the Monday bridge read the board ${Math.max(0, Math.round(ago / 1000))} seconds ago: restart agentd with the bridge off, wait ${cfg.pollMinutes} minutes, and run this again`)
    }
    return await fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

export async function applyMigration(deps: MigrateDeps, plan: MigrationPlan): Promise<{ moved: string[]; labelled: string[]; failed: Failed; snapshot: string }> {
  const cfg = deps.config.bridges.monday!
  return alone(deps, async () => {
    // The way back, written before anything moves: the move keeps only two columns (review, 2026-09-25).
    const all = (await deps.api.boardColumns(cfg.boardId)).map((c) => c.id).filter((id) => id !== "name")
    const source = await deps.api.readBoard(cfg.boardId, all, { columnIds: [], since: new Date() })
    const moving = new Set(plan.moves.map((m) => m.itemId))
    const snapshot: MigrationSnapshot = {
      at: new Date().toISOString(), needsBoard: cfg.boardId, requestsBoard: cfg.requests!.boardId, labelled: plan.label.map((l) => l.issue),
      items: source.items.filter((i) => moving.has(i.id)).map((i) => ({ itemId: i.id, name: i.name, groupId: i.groupId, columns: Object.fromEntries(Object.entries(i.columns).map(([id, c]) => [id, c.value])) })),
    }
    // Every column's value is in it: only this user reads it. One per run, named by its time, so a directory of them sorts in order.
    const snapshotFile = join(migrationsDir(deps.paths), `migration-${snapshot.at.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.json`)
    const save = (data: MigrationSnapshot) => writeJsonAtomic(snapshotFile, data, 0o600)
    save({ ...snapshot, moved: [] })
    const target = await deps.api.readBoard(cfg.requests!.boardId, [], { columnIds: [], since: new Date() })
    const groupId = (title: string) => {
      const id = target.groups.find((g) => g.title.trim().toLowerCase() === title.trim().toLowerCase())?.id
      if (!id) throw new Error(`the Requests board has no group named "${title}"`)
      return id
    }
    const result = { moved: [] as string[], labelled: [] as string[], failed: plan.refused.map((r) => ({ what: `item ${r.itemId} (${r.name})`, error: r.why })) as Failed }
    // Written down before each move: one it could not move never left, and the way back leaves it alone (readSnapshots).
    for (const m of plan.moves) {
      save({ ...snapshot, moved: result.moved, moving: m.itemId })
      try {
        await deps.api.moveItemToBoard(cfg.requests!.boardId, groupId(m.to === "released" ? cfg.requests!.groups.released : cfg.requests!.groups.active), m.itemId, plan.mapping)
        result.moved.push(m.itemId)
      } catch (error) {
        result.failed.push({ what: `item ${m.itemId} (${m.name})`, error: String(error) })
      }
    }
    save({ ...snapshot, moved: result.moved })
    for (const l of plan.label) {
      try {
        await deps.tracker.updateIssue(l.issue, { addLabels: [INTAKE_SLACK] })
        result.labelled.push(l.issue)
      } catch (error) {
        result.failed.push({ what: l.issue, error: String(error) })
      }
    }
    appendLedger(deps.paths, { type: "monday.migrated", moved: result.moved.length, labelled: result.labelled.length, failed: result.failed.length }, new Date())
    return { ...result, snapshot: snapshotFile }
  })
}

/**
 * A snapshot file, or every migration-*.json in a directory as one: each
 * item a run moved, as the latest run that moved it found it, and every
 * issue any run labelled. An item no run moved never left the Needs-you
 * board, so the way back leaves it, and what was changed on it since, alone.
 * The item a run cut short was moving may have moved, and counts as moved,
 * as every item of a snapshot that does not say.
 */
export function readSnapshots(path: string): MigrationSnapshot {
  const files = statSync(path).isDirectory()
    ? readdirSync(path).filter((f) => /^migration-.+\.json$/.test(f)).sort().map((f) => join(path, f))
    : [path]
  if (!files.length) throw new Error(`${path} holds no migration snapshot`)
  const snaps = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as MigrationSnapshot)
  for (const [i, s] of snaps.entries()) {
    if (typeof s?.needsBoard !== "string" || typeof s.requestsBoard !== "string" || !Array.isArray(s.items) || !Array.isArray(s.labelled)) throw new Error(`${files[i]} is not a migration snapshot`)
  }
  const [first] = snaps
  if (snaps.some((s) => s.needsBoard !== first.needsBoard || s.requestsBoard !== first.requestsBoard)) throw new Error(`${path} holds snapshots of different boards: give one file`)
  const items = new Map<string, MigrationSnapshot["items"][number]>()
  for (const s of snaps) for (const item of s.items) if (!s.moved || s.moved.includes(item.itemId) || s.moving === item.itemId) items.set(item.itemId, item)
  return { at: first.at, needsBoard: first.needsBoard, requestsBoard: first.requestsBoard, items: [...items.values()], labelled: [...new Set(snaps.flatMap((s) => s.labelled))] }
}

/** A value as Monday reads it, as it takes it: without the time it was changed, a connected item as item ids. */
function writable(type: string, value: string): unknown {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed
  const { changed_at: _changed, post_id: _post, ...rest } = parsed as Record<string, unknown>
  if (!CONNECTED.has(type)) return rest
  const ids = (rest.item_ids as unknown[] | undefined) ?? ((rest.linkedPulseIds as Array<{ linkedPulseId: unknown }> | undefined) ?? []).map((p) => p.linkedPulseId)
  return { item_ids: ids.map(Number) }
}

/**
 * The way back from a migration, from its snapshots: each item to its old
 * group on the Needs-you board, then every column as it was, one at a time,
 * so a refusal holds back only that column. Every snapshot item already on
 * the Needs-you board is checked too, and only what still differs is
 * written: a run that stopped half-way is finished by the next. The labels
 * come off, and the request items the bridge made for the labelled issues
 * are archived. An item someone else made, which the bridge took over, stays:
 * the bridge only lets it go. With the bridge off, as for the move.
 */
export async function reverseMigration(
  deps: MigrateDeps,
  snap: MigrationSnapshot,
): Promise<{ restored: string[]; unlabelled: string[]; archived: string[]; kept: string[]; failed: Failed }> {
  const cfg = deps.config.bridges.monday!
  return alone(deps, async () => {
    const requestColumns = (await deps.api.boardColumns(snap.requestsBoard)).filter((c) => c.id !== "name")
    // Read with what the move back would lose: subitems or files an item got on the Requests board.
    const lossy = requestColumns.filter((c) => LOST_ON_MOVE[c.type]).map((c) => c.id)
    const onRequests = await deps.api.readBoard(snap.requestsBoard, lossy, { columnIds: [], since: new Date() })
    const there = new Map(onRequests.items.map((i) => [i.id, i]))
    // Every Requests board column is mapped: the two the move carried go back, the rest are dropped, and the snapshot restores all.
    const carried: Record<string, string> = { [cfg.requests!.columns.linear]: cfg.columns.linear, [cfg.requests!.columns.requester]: cfg.columns.person }
    const mapping = requestColumns.map((c) => ({ source: c.id, target: carried[c.id] ?? null }))
    const result = { restored: [] as string[], unlabelled: [] as string[], archived: [] as string[], kept: [] as string[], failed: [] as Failed }
    const failedItems = new Set<string>()
    const fail = (itemId: string, what: string, error: unknown) => {
      failedItems.add(itemId)
      result.failed.push({ what, error: String(error) })
    }
    for (const item of snap.items) {
      const now = there.get(item.itemId)
      if (!now) continue
      // Subitems or files it got on the Requests board: the move back would lose them, so it stays until a person has dealt with them.
      const why = lostOnMove(requestColumns, now.columns)
      if (why) {
        fail(item.itemId, `item ${item.itemId} (${item.name})`, why)
        continue
      }
      try {
        await deps.api.moveItemToBoard(snap.needsBoard, item.groupId, item.itemId, mapping)
      } catch (error) {
        fail(item.itemId, `item ${item.itemId} (${item.name})`, error)
      }
    }
    const types = new Map((await deps.api.boardColumns(snap.needsBoard)).map((c) => [c.id, c.type]))
    const writableIds = [...types].filter(([id, type]) => id !== "name" && !READ_ONLY.has(type)).map(([id]) => id)
    const onNeeds = new Map((await deps.api.readBoard(snap.needsBoard, writableIds, { columnIds: [], since: new Date() })).items.map((i) => [i.id, i]))
    for (const item of snap.items) {
      const now = onNeeds.get(item.itemId)
      if (!now) {
        if (!failedItems.has(item.itemId)) fail(item.itemId, `item ${item.itemId} (${item.name})`, "it is on neither board")
        continue
      }
      try {
        if (now.groupId !== item.groupId) await deps.api.moveItem(item.itemId, item.groupId)
      } catch (error) {
        fail(item.itemId, `item ${item.itemId} (${item.name}), its group`, error)
      }
      for (const [id, value] of Object.entries(item.columns)) {
        const type = types.get(id)
        if (value === null || !type || READ_ONLY.has(type)) continue
        // A value it cannot read holds back only its own column.
        try {
          const want = writable(type, value)
          const has = now.columns[id]?.value
          if (has && JSON.stringify(writable(type, has)) === JSON.stringify(want)) continue
          await deps.api.setColumns(snap.needsBoard, item.itemId, { [id]: want })
        } catch (error) {
          fail(item.itemId, `item ${item.itemId} (${item.name}), column ${id}`, error)
        }
      }
      if (!failedItems.has(item.itemId)) result.restored.push(item.itemId)
    }
    const labelled = new Set(snap.labelled)
    for (const rec of readRecords(deps.paths).filter((r) => r.kind === "request" && labelled.has(r.issue) && there.has(r.itemId))) {
      if (rec.takenOver) {
        dropRecord(deps.paths, rec.key)
        result.kept.push(rec.itemId)
        continue
      }
      try {
        await deps.api.archiveItem(rec.itemId)
        dropRecord(deps.paths, rec.key)
        result.archived.push(rec.itemId)
      } catch (error) {
        result.failed.push({ what: `item ${rec.itemId}`, error: String(error) })
      }
    }
    for (const issue of snap.labelled) {
      try {
        await deps.tracker.updateIssue(issue, { removeLabels: [INTAKE_SLACK] })
        result.unlabelled.push(issue)
      } catch (error) {
        result.failed.push({ what: issue, error: String(error) })
      }
    }
    appendLedger(deps.paths, { type: "monday.migration_reversed", restored: result.restored.length, failed: result.failed.length }, new Date())
    return result
  })
}
