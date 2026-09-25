/**
 * What the Monday bridge reads from Linear that the Tracker contract does not
 * carry (STEP-3289): who owns and who asked for an issue (for the Person
 * column), its due date, its PR, and the steps a person must check before a
 * release. Agents never need these, so they stay here, on the plugin's own
 * Linear transport, and out of the adapter every agent flow shares.
 */

import { LINEAR_TEAM_KEY, linearRequest } from "../tracker.ts"

export type LinearRequest = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>

export interface LinearPerson {
  name: string
  email: string
}

export interface PeopleIssue {
  id: string
  uuid: string
  title: string
  description: string
  url: string
  state: string
  /** Linear's type for the state: completed (Released), canceled, duplicate, started, and so on. */
  stateType: string
  labels: string[]
  /** The assignee: an agent's account while an agent holds it, else a person's. */
  owner: LinearPerson | null
  /** Who created it. */
  requester: LinearPerson | null
  /** YYYY-MM-DD */
  dueDate: string | null
  /** The GitHub PR Linear's integration attached, if any. */
  prUrl: string | null
  /** The "You must check" section of its newest Agent UAT review comment, as written. */
  uatSteps: string | null
}

export interface PeopleView {
  /** Open issues a person must act on: needs-human, or a question (awaiting-answer) or to-do (human-todo) it is On hold for. */
  needsYou(): Promise<PeopleIssue[]>
  /** Every issue in Waiting for UAT. */
  waitingForUat(): Promise<PeopleIssue[]>
  /** Issues by identifier (STEP-7). Unknown ones are left out. */
  byIdentifiers(ids: string[]): Promise<PeopleIssue[]>
  /** Makes one issue (by uuid) a sub-issue of another. */
  setParent(childUuid: string, parentUuid: string): Promise<void>
}

export const NEEDS_LABELS = ["needs-human", "human-todo", "awaiting-answer"]
/** The labels that ask a person only while the issue is parked for them. */
const PARKED_LABELS = ["human-todo", "awaiting-answer"]

const UAT_REVIEW_PREFIX = "# UAT review"
const PR_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/

/*
 * ~90 complexity points an issue (labels at 50, attachments and comments at
 * 10 each), so a page of 50 is ~4,500, under Linear's 10,000 a query
 * (plugin/src/tracker/linear.ts has the arithmetic).
 */
const PAGE_SIZE = 50
const MAX_PAGES = 10
const FIELDS = `
  id identifier title description url dueDate
  state { name type }
  labels(first: 50) { nodes { name } }
  assignee { name email }
  creator { name email }
  attachments(first: 10) { nodes { url } }
  comments(first: 10, filter: { body: { startsWith: "${UAT_REVIEW_PREFIX}" } }) { nodes { body createdAt } }
`

interface RawIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  url: string
  dueDate: string | null
  state: { name: string; type: string } | null
  labels: { nodes: Array<{ name: string }> }
  assignee: LinearPerson | null
  creator: LinearPerson | null
  attachments: { nodes: Array<{ url: string }> }
  comments: { nodes: Array<{ body: string; createdAt: string }> }
}

type Page = { issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }

/** The "You must check" section of the newest Agent UAT review (the PolAds review-uat skill's format), or null. */
export function uatSteps(comments: Array<{ body: string; createdAt: string }>): string | null {
  const newest = comments.filter((c) => c.body.startsWith(UAT_REVIEW_PREFIX)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (!newest) return null
  const lines = newest.body.split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s.*you must check/i.test(line))
  if (start === -1) return null
  const end = lines.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line))
  const section = lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim()
  return section || null
}

function toIssue(raw: RawIssue): PeopleIssue {
  return {
    id: raw.identifier,
    uuid: raw.id,
    title: raw.title,
    description: raw.description ?? "",
    url: raw.url,
    state: raw.state?.name ?? "",
    stateType: raw.state?.type ?? "",
    labels: raw.labels.nodes.map((l) => l.name),
    owner: raw.assignee,
    requester: raw.creator,
    dueDate: raw.dueDate,
    prUrl: raw.attachments.nodes.map((a) => a.url).find((url) => PR_RE.test(url)) ?? null,
    uatSteps: uatSteps(raw.comments.nodes),
  }
}

export function createPeopleView(request: LinearRequest = linearRequest): PeopleView {
  /** Every page of one filter. A cursor that does not advance, or too many pages, throws: a short list would close items that are still open. */
  async function all(filter: string, params: string, variables: Record<string, unknown>): Promise<PeopleIssue[]> {
    const issues: PeopleIssue[] = []
    let after: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const data: Page = await request<Page>(
        `query($team: String!, $first: Int!, $after: String${params}) {
           issues(first: $first, after: $after, filter: { team: { key: { eq: $team } }, ${filter} }) {
             nodes { ${FIELDS} }
             pageInfo { hasNextPage endCursor }
           }
         }`,
        { team: LINEAR_TEAM_KEY, first: PAGE_SIZE, after, ...variables },
      )
      issues.push(...data.issues.nodes.map(toIssue))
      if (!data.issues.pageInfo.hasNextPage) return issues
      const next = data.issues.pageInfo.endCursor
      if (!next || next === after) throw new Error("Linear: a paged query stopped advancing its cursor")
      after = next
    }
    throw new Error(`Linear: more than ${MAX_PAGES * PAGE_SIZE} issues for the Monday board`)
  }

  return {
    async needsYou() {
      const found = await all(
        `labels: { some: { name: { in: $labels } } }, state: { type: { nin: ["completed", "canceled", "duplicate"] } }`,
        ", $labels: [String!]",
        { labels: NEEDS_LABELS },
      )
      return found.filter((i) => i.labels.includes("needs-human") || (i.state === "On hold" && PARKED_LABELS.some((l) => i.labels.includes(l))))
    },

    async waitingForUat() {
      return all(`state: { name: { eq: $state } }`, ", $state: String!", { state: "Waiting for UAT" })
    },

    async byIdentifiers(ids) {
      const numbers = ids.map((id) => new RegExp(`^${LINEAR_TEAM_KEY}-(\\d+)$`).exec(id)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1]))
      if (!numbers.length) return []
      return all(`number: { in: $numbers }`, ", $numbers: [Float!]", { numbers })
    },

    async setParent(childUuid, parentUuid) {
      await request(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, {
        id: childUuid,
        input: { parentId: parentUuid },
      })
    },
  }
}
