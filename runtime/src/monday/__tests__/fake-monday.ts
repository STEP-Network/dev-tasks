/**
 * An in-memory Monday account for the bridge's tests: boards with their
 * groups, items that move between them, connected items, and an activity log
 * of column changes. It records every call as the Monday API would take it.
 * Made-up people and ids, except today's board and its column ids, which are
 * public since STEP-3289.
 */

import { MondayRefused, type ColumnChange, type MondayApi, type MondayColumn, type MondayItem } from "../client.ts"

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
