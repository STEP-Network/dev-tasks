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
import { linearRequest } from "./linear-client.ts"
import {
  byPriorityThenAge,
  CLAIM_PREFIX,
  claimCommentBody,
  extractAcceptanceCriteria,
  LINEAR_TEAM_KEY,
  newestClaim,
  withHeartbeat,
  type ClaimComment,
  type ClaimRecord,
  type CreateIssueInput,
  type IssuePatch,
  type IssuePriority,
  type Tracker,
  type TrackerIssue,
  type TrackerUser,
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
  assignee { id }
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
  assignee: { id: string } | null
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
 * connection multiplies its children by its `first` (50 when omitted). An
 * API key's user also gets only 3M points an hour, which a front door
 * polling every minute spends quickly.
 * - A label is ~1.2 points, so 250 labels is ~300.
 * - A ranking node (id, priority, updatedAt) is ~1.3, so 250 is ~330.
 * - An ISSUE_FIELDS issue is ~59, most of it the nested labels connection
 *   at its default 50 (the assignee adds ~1.1), so 100 full issues is
 *   ~5,900 and 250 would be ~14,750 and refused outright.
 * - A claim node is an ISSUE_FIELDS issue plus up to CLAIM_COMMENTS claim
 *   comments at ~1.4 each, ~88, so 50 is ~4,400.
 */
const LABEL_PAGE_SIZE = 250
const READY_PAGE_SIZE = 250
const FULL_ISSUE_CHUNK = 100
const CLAIM_PAGE_SIZE = 50
const CLAIM_COMMENTS = 20
const PAGE_INFO = `pageInfo { hasNextPage endCursor }`
const CLAIM_COMMENT_FIELDS = `comments(first: ${CLAIM_COMMENTS}, filter: { body: { startsWith: $prefix } }) { nodes { id body createdAt editedAt } }`

/** What ranking a state's queue needs, and nothing else. */
interface RankNode {
  id: string
  priority: number
  updatedAt: string
}

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
 * Settles a create that threw, whatever the error said: a 5xx that outlasted
 * the retries, a refused retry in any wording, a dropped connection. The id
 * is a fresh UUID minted by this very call, or a caller's clientId that
 * names the same entity on every attempt (createIssue), so if it reads back,
 * a write for it landed and that entity IS the result. If it does not, the create
 * really failed and its own error stands. (Linear also reports phantom
 * insert conflicts for ids nothing holds, so no wording alone is proof.)
 */
async function readBackAfterFailure<T>(error: unknown, readBack: () => Promise<T | null>): Promise<T> {
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
    assigneeId: raw.assignee?.id ?? null,
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

  let viewerCache: TrackerUser | null = null

  async function viewer(): Promise<TrackerUser> {
    if (viewerCache) return viewerCache
    const data = await linearRequest<{ viewer: TrackerUser }>(`query { viewer { id name email } }`)
    viewerCache = data.viewer
    return data.viewer
  }

  /**
   * Label ids for an update. Unlike labelIdsFor (createIssue's lenient
   * lookup), an unknown name throws: parking an issue without its
   * `awaiting-answer` label would put it straight back in the queue.
   */
  async function strictLabelIds(names: string[]): Promise<string[]> {
    const t = await team()
    return names.map((name) => {
      const hit = t.labels.find((l) => l.name === name)
      if (!hit) throw new Error(`Linear: no label named ${name}`)
      return hit.id
    })
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

  /**
   * The first `limit` issues in a state, in byPriorityThenAge order. Ranks
   * the WHOLE state, then fetches full issues for the winners only: Linear
   * pages in its own order, not by priority, so sorting one page misses an
   * Urgent issue on a later one. Ranking needs three fields, and paging full
   * issues instead cost ~5,900 points a page.
   */
  async function listInState(stateName: string, limit: number): Promise<TrackerIssue[]> {
    const where = { teamKey: LINEAR_TEAM_KEY, stateName }
    const page = async (after: string | null) => {
      const data = await linearRequest<{ issues: Connection<RankNode> }>(
        `query($teamKey: String!, $stateName: String!, $first: Int!, $after: String) {
           issues(
             first: $first,
             after: $after,
             filter: { team: { key: { eq: $teamKey } }, state: { name: { eq: $stateName } } }
           ) {
             nodes { id priority updatedAt }
             ${PAGE_INFO}
           }
         }`,
        { ...where, first: READY_PAGE_SIZE, after },
      )
      return data.issues
    }
    const ranked = (await allNodes(await page(null), page)).sort(byPriorityThenAge).slice(0, limit)

    const full = new Map<string, RawIssue>()
    for (let i = 0; i < ranked.length; i += FULL_ISSUE_CHUNK) {
      const ids = ranked.slice(i, i + FULL_ISSUE_CHUNK).map((node) => node.id)
      // Filtered on the state again: an issue that left it since the ranking
      // (a Ready issue claimed meanwhile) drops out rather than coming back
      // as if it were still there.
      const data = await linearRequest<{ issues: { nodes: RawIssue[] } }>(
        `query($teamKey: String!, $stateName: String!, $ids: [ID!]!, $first: Int!) {
           issues(
             first: $first,
             filter: {
               id: { in: $ids },
               team: { key: { eq: $teamKey } },
               state: { name: { eq: $stateName } }
             }
           ) {
             nodes { ${ISSUE_FIELDS} }
           }
         }`,
        { ...where, ids, first: ids.length },
      )
      for (const raw of data.issues.nodes) full.set(raw.id, raw)
    }
    // Linear answers in its own order; the ranking is ours.
    return ranked.flatMap((node) => {
      const raw = full.get(node.id)
      return raw ? [toIssue(raw)] : []
    })
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
      await readBackAfterFailure(error, async () => {
        const data = await linearRequest<{ comment: { id: string } | null }>(
          `query($id: String!) { comment(id: $id) { id } }`,
          { id },
        )
        return data.comment
      })
    }
  }

  const tracker: Tracker = {
    kind: "linear",

    async readIssue(ref) {
      return toIssue(await fetchRaw(ref))
    },

    async claimIssue(ref, claimant) {
      const raw = await fetchRaw(ref)
      // Every agent is its own Linear member account (2026-09-23, and every
      // person too since 2026-09-24), so the claim IS the assignment to the
      // key's own user. `claimant` names the mini in the comment, whose edit
      // time is the heartbeat.
      const me = await viewer()
      if (raw.assignee && raw.assignee.id !== me.id) {
        throw new Error(`Linear: ${raw.identifier} is assigned to someone else; not claiming it`)
      }
      // Assigned but left in its old state, the issue would be invisible to
      // listClaims (In Progress only), held and never swept. So no state, no claim.
      const stateId = await stateIdFor("In Progress")
      if (!stateId) throw new Error(`Linear: no state named In Progress on team ${LINEAR_TEAM_KEY}; not claiming ${raw.identifier}`)
      const input: Record<string, unknown> = { assigneeId: me.id, stateId }
      // The comment first: if it fails, the issue is simply not claimed. The
      // other way round, a failed comment would leave the issue assigned and
      // In Progress with no claim for the sweeper to find, held for good.
      await createComment(raw.id, claimCommentBody(claimant, new Date().toISOString()))
      await linearRequest(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        { id: raw.id, input },
      )
      return toIssue(await fetchRaw(ref))
    },

    async createIssue(input: CreateIssueInput) {
      // The read-back below resolves whatever id was sent, and it also takes
      // an identifier: a clientId of "STEP-5" would come back as STEP-5.
      if (input.clientId !== undefined && !UUID_RE.test(input.clientId)) {
        throw new Error(`Linear: clientId must be a UUID, got ${JSON.stringify(input.clientId)}`)
      }
      const t = await team()
      const stateId = await stateIdFor(input.state)
      const labelIds = await labelIdsFor(input.labels)

      // Our own id, or the caller's, so a retry after a lost answer names
      // this issue rather than opening a second one.
      const id = input.clientId ?? randomUUID()
      const payload: Record<string, unknown> = { id, teamId: t.id, title: input.title }
      if (input.description) payload.description = input.description
      if (stateId) payload.stateId = stateId
      if (labelIds) payload.labelIds = labelIds

      let created: RawIssue
      try {
        const data = await linearRequest<{ issueCreate: { issue: RawIssue } }>(
          `mutation($input: IssueCreateInput!) {
             issueCreate(input: $input) { issue { ${ISSUE_FIELDS} } }
           }`,
          { input: payload },
        )
        created = data.issueCreate.issue
      } catch (error) {
        return toIssue(await readBackAfterFailure(error, () => fetchRaw(id)))
      }
      if (created.id !== id) {
        // Retries are idempotent only while Linear honours the client id, and
        // this is the one place that would show it stopped.
        process.stderr.write(
          `dev-tasks: Linear gave ${created.identifier} its own id, not the client id sent; ` +
            `a retried create can duplicate.\n`,
        )
      }
      return toIssue(created)
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
      return listInState("Ready", limit)
    },

    async listByState(state, limit = 50) {
      // An unknown or miscased name matches nothing and would read as an
      // empty queue. updateIssue refuses the same name, so this does too.
      if (!(await stateIdFor(state))) throw new Error(`Linear: no state named ${state} on team ${LINEAR_TEAM_KEY}`)
      return listInState(state, limit)
    },

    async whoami() {
      return viewer()
    },

    async updateIssue(ref, patch: IssuePatch) {
      // Resolve every name first, so a bad one throws before anything is written.
      const input: Record<string, unknown> = {}
      if (patch.description !== undefined) input.description = patch.description
      if (patch.state !== undefined) {
        const stateId = await stateIdFor(patch.state)
        if (!stateId) throw new Error(`Linear: no state named ${patch.state} on team ${LINEAR_TEAM_KEY}`)
        input.stateId = stateId
      }
      if (patch.addLabels?.length) input.addedLabelIds = await strictLabelIds(patch.addLabels)
      if (patch.removeLabels?.length) input.removedLabelIds = await strictLabelIds(patch.removeLabels)
      if (patch.assignee === "me") input.assigneeId = (await viewer()).id
      if (patch.assignee === null) input.assigneeId = null

      const raw = await fetchRaw(ref)
      if (Object.keys(input).length === 0) return toIssue(raw)
      const data = await linearRequest<{ issueUpdate: { issue: RawIssue } }>(
        `mutation($id: String!, $input: IssueUpdateInput!) {
           issueUpdate(id: $id, input: $input) { issue { ${ISSUE_FIELDS} } }
         }`,
        { id: raw.id, input },
      )
      return toIssue(data.issueUpdate.issue)
    },

    async touchClaim(ref, claimant) {
      const raw = await fetchRaw(ref)
      const data = await linearRequest<{ issue: { comments: { nodes: ClaimComment[] } } | null }>(
        `query($id: String!, $prefix: String!) {
           issue(id: $id) { ${CLAIM_COMMENT_FIELDS} }
         }`,
        { id: raw.id, prefix: CLAIM_PREFIX },
      )
      const comments = data.issue?.comments.nodes ?? []
      const claim = newestClaim(comments, claimant)
      if (!claim) return false
      const body = comments.find((c) => c.id === claim.commentId)!.body
      await linearRequest(
        `mutation($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }`,
        { id: claim.commentId, input: { body: withHeartbeat(body, new Date().toISOString()) } },
      )
      return true
    },

    async releaseIssue(ref, reason) {
      await tracker.updateIssue(ref, { state: "Ready", assignee: null })
      await tracker.comment(ref, `released: ${reason}`)
    },

    async listClaims() {
      // Only issues the key's owner holds: an agent's claim comment outlives
      // the claim, and an issue a person has since taken must never reach
      // the sweeper as a stale claim to release. Every page: the sweeper
      // releases what this returns, and a claim on an unread page would hold
      // its issue forever.
      const page = async (after: string | null) => {
        const data = await linearRequest<{ issues: Connection<RawIssue & { comments: { nodes: ClaimComment[] } }> }>(
          `query($teamKey: String!, $prefix: String!, $first: Int!, $after: String) {
             issues(first: $first, after: $after, filter: {
               team: { key: { eq: $teamKey } },
               state: { name: { eq: "In Progress" } },
               assignee: { isMe: { eq: true } }
             }) {
               nodes {
                 ${ISSUE_FIELDS}
                 ${CLAIM_COMMENT_FIELDS}
               }
               ${PAGE_INFO}
             }
           }`,
          { teamKey: LINEAR_TEAM_KEY, prefix: CLAIM_PREFIX, first: CLAIM_PAGE_SIZE, after },
        )
        return data.issues
      }
      const claims: ClaimRecord[] = []
      for (const node of await allNodes(await page(null), page)) {
        const claim = newestClaim(node.comments.nodes)
        if (claim) claims.push({ issue: toIssue(node), ...claim })
      }
      return claims
    },
  }
  return tracker
}
