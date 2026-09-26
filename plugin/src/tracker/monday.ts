/**
 * The Monday implementation of the Tracker interface.
 *
 * CUTOVER-WEEKEND ONLY (spec section 10). It exists so the three skills work
 * the day they ship, before the Linear workspace exists, and so the cutover
 * is one config key. Delete this file once `tracker.provider` has been
 * `linear` in production for a release.
 *
 * It is DELIBERATELY minimal and lossy:
 *  - no subtasks, no sprint, no epic, no hours. An issue opened by /ship is a
 *    traceability record; /refine turns one into a refined task.
 *  - `attachLink` posts an update rather than writing a link column. Monday
 *    has no per-item link primitive that takes a title, and overloading
 *    prLink vs demoUrl by sniffing the title would be a guess.
 *  - `priority` is always 0 and `listReady` therefore falls back to oldest
 *    first, and only across the first `limit` items it fetched rather than
 *    the whole queue. Mapping Monday's priority index onto Linear's 0-4 scale
 *    and paging items_page would be work for a surface being retired.
 *
 * It does NOT go through the 45 MCP tools: those return formatted strings for
 * a human to read, and parsing an item id back out of one is the brittleness
 * this adapter exists to avoid.
 */

import { executeMondayQuery } from "../monday-client.ts"
import { BOARDS, TASK_COLUMNS, TASK_STATUS } from "../constants.ts"
import { getTaskDescriptionDoc } from "../tools/taskDescriptionDoc.ts"
import {
  byPriorityThenAge,
  extractAcceptanceCriteria,
  type CreateIssueInput,
  type Tracker,
  type TrackerIssue,
} from "./types.ts"

const DOC_HEADER_RE = /^#\s*Description Doc\s*[—-]\s*Task\s*#\d+\s*\(doc\s*\d+\)\s*$/
const EMPTY_DOC = "_(empty doc)_"
// The real shape of formatError() (plugin/src/tools/utils.ts:700) is a
// heading line, "# Error", not an "ERROR:" prefix. Both are checked: the
// heading is what getTaskDescriptionDoc actually returns on failure, and the
// "ERROR:"/"Failed" prefix is kept as a defensive catch-all for any other
// tool-error shape this helper might someday be fed.
const ERROR_HEADING_RE = /^#\s*Error\s*$/i

/**
 * `getTaskDescriptionDoc` returns a human-facing string: a heading line, a
 * blank line, then the markdown. Turn that back into just the markdown, and
 * answer an error string or an empty doc with "".
 */
export function stripDescriptionDocHeader(raw: string): string {
  if (!raw) return ""
  const trimmedRaw = raw.trim()
  if (/^(ERROR|Failed)\b/i.test(trimmedRaw)) return ""

  const lines = raw.split("\n")
  const firstLine = lines[0].trim()
  if (ERROR_HEADING_RE.test(firstLine)) return ""

  const body = DOC_HEADER_RE.test(firstLine) ? lines.slice(1).join("\n") : raw
  const trimmed = body.trim()
  return trimmed === EMPTY_DOC ? "" : trimmed
}

interface RawItem {
  id: string
  name: string
  url: string
  updated_at: string
  column_values: Array<{ id: string; text: string | null }>
}

function columnText(item: RawItem, columnId: string): string {
  return item.column_values.find((c) => c.id === columnId)?.text ?? ""
}

async function fetchItem(itemId: string): Promise<RawItem> {
  const data = await executeMondayQuery<{ items: RawItem[] }>(
    `query($ids: [ID!]) {
       items(ids: $ids) {
         id name url updated_at
         column_values { id text }
       }
     }`,
    { ids: [itemId] },
  )
  const item = data.items?.[0]
  if (!item) throw new Error(`Monday: no item ${itemId}`)
  return item
}

async function toIssue(item: RawItem): Promise<TrackerIssue> {
  const description = stripDescriptionDocHeader(await getTaskDescriptionDoc({ taskId: Number(item.id) }))
  return {
    id: item.id,
    uuid: item.id,
    title: item.name,
    description,
    acceptanceCriteria: extractAcceptanceCriteria(description),
    state: columnText(item, TASK_COLUMNS.status),
    labels: [columnText(item, TASK_COLUMNS.type)].filter(Boolean),
    url: item.url,
    priority: 0,
    updatedAt: item.updated_at,
    assigneeId: null,
  }
}

