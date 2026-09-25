/**
 * The Monday API, as the Monday bridge uses it (STEP-3289) and no more: read
 * one board and who changed its Answer column (one call), read the account's
 * daily call limit, and write items, updates and column values. The token is the agent's own Monday user's, from
 * ~/.config/agentd/monday.env. It travels only in the Authorization header:
 * never in a query, a log line, an error or an argv, and a redirect is
 * refused rather than followed with it.
 */

import { redact } from "../log.ts"

export const MONDAY_ENDPOINT = "https://api.monday.com/v2"
/** Pinned, as the plugin's Monday client pins its own: a new default version must not change what the bridge reads. */
export const MONDAY_API_VERSION = "2025-10"

export interface MondayUpdate {
  id: string
  /** The Monday user who wrote it. Only the configured people count. */
  creatorId: string | null
  /** Plain text, as Monday renders the update's body. */
  text: string
  createdAt: string
  /** The top-level update of its thread: itself, or the update it replies to. */
  threadId: string
}

export interface MondayItem {
  id: string
  name: string
  url: string
  groupId: string
  creatorId: string | null
  createdAt: string
  /** The columns the bridge asked for, by id. */
  columns: Record<string, { text: string | null; value: string | null }>
  /** The newest updates and their replies, flat. */
  updates: MondayUpdate[]
}

export interface MondayBoard {
  groups: Array<{ id: string; title: string }>
  /** Active items only: Monday leaves archived and deleted ones out. */
  items: MondayItem[]
  /** The watched column's changes since the time asked for, oldest first. */
  changes: ColumnChange[]
}

/** One change to a column, from the board's activity log: who, which item, and what it now says. */
export interface ColumnChange {
  id: string
  itemId: string
  userId: string
  text: string
  at: string
}

/**
 * Monday answered, and refused (a GraphQL error): the same request would be
 * refused again. Not an outage, which retries.
 */
export class MondayRefused extends Error {}

export interface MondayApi {
  /** The token's own user. */
  me(): Promise<{ id: string; name: string; isAdmin: boolean }>
  /**
   * The board in one call: its groups, its items (a further call per 100
   * past the first 100), and who changed `watch.columnId` since `watch.since`,
   * from its activity log. A column value carries no author, the log does.
   */
  readBoard(boardId: string, columnIds: string[], watch: { columnId: string; since: Date }): Promise<MondayBoard>
  /** The account's API calls a day (monday's plans allow 1,000 to 25,000), or null when Monday does not say. */
  dailyLimit(): Promise<number | null>
  createItem(boardId: string, groupId: string, name: string, values: Record<string, unknown>): Promise<string>
  setColumns(boardId: string, itemId: string, values: Record<string, unknown>): Promise<void>
  moveItem(itemId: string, groupId: string): Promise<void>
  /** An update on the item, or a reply under `threadId`. `html` must be escaped already (render.ts toHtml). */
  postUpdate(itemId: string, html: string, threadId?: string | null): Promise<string>
  like(updateId: string): Promise<void>
  archiveItem(itemId: string): Promise<void>
}

