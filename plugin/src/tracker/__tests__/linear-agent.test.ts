/**
 * The tracker surface the agent runtime needs (phase 2, STEP-3123): who the
 * key belongs to, a partial update, and the claim lifecycle. The mock ROUTES
 * on the query text instead of answering calls in order, so these tests do
 * not depend on how many requests the paged team lookup makes.
 *
 * Every person and every agent has their own Linear account (2026-09-24), so
 * the key here belongs to Eve, whose mini is the first; nothing assumes one
 * particular mini.
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

const requestMock = vi.fn()
vi.mock("../linear-client.ts", () => ({
  linearRequest: (...args: unknown[]) => requestMock(...args),
  LINEAR_ENDPOINT: "https://api.linear.app/graphql",
  loadLinearKey: () => "test-key",
  resetLinearClientForTests: () => {},
}))

const { createLinearTracker } = await import("../linear.ts")

const PAGE_END = { hasNextPage: false, endCursor: null }
const STATES = [
  { id: "state-ready", name: "Ready" },
  { id: "state-hold", name: "On hold" },
  { id: "state-progress", name: "In Progress" },
  { id: "state-review", name: "In Review" },
  { id: "state-triage", name: "Triage" },
]
const LABELS = [
  { id: "label-agent-ready", name: "agent-ready" },
  { id: "label-awaiting", name: "awaiting-answer" },
  { id: "label-feature", name: "feature" },
  { id: "label-chore", name: "chore" },
]
const ISSUE = {
  id: "issue-uuid",
  identifier: "STEP-7",
  title: "Fix the thing",
  description: "Body",
  url: "https://linear.app/step/issue/STEP-7",
  priority: 2,
  updatedAt: "2026-09-24T08:00:00.000Z",
  state: { name: "Ready" },
  labels: { nodes: [{ name: "polads" }] },
  assignee: null,
}
const ME = { id: "user-eve", name: "Eve", email: "eve@polads.eu" }
const CLIENT_ID = "11111111-2222-4333-8444-555555555555"

type Handler = (variables: Record<string, any>) => unknown
let routes: Array<[RegExp, Handler]> = []
const route = (pattern: RegExp, handler: Handler) => {
  routes.push([pattern, handler])
}
const sent = (pattern: RegExp) => requestMock.mock.calls.filter(([query]) => pattern.test(String(query)))

beforeEach(() => {
  routes = []
  requestMock.mockReset()
  requestMock.mockImplementation(async (query: string, variables: Record<string, any> = {}) => {
    for (const [pattern, handler] of routes) if (pattern.test(query)) return handler(variables)
    if (/\bviewer\b/.test(query)) return { viewer: ME }
    if (/teams\s*\(/.test(query)) {
      return {
        teams: {
          nodes: [{ id: "team-uuid", key: "STEP", name: "STEP", states: { nodes: STATES }, labels: { nodes: LABELS, pageInfo: PAGE_END } }],
        },
      }
    }
    if (/issueUpdate/.test(query)) return { issueUpdate: { success: true, issue: ISSUE } }
    if (/commentCreate/.test(query)) return { commentCreate: { success: true } }
    if (/commentUpdate/.test(query)) return { commentUpdate: { success: true } }
    if (/issueCreate/.test(query)) return { issueCreate: { issue: { ...ISSUE, id: variables.input?.id, identifier: "STEP-8" } } }
    if (/issues\s*\(/.test(query)) return { issues: { nodes: [ISSUE], pageInfo: PAGE_END } }
    if (/issue\s*\(id:/.test(query)) return { issue: ISSUE }
    throw new Error(`unrouted query: ${query.slice(0, 80)}`)
  })
})

describe("the assignee", () => {
  it("is null when nobody holds the issue and the user id when someone does", async () => {
    const tracker = createLinearTracker()
    expect((await tracker.readIssue("STEP-7")).assigneeId).toBeNull()
    route(/issues\s*\(/, () => ({ issues: { nodes: [{ ...ISSUE, assignee: { id: "user-eve" } }], pageInfo: PAGE_END } }))
    expect((await tracker.readIssue("STEP-7")).assigneeId).toBe("user-eve")
  })
})

describe("whoami", () => {
  it("is the key's owner, asked for once per tracker", async () => {
    const tracker = createLinearTracker()
    expect(await tracker.whoami()).toEqual(ME)
    await tracker.whoami()
    expect(sent(/\bviewer\b/)).toHaveLength(1)
  })
})

describe("updateIssue", () => {
  it("sends ONE issueUpdate with the state and both label lists resolved by name", async () => {
    await createLinearTracker().updateIssue("STEP-7", {
      state: "On hold",
      addLabels: ["awaiting-answer"],
      removeLabels: ["agent-ready"],
    })
    const updates = sent(/issueUpdate/)
    expect(updates).toHaveLength(1)
    expect(updates[0][1]).toEqual({
      id: "issue-uuid",
      input: { stateId: "state-hold", addedLabelIds: ["label-awaiting"], removedLabelIds: ["label-agent-ready"] },
    })
  })

  it("assigns the key's owner for 'me' and unassigns for null", async () => {
    const tracker = createLinearTracker()
    await tracker.updateIssue("STEP-7", { assignee: "me" })
    await tracker.updateIssue("STEP-7", { assignee: null })
    expect(sent(/issueUpdate/).map(([, v]) => (v as any).input)).toEqual([{ assigneeId: "user-eve" }, { assigneeId: null }])
  })

  it("refuses an unknown state or label before writing anything", async () => {
    const tracker = createLinearTracker()
    await expect(tracker.updateIssue("STEP-7", { state: "Parked" })).rejects.toThrow(/Parked/)
    await expect(tracker.updateIssue("STEP-7", { addLabels: ["no-such-label"] })).rejects.toThrow(/no-such-label/)
    expect(sent(/issueUpdate/)).toHaveLength(0)
  })

  it("writes a description verbatim and sends nothing for an empty patch", async () => {
    const tracker = createLinearTracker()
    await tracker.updateIssue("STEP-7", { description: "## Goal\n\nDo it." })
    await tracker.updateIssue("STEP-7", {})
    expect(sent(/issueUpdate/).map(([, v]) => (v as any).input)).toEqual([{ description: "## Goal\n\nDo it." }])
  })
})

describe("createIssue with a caller-chosen id", () => {
  it("sends the clientId as the issue id, so a caller that crashed can find the issue again", async () => {
    await createLinearTracker().createIssue({ title: "From Slack", clientId: CLIENT_ID })
    expect(sent(/issueCreate/)[0][1].input.id).toBe(CLIENT_ID)
  })

  it("still generates an id when the caller gives none", async () => {
    await createLinearTracker().createIssue({ title: "From /ship" })
    expect(sent(/issueCreate/)[0][1].input.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("answers a retry whose clientId is already taken with the issue that id names", async () => {
    // The first attempt landed and the caller crashed before recording it.
    // Linear refuses the second create, and the read-back settles it.
    route(/issueCreate/, () => {
      throw new Error(`Linear: Entity Issue with id ${CLIENT_ID} already exists`)
    })
    route(/issue\s*\(id:/, (variables) => ({ issue: { ...ISSUE, id: variables.id, identifier: "STEP-8" } }))
    const issue = await createLinearTracker().createIssue({ title: "From Slack", clientId: CLIENT_ID })
    expect(issue).toMatchObject({ id: "STEP-8", uuid: CLIENT_ID })
    expect(sent(/issueCreate/)).toHaveLength(1)
  })

  it("refuses a clientId that is not a UUID before writing anything", async () => {
    // Linear would refuse it, and the read-back resolves "STEP-5" as an
    // identifier: the create would come back as an unrelated issue.
    await expect(createLinearTracker().createIssue({ title: "x", clientId: "STEP-5" })).rejects.toThrow(/clientId/)
    expect(sent(/issueCreate/)).toHaveLength(0)
  })
})
