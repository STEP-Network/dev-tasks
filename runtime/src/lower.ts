/**
 * A person's change of an approval class (spec 3, D1): "only a person can
 * lower a class". A lowering goes through the answer recorder's own Linear
 * account, the one PolAds' Approval class check trusts, and says on the issue
 * who asked. A raise goes through the agent's own tracker, as any raise does.
 *
 * Code alone decides a person asked, never a model: their Class column change
 * on their request (monday/requests.ts), or their whole message "make it look"
 * (slack/instruction.ts classVerb), which agentd acts on
 * (agentd/instructions.ts). Only agentd reads the recorder's key.
 */

import type { LinearRequest, PeopleIssue, PeopleView } from "./monday/people.ts"
import { loadRecorderKey } from "./secrets.ts"
import { APPROVAL_CLASSES, approvalLabel, classOfLabels, classRank, LINEAR_TEAM_KEY, linearRequest, type ApprovalClass, type Tracker } from "./tracker.ts"

/** A lowering, and no recorder key on this mini: the person lowers it in Linear. */
export class NeedsRecorder extends Error {}

export const CLASS_TITLE: Record<ApprovalClass, string> = { auto: "Auto", look: "Look", try: "Try" }

/** The recorder's Linear transport, or null without its key. Built when a person's change comes, and never handed to a child process. */
export function recorderFor(home: string): LinearRequest | null {
  const key = loadRecorderKey(home)
  return key ? <T,>(query: string, variables: Record<string, unknown> = {}) => linearRequest<T>(query, variables, { key }) : null
}

export interface ChangeDeps {
  tracker: Tracker
  /** The recorder's transport, asked for only when a lowering comes (recorderFor): null without its key. */
  recorder: () => LinearRequest | null
  people: Pick<PeopleView, "byIdentifiers" | "childrenOf">
}

export interface ChangeRequest {
  issue: string
  to: ApprovalClass
  /** The person's name, and a link to where they asked. */
  who: string
  where: string
  via: "on Monday" | "in Slack"
}

export interface ClassChange {
  outcome: "lowered" | "raised" | "same"
  /** The issues it changed, the anchor last. */
  issues: string[]
  from: ApprovalClass | null
}

const CLOSED = ["completed", "canceled", "duplicate"]
/** No class ranks below Auto: a raise gives it one. */
const rankOf = (i: PeopleIssue) => {
  const c = classOfLabels(i.labels)
  return c ? classRank(c) : -1
}

/**
 * The class of a request: its anchor and its open tasks. Each moves only the
 * way the person asked, so a raise never lowers a task and a lowering never
 * raises one. The anchor goes last: if Linear stops half-way, the anchor
 * still has its old class, and the next try finishes the rest.
 */
export async function changeClass(deps: ChangeDeps, r: ChangeRequest): Promise<ClassChange> {
  const [anchor] = await deps.people.byIdentifiers([r.issue])
  if (!anchor) throw new Error(`Linear: no issue ${r.issue}`)
  const from = classOfLabels(anchor.labels)
  if (from === r.to) return { outcome: "same", issues: [], from }
  const tasks = ((await deps.people.childrenOf([anchor.uuid])).get(anchor.id) ?? []).filter((t) => !CLOSED.includes(t.stateType))
  const to = classRank(r.to)
  const others = APPROVAL_CLASSES.filter((c) => c !== r.to).map(approvalLabel)
  if (from === null || to > classRank(from)) {
    const raised = [...tasks.filter((t) => rankOf(t) < to), anchor]
    for (const i of raised) await deps.tracker.updateIssue(i.id, { addLabels: [approvalLabel(r.to)], removeLabels: others })
    return { outcome: "raised", issues: raised.map((i) => i.id), from }
  }
  const recorder = deps.recorder()
  if (!recorder) throw new NeedsRecorder(`lowering ${r.issue} needs the answer recorder's key (runbook, section 5)`)
  const ids = await labelIds(recorder, [approvalLabel(r.to), ...others])
  const add = ids.get(approvalLabel(r.to))
  if (!add) throw new Error(`Linear has no label ${approvalLabel(r.to)}`)
  const remove = others.flatMap((name) => ids.get(name) ?? [])
  const relabel = async (i: PeopleIssue) => {
    const done = await recorder<{ issueUpdate: { success: boolean } }>(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: i.uuid, input: { addedLabelIds: [add], removedLabelIds: remove } },
    )
    if (!done.issueUpdate.success) throw new Error(`Linear did not change ${i.id}'s class`)
  }
  const lowered = tasks.filter((t) => rankOf(t) > to)
  for (const t of lowered) await relabel(t)
  // Said before the anchor moves: a failure between them says it again on the next try, and never leaves a lowering unsaid.
  const body = `Class lowered from ${CLASS_TITLE[from]} to ${CLASS_TITLE[r.to]} by ${r.who} ${r.via}, as they asked (${r.where}).`
  await recorder(`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`, { input: { issueId: anchor.uuid, body } })
  await relabel(anchor)
  return { outcome: "lowered", issues: [...lowered, anchor].map((i) => i.id), from }
}

/** The approval labels' ids, as the recorder sees them: the team's own, else the workspace's. */
async function labelIds(recorder: LinearRequest, names: string[]): Promise<Map<string, string>> {
  const data = await recorder<{ issueLabels: { nodes: Array<{ id: string; name: string; team: { key: string } | null }> } }>(
    `query($names: [String!]!) { issueLabels(first: 50, filter: { name: { in: $names } }) { nodes { id name team { key } } } }`,
    { names },
  )
  const ids = new Map<string, string>()
  for (const label of data.issueLabels.nodes) {
    if (label.team && label.team.key !== LINEAR_TEAM_KEY) continue
    if (!ids.has(label.name) || label.team) ids.set(label.name, label.id)
  }
  return ids
}