export interface MondayApiOptions {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const MAX_ATTEMPTS = 3
const PAGE_SIZE = 100
/** 2,000 items: the board keeps what is open and 14 days of what is done, so more means something is wrong. */
const MAX_PAGES = 20
const ID_RE = /^\d+$/
const COLUMN_RE = /^[a-z0-9_]+$/
/** Monday's limits, which it reports as GraphQL errors too: the minute, the day, the complexity budget, concurrency. */
const LIMIT_RE = /rate.?limit|daily.?limit|complexity|concurren|maxConcurrency|timeout|internal.?server.?error/i

const ITEM_FIELDS = `
  id name url created_at creator_id
  group { id }
  column_values(ids: $columns) { id text value }
  updates(limit: 25) { id creator_id text_body created_at replies { id creator_id text_body created_at } }
`

interface RawReply {
  id: string
  creator_id: string | null
  text_body: string | null
  created_at: string
}

interface RawItem {
  id: string
  name: string
  url: string
  created_at: string
  creator_id: string | null
  group: { id: string } | null
  column_values: Array<{ id: string; text: string | null; value: string | null }>
  updates: Array<RawReply & { replies?: RawReply[] | null }> | null
}

function toItem(raw: RawItem): MondayItem {
  const updates: MondayUpdate[] = []
  for (const u of raw.updates ?? []) {
    updates.push({ id: u.id, creatorId: u.creator_id ?? null, text: u.text_body ?? "", createdAt: u.created_at, threadId: u.id })
    for (const r of u.replies ?? []) updates.push({ id: r.id, creatorId: r.creator_id ?? null, text: r.text_body ?? "", createdAt: r.created_at, threadId: u.id })
  }
  return {
    id: raw.id,
    name: raw.name,
    url: raw.url,
    groupId: raw.group?.id ?? "",
    creatorId: raw.creator_id ?? null,
    createdAt: raw.created_at,
    columns: Object.fromEntries(raw.column_values.map((c) => [c.id, { text: c.text, value: c.value }])),
    updates,
  }
}

function checked(value: string, re: RegExp, what: string): string {
  if (!re.test(value)) throw new Error(`Monday: ${JSON.stringify(value)} is not a ${what}`)
  return value
}

/** An activity log's time: Monday's own count of 100-nanosecond ticks since 1970, or an ISO string. */
function logTime(createdAt: string): string {
  const ticks = Number(createdAt)
  if (/^\d{15,}$/.test(createdAt) && Number.isFinite(ticks)) return new Date(Math.floor(ticks / 10_000)).toISOString()
  return createdAt
}

/** What a changed column now says, from its log entry: a long text's `text`, or the log's own text value. */
function changedText(data: Record<string, unknown>): string | null {
  const value = data.value
  if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string") return (value as { text: string }).text
  return typeof data.textual_value === "string" ? data.textual_value : null
}

export function createMondayApi(token: string, opts: MondayApiOptions = {}): MondayApi {
  const doFetch = opts.fetch ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  async function request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let last = ""
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt) await sleep(2_000 * 2 ** (attempt - 1))
      const res = await doFetch(MONDAY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: token, "API-Version": MONDAY_API_VERSION },
        body: JSON.stringify({ query, variables }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 429 || res.status >= 500) {
        last = `status ${res.status}`
        continue
      }
      type Problem = { message?: string; extensions?: { code?: string } }
      const json = (await res.json().catch(() => null)) as { data?: T; errors?: Problem[]; error_message?: string; error_code?: string } | null
      const problems = [...(json?.errors ?? []).map((e) => e.message ?? "an error"), ...(json?.error_message ? [json.error_message] : [])]
      if (problems.length) {
        const message = `Monday: ${redact(problems.join("; "))}`
        const codes = [json?.error_code ?? "", ...(json?.errors ?? []).map((e) => e.extensions?.code ?? "")].join(" ")
        // A limit is Monday out of reach for a while, as a 429 is: not a refusal of this request.
        throw LIMIT_RE.test(`${codes} ${message}`) ? new Error(message) : new MondayRefused(message)
      }
      if (!res.ok || !json?.data) throw new Error(`Monday: status ${res.status} with no data`)
      return json.data
    }
    throw new Error(`Monday: gave up after ${MAX_ATTEMPTS} attempts (${last})`)
  }

  return {
    async me() {
      const data = await request<{ me: { id: string; name: string; is_admin: boolean } }>(`query { me { id name is_admin } }`)
      return { id: String(data.me.id), name: data.me.name, isAdmin: Boolean(data.me.is_admin) }
    },

    async readBoard(boardId, columnIds, watch) {
      type RawLog = { id: string; event: string; data: string; user_id: string; created_at: string }
      // The log's arguments are written into the query, checked first: their types vary between API versions.
      const first = await request<{
        boards: Array<{ groups: Array<{ id: string; title: string }>; items_page: { cursor: string | null; items: RawItem[] }; activity_logs: RawLog[] | null }>
      }>(
        `query($board: [ID!], $columns: [String!]) {
           boards(ids: $board) {
             groups { id title }
             items_page(limit: ${PAGE_SIZE}) { cursor items { ${ITEM_FIELDS} } }
             activity_logs(column_ids: ["${checked(watch.columnId, COLUMN_RE, "Monday column id")}"], from: "${watch.since.toISOString()}", limit: 500) {
               id event data user_id created_at
             }
           }
         }`,
        { board: [checked(boardId, ID_RE, "Monday id")], columns: columnIds },
      )
      const board = first.boards[0]
      if (!board) throw new Error(`Monday: no board ${boardId}, or the token's user cannot see it`)
      const items = board.items_page.items.map(toItem)
      let cursor = board.items_page.cursor
      for (let page = 1; cursor; page++) {
        if (page >= MAX_PAGES) throw new Error(`Monday: board ${boardId} has more than ${MAX_PAGES * PAGE_SIZE} items`)
        const next = await request<{ next_items_page: { cursor: string | null; items: RawItem[] } }>(
          `query($cursor: String!, $columns: [String!]) { next_items_page(limit: ${PAGE_SIZE}, cursor: $cursor) { cursor items { ${ITEM_FIELDS} } } }`,
          { cursor, columns: columnIds },
        )
        items.push(...next.next_items_page.items.map(toItem))
        cursor = next.next_items_page.cursor
      }
      const changes: ColumnChange[] = []
      for (const log of board.activity_logs ?? []) {
        if (log.event !== "update_column_value") continue
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(log.data)
        } catch {
          continue
        }
        if (parsed.column_id !== watch.columnId || parsed.pulse_id === undefined) continue
        const text = changedText(parsed)
        if (text === null) continue
        changes.push({ id: String(log.id), itemId: String(parsed.pulse_id), userId: String(log.user_id), text, at: logTime(String(log.created_at)) })
      }
      return { groups: board.groups, items, changes: changes.sort((a, b) => a.at.localeCompare(b.at)) }
    },

    async dailyLimit() {
      // Only at the root, where monday allows platform_api.
      const data = await request<{ platform_api: { daily_limit: { base: number | null; total: number | null } | null } | null }>(
        `query { platform_api { daily_limit { base total } } }`,
      )
      const limit = data.platform_api?.daily_limit
      return limit?.total ?? limit?.base ?? null
    },

    async createItem(boardId, groupId, name, values) {
      const data = await request<{ create_item: { id: string } }>(
        `mutation($board: ID!, $group: String!, $name: String!, $values: JSON!) {
           create_item(board_id: $board, group_id: $group, item_name: $name, column_values: $values, create_labels_if_missing: false) { id }
         }`,
        { board: boardId, group: groupId, name, values: JSON.stringify(values) },
      )
      return String(data.create_item.id)
    },

    async setColumns(boardId, itemId, values) {
      await request(
        `mutation($board: ID!, $item: ID!, $values: JSON!) {
           change_multiple_column_values(board_id: $board, item_id: $item, column_values: $values, create_labels_if_missing: false) { id }
         }`,
        { board: boardId, item: itemId, values: JSON.stringify(values) },
      )
    },

    async moveItem(itemId, groupId) {
      await request(`mutation($item: ID!, $group: String!) { move_item_to_group(item_id: $item, group_id: $group) { id } }`, { item: itemId, group: groupId })
    },

    async postUpdate(itemId, html, threadId = null) {
      const data = await request<{ create_update: { id: string } }>(
        `mutation($item: ID!, $body: String!, $parent: ID) { create_update(item_id: $item, body: $body, parent_id: $parent) { id } }`,
        { item: itemId, body: html, parent: threadId },
      )
      return String(data.create_update.id)
    },

    async like(updateId) {
      await request(`mutation($update: ID!) { like_update(update_id: $update) { id } }`, { update: updateId })
    },

    async archiveItem(itemId) {
      await request(`mutation($item: ID!) { archive_item(item_id: $item) { id } }`, { item: itemId })
    },
  }
}
