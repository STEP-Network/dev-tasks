/**
 * Where a retro's evidence goes (STEP-3290): one Linear issue in STEP, in
 * Triage, labelled dev-tasks (the product group's) and retro. dev-tasks is
 * public, so its PR carries only numbers and a one-line reason per change,
 * and names this issue. The quotes from reviews and Slack, the PR and issue
 * links, and each change's evidence stay in Linear.
 */

import type { LinearRequest } from "../monday/people.ts"
import { stableUuid } from "../monday/render.ts"
import { LINEAR_TEAM_KEY, type Tracker } from "../tracker.ts"

export interface EvidenceSink {
  /** Files the issue, once per key: a retry reads the same issue back. */
  file(input: { key: string; title: string; description: string }): Promise<{ id: string; url: string }>
  /** Links the retro's PR on the issue. */
  link(id: string, url: string): Promise<void>
}

/** `dev-tasks` is the product group's child, which Linear addresses by its bare name. */
export const EVIDENCE_LABELS = ["dev-tasks", "retro"]
export const EVIDENCE_STATE = "Triage"

/** The team's `retro` label, created the first time. The tracker skips a label it does not know, so this comes first. */
async function ensureLabel(request: LinearRequest, name: string): Promise<void> {
  const data = await request<{ teams: { nodes: Array<{ id: string; labels: { nodes: Array<{ id: string }> } }> } }>(
    `query($key: String!, $name: String!) {
       teams(first: 1, filter: { key: { eq: $key } }) {
         nodes { id labels(first: 1, filter: { name: { eq: $name } }) { nodes { id } } }
       }
     }`,
    { key: LINEAR_TEAM_KEY, name },
  )
  const team = data.teams.nodes[0]
  if (!team) throw new Error(`Linear: no team with key ${LINEAR_TEAM_KEY}`)
  if (team.labels.nodes.length) return
  await request(`mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success } }`, { input: { name, teamId: team.id } })
}

export function linearEvidence(tracker: Pick<Tracker, "createIssue" | "attachLink">, request: LinearRequest): EvidenceSink {
  return {
    async file({ key, title, description }) {
      await ensureLabel(request, "retro")
      const issue = await tracker.createIssue({ title, description, state: EVIDENCE_STATE, labels: EVIDENCE_LABELS, clientId: stableUuid(key) })
      return { id: issue.id, url: issue.url }
    },
    link: (id, url) => tracker.attachLink(id, url, "The retro's PR"),
  }
}

/** For a dry run, which files nothing. */
export const noEvidence: EvidenceSink = {
  file: async () => {
    throw new Error("a dry run files no evidence")
  },
  link: async () => {},
}
