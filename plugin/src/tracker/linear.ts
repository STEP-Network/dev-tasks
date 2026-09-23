/**
 * The Linear implementation of the Tracker interface.
 *
 * Workspace assumptions, all created by `pnpm linear:bootstrap` in the PolAds
 * repo (scripts/linear/model.ts): one team with key STEP, twelve states in
 * board order with `Ready` and `In Progress` among them, and the label groups
 * product/ type/ flag/ lock/ source/ bug-status/. Labels are addressed by
 * their bare child name, not the group-qualified path — e.g. `chore`, not
 * `type/chore`.
 */

import { randomUUID } from "node:crypto"
import { LinearCreateConflictError, linearRequest } from "./linear-client.ts"
import {
  byPriorityThenAge,
  extractAcceptanceCriteria,
  LINEAR_TEAM_KEY,
  type CreateIssueInput,
  type IssuePriority,
  type Tracker,
  type TrackerIssue,
} from "./types.ts"

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  updatedAt
  state { name }
  labels { nodes { name } }
`

interface RawIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  url: string
  priority: number
  updatedAt: string
  state: { name: string } | null
  labels: { nodes: Array<{ name: string }> }
}

/** A Relay connection page, as Linear returns one. */
interface Connection<N> {
  nodes: N[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}

type Named = { id: string; name: string }

interface RawTeam {
  id: string
  key: string
  name: string
  states: { nodes: Named[] }
  labels: Connection<Named>
}

/** The team as cached: its labels already gathered from every page. */
interface Team {
  id: string
  states: Named[]
  labels: Named[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENTIFIER_RE = /^([A-Za-z]+)-(\d+)$/

/*
 * Page sizes are bounded by complexity, not by count. Linear refuses any
 * single query over 10,000 points: 0.1 per field, 1 per object, and each
 * connection multiplies its children by its `first` (50 when omitted).
 * A label is ~1.2 points, so 250 labels is ~300. An ISSUE_FIELDS issue is
 * ~58, most of it the nested labels connection at its default 50, so 100
 * issues is ~5,800 and 250 would be ~14,500 and refused outright.
 */
const LABEL_PAGE_SIZE = 250
const READY_PAGE_SIZE = 100
const PAGE_INFO = `pageInfo { hasNextPage endCursor }`

/**
 * Every node of a connection: `page` is the first page, `next` fetches the
 * page after a cursor. A cursor that does not advance throws rather than
 * spin forever or hand back a silently short list.
 */
async function allNodes<N>(
  page: Connection<N>,
  next: (after: string) => Promise<Connection<N>>,
): Promise<N[]> {
  const nodes = [...page.nodes]
  let cursor: string | null = null
  while (page.pageInfo.hasNextPage) {
    const after = page.pageInfo.endCursor
    if (!after || after === cursor) {
      throw new Error("Linear: a paged query stopped advancing its cursor")
    }
    cursor = after
    page = await next(after)
    nodes.push(...page.nodes)
  }
  return nodes
}

/**
 * Settles a create whose retry Linear refused as already existing. The id is
 * ours, so if it reads back, the earlier attempt landed and that entity IS the
 * result. If it does not, the conflict was Linear's own phantom and the
 * original error stands: calling it a success would lose the write silently.
 */
async function settleConflict<T>(error: unknown, readBack: () => Promise<T | null>): Promise<T> {
  if (!(error instanceof LinearCreateConflictError)) throw error
  const landed = await readBack().catch(() => null)
  if (landed) return landed
  throw error
}

function toIssue(raw: RawIssue): TrackerIssue {
  const description = raw.description ?? ""
  return {
    id: raw.identifier,
    uuid: raw.id,
    title: raw.title,
    description,
    acceptanceCriteria: extractAcceptanceCriteria(description),
    state: raw.state?.name ?? "",
    labels: raw.labels.nodes.map((l) => l.name),
    url: raw.url,
    priority: (raw.priority ?? 0) as IssuePriority,
    updatedAt: raw.updatedAt,
  }
}

export function createLinearTracker(): Tracker {
  let teamCache: Team | null = null

  async function team(): Promise<Team> {
    if (teamCache) return teamCache
    // `first: 1` is load-bearing: without it the teams connection counts as
    // 50, and 50 x labels(first: 250) is far past the complexity cap.
    const data = await linearRequest<{ teams: { nodes: RawTeam[] } }>(
      `query($key: String!) {
         teams(first: 1, filter: { key: { eq: $key } }) {
           nodes {
             id key name
             states { nodes { id name } }
             labels(first: ${LABEL_PAGE_SIZE}) { nodes { id name } ${PAGE_INFO} }
           }
         }
       }`,
      { key: LINEAR_TEAM_KEY },
    )
    const found = data.teams.nodes[0]
    if (!found) {
      throw new Error(
        `Linear: no team with key ${LINEAR_TEAM_KEY}. ` +
          `Run \`pnpm linear:bootstrap --apply\` in the PolAds repo first.`,
      )
    }
    // Every page: the migration's epic/<slug> labels alone can fill one, and
    // a label past the first page was skipped as if it did not exist.
    const labels = await allNodes(found.labels, async (after) => {
      const next = await linearRequest<{ team: { labels: Connection<Named> } }>(
        `query($id: String!, $after: String!) {
           team(id: $id) {
             labels(first: ${LABEL_PAGE_SIZE}, after: $after) { nodes { id name } ${PAGE_INFO} }
           }
         }`,
        { id: found.id, after },
      )
      return next.team.labels
    })
    teamCache = { id: found.id, states: found.states.nodes, labels }
    return teamCache
  }

  async function stateIdFor(name: string | undefined): Promise<string | undefined> {
    if (!name) return undefined
    const t = await team()
    // A bogus stateId fails the whole mutation; omitting it lets Linear apply
    // the team default, which is the right fallback for a /ship issue.
    return t.states.find((s) => s.name === name)?.id
  }

  async function labelIdsFor(names: string[] | undefined): Promise<string[] | undefined> {
    if (!names || names.length === 0) return undefined
    const t = await team()
    const ids = names
      .map((n) => t.labels.find((l) => l.name === n)?.id)
      .filter((id): id is string => Boolean(id))
    return ids.length ? ids : undefined
  }

  async function fetchRaw(ref: string): Promise<RawIssue> {
    const trimmed = ref.trim()

    if (UUID_RE.test(trimmed)) {
      const data = await linearRequest<{ issue: RawIssue | null }>(
        `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
        { id: trimmed },
      )
      if (!data.issue) throw new Error(`Linear: no issue with id ${trimmed}`)
      return data.issue
    }

    const m = IDENTIFIER_RE.exec(trimmed)
    if (!m) {
      throw new Error(`Not a Linear issue reference: ${trimmed} (expected STEP-123 or a UUID)`)
    }
    // Resolve by team key + number. `issue(id:)` is documented for the UUID;
    // filtering on the number is unambiguous and needs no assumption about
    // whether the identifier form is accepted there.
    const data = await linearRequest<{ issues: { nodes: RawIssue[] } }>(
      `query($teamKey: String!, $number: Float!) {
         issues(first: 1, filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }) {
           nodes { ${ISSUE_FIELDS} }
         }
       }`,
      { teamKey: m[1].toUpperCase(), number: Number(m[2]) },
    )
    const found = data.issues.nodes[0]
    if (!found) throw new Error(`Linear: no issue ${trimmed} on team ${m[1].toUpperCase()}`)
    return found
  }

  async function userIdFor(claimant: string): Promise<string | undefined> {
    const data = await linearRequest<{ users: { nodes: Array<{ id: string }> } }>(
      `query($q: String!) {
         users(first: 1, filter: { or: [{ email: { eq: $q } }, { displayName: { eq: $q } }] }) {
           nodes { id }
         }
       }`,
      { q: claimant },
    )
    return data.users.nodes[0]?.id
  }

  async function createComment(issueId: string, body: string): Promise<void> {
    // Our own id, so a retry after a lost answer cannot post the comment twice.
    const id = randomUUID()
    try {
      await linearRequest(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
        { input: { id, issueId, body } },
      )
    } catch (error) {
      await settleConflict(error, async () => {
        const data = await linearRequest<{ comment: { id: string } | null }>(
          `query($id: String!) { comment(id: $id) { id } }`,
          { id },
        )
        return data.comment
      })
    }
  }

  return {
    kind: "linear",

    async readIssue(ref) {
      return toIssue(await fetchRaw(ref))
    },

    async claimIssue(ref, claimant) {
      const raw = await fetchRaw(ref)
      const stateId = await stateIdFor("In Progress")
      // A mini is not a Linear member, so this is EXPECTED to miss most of
      // the time. The claim is still recorded as a comment, which is what
      // the 6-hour claim TTL reads.
      const assigneeId = await userIdFor(claimant)

      const input: Record<string, unknown> = {}
      if (stateId) input.stateId = stateId
      if (assigneeId) input.assigneeId = assigneeId

      if (Object.keys(input).length > 0) {
        await linearRequest(
          `mutation($id: String!, $input: IssueUpdateInput!) {
             issueUpdate(id: $id, input: $input) { success }
           }`,
          { id: raw.id, input },
        )
      }

      await createComment(raw.id, `claimed by ${claimant} at ${new Date().toISOString()}`)

      return toIssue(await fetchRaw(ref))
    },

    async createIssue(input: CreateIssueInput) {
      const t = await team()
      const stateId = await stateIdFor(input.state)
      const labelIds = await labelIdsFor(input.labels)

      // Our own id, so a retry after a lost answer names this issue rather
      // than opening a second one.
      const id = randomUUID()
      const payload: Record<string, unknown> = { id, teamId: t.id, title: input.title }
      if (input.description) payload.description = input.description
      if (stateId) payload.stateId = stateId
      if (labelIds) payload.labelIds = labelIds

      try {
        const data = await linearRequest<{ issueCreate: { issue: RawIssue } }>(
          `mutation($input: IssueCreateInput!) {
             issueCreate(input: $input) { issue { ${ISSUE_FIELDS} } }
           }`,
          { input: payload },
        )
        return toIssue(data.issueCreate.issue)
      } catch (error) {
        return toIssue(await settleConflict(error, () => fetchRaw(id)))
      }
    },

    async comment(ref, body) {
      const raw = await fetchRaw(ref)
      await createComment(raw.id, body)
    },

    async attachLink(ref, url, title) {
      const raw = await fetchRaw(ref)
      await linearRequest(
        `mutation($issueId: String!, $url: String!, $title: String) {
           attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
         }`,
        { issueId: raw.id, url, title },
      )
    },

    async listReady(limit = 25) {
      // The WHOLE queue, then the sort, then the limit. Linear pages in
      // createdAt order, so sorting one page misses a new Urgent issue that
      // sits on a later one.
      const page = async (after: string | null) => {
        const data = await linearRequest<{ issues: Connection<RawIssue> }>(
          `query($teamKey: String!, $stateName: String!, $first: Int!, $after: String) {
             issues(
               first: $first,
               after: $after,
               filter: { team: { key: { eq: $teamKey } }, state: { name: { eq: $stateName } } }
             ) {
               nodes { ${ISSUE_FIELDS} }
               ${PAGE_INFO}
             }
           }`,
          { teamKey: LINEAR_TEAM_KEY, stateName: "Ready", first: READY_PAGE_SIZE, after },
        )
        return data.issues
      }
      const nodes = await allNodes(await page(null), page)
      return nodes.map(toIssue).sort(byPriorityThenAge).slice(0, limit)
    },
  }
}