/** Sub-issues and projects (Wave 2): Linear has them, a Monday item has neither. */
const LINEAR_SHAPES = "Projects and sub-issues are Linear's: the Monday tracker has neither. Set tracker.provider to \"linear\"."

/** Methods only the agent runtime uses. The runtime requires Linear; this adapter is cutover-only. */
function linearOnly(method: string): () => Promise<never> {
  return async () => {
    throw new Error(`${method} needs tracker.provider "linear". The Monday adapter is kept for the cutover weekend only.`)
  }
}

export function createMondayTracker(): Tracker {
  return {
    kind: "monday",

    async readIssue(ref) {
      return toIssue(await fetchItem(ref))
    },

    async claimIssue(ref, claimant) {
      await executeMondayQuery(
        `mutation($board: ID!, $item: ID!, $column: String!, $value: JSON!) {
           change_column_value(board_id: $board, item_id: $item, column_id: $column, value: $value) { id }
         }`,
        {
          board: String(BOARDS.TASKS),
          item: ref,
          column: TASK_COLUMNS.status,
          value: JSON.stringify({ index: TASK_STATUS["In Progress"] }),
        },
      )
      await executeMondayQuery(
        `mutation($item: ID!, $body: String!) {
           create_update(item_id: $item, body: $body) { id }
         }`,
        { item: ref, body: `claimed by ${claimant} at ${new Date().toISOString()}` },
      )
      return toIssue(await fetchItem(ref))
    },

    async createIssue(input: CreateIssueInput) {
      if (input.parent || input.projectId || input.milestoneId) throw new Error(LINEAR_SHAPES)
      const data = await executeMondayQuery<{ create_item: { id: string } }>(
        `mutation($board: ID!, $name: String!) {
           create_item(board_id: $board, item_name: $name) { id }
         }`,
        { board: String(BOARDS.TASKS), name: input.title },
      )
      const id = data.create_item.id
      if (input.description) {
        await executeMondayQuery(
          `mutation($item: ID!, $body: String!) {
             create_update(item_id: $item, body: $body) { id }
           }`,
          { item: id, body: input.description },
        )
      }
      return toIssue(await fetchItem(id))
    },

    async comment(ref, body) {
      await executeMondayQuery(
        `mutation($item: ID!, $body: String!) {
           create_update(item_id: $item, body: $body) { id }
         }`,
        { item: ref, body },
      )
    },

    async attachLink(ref, url, title) {
      await executeMondayQuery(
        `mutation($item: ID!, $body: String!) {
           create_update(item_id: $item, body: $body) { id }
         }`,
        { item: ref, body: `**${title}**: ${url}` },
      )
    },

    // `only` is kept to after the page: Monday has no id filter for this query, and Monday is read-only legacy.
    async listReady(limit = 25, only) {
      const data = await executeMondayQuery<{
        boards: Array<{ items_page: { items: RawItem[] } }>
      }>(
        `query($board: ID!, $limit: Int!, $column: String!) {
           boards(ids: [$board]) {
             items_page(
               limit: $limit,
               query_params: { rules: [{ column_id: $column, compare_value: [${TASK_STATUS["Ready to Start"]}], operator: any_of }] }
             ) {
               items { id name url updated_at column_values { id text } }
             }
           }
         }`,
        { board: String(BOARDS.TASKS), limit, column: TASK_COLUMNS.status },
      )
      const items = data.boards?.[0]?.items_page?.items ?? []
      const issues = await Promise.all(items.map(toIssue))
      return issues.filter((i) => !only || only.includes(i.id)).sort(byPriorityThenAge)
    },

    whoami: linearOnly("whoami"),
    updateIssue: linearOnly("updateIssue"),
    touchClaim: linearOnly("touchClaim"),
    releaseIssue: linearOnly("releaseIssue"),
    listClaims: linearOnly("listClaims"),
    listByState: linearOnly("listByState"),
    createProject: async () => {
      throw new Error(LINEAR_SHAPES)
    },
  }
}
