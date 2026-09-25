/**
 * Spec 8's move to two boards, the part that touches items and issues. The
 * board's own structure (its name, groups and columns, and the new Requests
 * board) is changed by hand with the setup token first (runbook). Run with
 * the bridge off; a second run finds nothing left to do.
 */

import { join } from "node:path"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { writeJsonAtomic } from "../fsq.ts"
import { appendLedger } from "../log.ts"
import { INTAKE_SLACK } from "../slack/text.ts"
import type { Tracker } from "../tracker.ts"
import type { MondayApi } from "./client.ts"
import type { PeopleView } from "./people.ts"
import { dropRecord, readRecords } from "./store.ts"

export interface MigrateDeps {
  config: AgentConfig
  paths: AgentPaths
  api: MondayApi
  tracker: Tracker
  people: Pick<PeopleView, "openIssuesFiledFromSlack">
}

export interface MigrationPlan {
  moves: Array<{ itemId: string; name: string; from: string; to: "active" | "released" }>
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
}

type Failed = Array<{ what: string; error: string }>

/** What the migration would do. `only`: that one item alone, and no labels (a first try, runbook). */
export async function planMigration(deps: MigrateDeps, only?: string): Promise<MigrationPlan> {
  const cfg = deps.config.bridges.monday
  if (!cfg?.requests) throw new Error("bridges.monday.requests is not in config.json: add the Requests board's ids first (runbook)")
  const board = await deps.api.readBoard(cfg.boardId, Object.values(cfg.columns).filter(Boolean) as string[], { columnIds: [], since: new Date() })
  const titleOf = new Map(board.groups.map((g) => [g.id, g.title]))
  const from = new Set([cfg.groups.requests, cfg.groups.working].map((t) => t.trim().toLowerCase()))
  const done = new Set(readRecords(deps.paths).filter((r) => r.kind === "request" && r.state === "Done").map((r) => r.itemId))
  const moves = board.items
    .filter((i) => from.has((titleOf.get(i.groupId) ?? "").trim().toLowerCase()))
    .filter((i) => !only || i.id === only)
    .map((i) => ({ itemId: i.id, name: i.name, from: titleOf.get(i.groupId)!, to: done.has(i.id) ? ("released" as const) : ("active" as const) }))
  if (only && !moves.length) throw new Error(`item ${only} is not in the Requests or Agents working on group of board ${cfg.boardId}`)
  // Monday wants every column mapped: the Linear link and the person carry over, and the rest is the Needs-you board's own.
  const carry: Record<string, string> = { [cfg.columns.linear]: cfg.requests.columns.linear, [cfg.columns.person]: cfg.requests.columns.requester }
  const mapping = (await deps.api.boardColumns(cfg.boardId)).filter((c) => c.id !== "name").map((c) => ({ source: c.id, target: carry[c.id] ?? null }))
  const label = only ? [] : (await deps.people.openIssuesFiledFromSlack())
    .filter((i) => i.parent === null && !i.labels.includes(INTAKE_SLACK) && !i.labels.includes("intake/monday"))
    .map((i) => ({ issue: i.id, title: i.title }))
  return { moves, mapping, label }
}

const OFF_FIRST = "turn the Monday bridge off first (bridges.monday.enabled false, then restart agentd): it must not poll while its items move"

export async function applyMigration(deps: MigrateDeps, plan: MigrationPlan): Promise<{ moved: string[]; labelled: string[]; failed: Failed; snapshot: string }> {
  const cfg = deps.config.bridges.monday!
  if (cfg.enabled) throw new Error(OFF_FIRST)
  // The way back, written before anything moves: the move keeps only two columns (review, 2026-09-25).
  const all = (await deps.api.boardColumns(cfg.boardId)).map((c) => c.id).filter((id) => id !== "name")
  const source = await deps.api.readBoard(cfg.boardId, all, { columnIds: [], since: new Date() })
  const moving = new Set(plan.moves.map((m) => m.itemId))
  const snapshot: MigrationSnapshot = {
    at: new Date().toISOString(), needsBoard: cfg.boardId, requestsBoard: cfg.requests!.boardId, labelled: plan.label.map((l) => l.issue),
    items: source.items.filter((i) => moving.has(i.id)).map((i) => ({ itemId: i.id, name: i.name, groupId: i.groupId, columns: Object.fromEntries(Object.entries(i.columns).map(([id, c]) => [id, c.value])) })),
  }
  const snapshotFile = join(deps.paths.state, "monday", `migration-${snapshot.at.replace(/[:.]/g, "-")}.json`)
  writeJsonAtomic(snapshotFile, snapshot)
  const target = await deps.api.readBoard(cfg.requests!.boardId, [], { columnIds: [], since: new Date() })
  const groupId = (title: string) => {
    const id = target.groups.find((g) => g.title.trim().toLowerCase() === title.trim().toLowerCase())?.id
    if (!id) throw new Error(`the Requests board has no group named "${title}"`)
    return id
  }
  const result = { moved: [] as string[], labelled: [] as string[], failed: [] as Failed }
  for (const m of plan.moves) {
    try {
      await deps.api.moveItemToBoard(cfg.requests!.boardId, groupId(m.to === "released" ? cfg.requests!.groups.released : cfg.requests!.groups.active), m.itemId, plan.mapping)
      result.moved.push(m.itemId)
    } catch (error) {
      result.failed.push({ what: `item ${m.itemId} (${m.name})`, error: String(error) })
    }
  }
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
}

/**
 * The way back from a migration, from its snapshot: each item to its old
 * group on the Needs-you board with every column as it was, the labels off,
 * and the request items the bridge made for the labelled issues archived.
 * With the bridge off, as for the move. A second run finds nothing to do.
 */
export async function reverseMigration(deps: MigrateDeps, snap: MigrationSnapshot): Promise<{ restored: string[]; unlabelled: string[]; archived: string[]; failed: Failed }> {
  const cfg = deps.config.bridges.monday!
  if (cfg.enabled) throw new Error(OFF_FIRST)
  const onRequests = await deps.api.readBoard(snap.requestsBoard, [], { columnIds: [], since: new Date() })
  const there = new Set(onRequests.items.map((i) => i.id))
  // Every Requests board column is mapped: the two the move carried go back, the rest are dropped, and the snapshot restores all.
  const carried: Record<string, string> = { [cfg.requests!.columns.linear]: cfg.columns.linear, [cfg.requests!.columns.requester]: cfg.columns.person }
  const mapping = (await deps.api.boardColumns(snap.requestsBoard)).filter((c) => c.id !== "name").map((c) => ({ source: c.id, target: carried[c.id] ?? null }))
  const result = { restored: [] as string[], unlabelled: [] as string[], archived: [] as string[], failed: [] as Failed }
  for (const item of snap.items.filter((i) => there.has(i.itemId))) {
    try {
      await deps.api.moveItemToBoard(snap.needsBoard, item.groupId, item.itemId, mapping)
      const values = Object.fromEntries(Object.entries(item.columns).filter(([, v]) => v !== null).map(([id, v]) => [id, JSON.parse(v!)]))
      if (Object.keys(values).length) await deps.api.setColumns(snap.needsBoard, item.itemId, values)
      result.restored.push(item.itemId)
    } catch (error) {
      result.failed.push({ what: `item ${item.itemId} (${item.name})`, error: String(error) })
    }
  }
  const labelled = new Set(snap.labelled)
  for (const rec of readRecords(deps.paths).filter((r) => r.kind === "request" && labelled.has(r.issue) && there.has(r.itemId))) {
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
}
