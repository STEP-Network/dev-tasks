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

import { linearRequest } from "./linear-client.ts"
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

interface RawTeam {
  id: string
  key: string
  name: string
  states: { nodes: Array<{ id: string; name: string }> }
  labels: { nodes: Array<{ id: string; name: string }> }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENTIFIER_RE = /^([A-Za-z]+)-(\d+)$/

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
  let teamCache: RawTeam | null = null

  async function team(): Promise<RawTeam> {
    if (teamCache) return teamCache
    const data = await linearRequest<{ teams: { nodes: RawTeam[] } }>(
      `query($key: String!) {
         teams(filter: { key: { eq: $key } }) {
           nodes {
             id key name
             states { nodes { id name } }
             labels { nodes { id name } }
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
    teamCache = found
    return found
  }

  async function stateIdFor(name: string | undefined): Promise<string | undefined> {
    if (!name) return undefined
    const t = await team()
    // A bogus stateId fails the whole mutation; omitting it lets Linear apply
    // the team default, which is the right fallback for a /ship issue.
    return t.states.nodes.find((s) => s.name === name)?.id
  }

  async function labelIdsFor(names: string[] | undefined): Promise<string[] | undefined> {
    if (!names || names.length === 0) return undefined
    const t = await team()
    const ids = names
      .map((n) => t.labels.nodes.find((l) => l.name === n)?.id)
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

      await linearRequest(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
        { input: { issueId: raw.id, body: `claimed by ${claimant} at ${new Date().toISOString()}` } },
      )

      return toIssue(await fetchRaw(ref))
    },

    async createIssue(input: CreateIssueInput) {
      const t = await team()
      const stateId = await stateIdFor(input.state)
      const labelIds = await labelIdsFor(input.labels)

      const payload: Record<string, unknown> = { teamId: t.id, title: input.title }
      if (input.description) payload.description = input.description
      if (stateId) payload.stateId = stateId
      if (labelIds) payload.labelIds = labelIds

      const data = await linearRequest<{ issueCreate: { issue: RawIssue } }>(
        `mutation($input: IssueCreateInput!) {
           issueCreate(input: $input) { issue { ${ISSUE_FIELDS} } }
         }`,
        { input: payload },
      )
      return toIssue(data.issueCreate.issue)
    },

    async comment(ref, body) {
      const raw = await fetchRaw(ref)
      await linearRequest(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
        { input: { issueId: raw.id, body } },
      )
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
      const data = await linearRequest<{ issues: { nodes: RawIssue[] } }>(
        `query($teamKey: String!, $stateName: String!, $first: Int!) {
           issues(
             first: $first,
             filter: { team: { key: { eq: $teamKey } }, state: { name: { eq: $stateName } } }
           ) {
             nodes { ${ISSUE_FIELDS} }
           }
         }`,
        { teamKey: LINEAR_TEAM_KEY, stateName: "Ready", first: limit },
      )
      return data.issues.nodes.map(toIssue).sort(byPriorityThenAge)
    },
  }
}
