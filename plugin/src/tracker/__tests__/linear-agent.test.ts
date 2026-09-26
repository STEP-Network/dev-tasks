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
import { claimCommentBody, newestClaim, parseClaim, withHeartbeat } from "../types.ts"

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

describe("claimIssue", () => {
  it("assigns the key's owner, moves to In Progress, and leaves a claim comment naming the mini", async () => {
    await createLinearTracker().claimIssue("STEP-7", "eve")
    const [update] = sent(/issueUpdate/)
    expect(update[1].input).toEqual({ assigneeId: "user-eve", stateId: "state-progress" })
    const [comment] = sent(/commentCreate/)
    expect(comment[1].input.body).toMatch(/^claimed by eve at \d{4}-\d{2}-\d{2}T/)
    expect(sent(/users\s*\(/)).toHaveLength(0)
  })

  it("writes the claim comment first, so a comment that fails leaves the issue unclaimed", async () => {
    // Assigned and In Progress with no claim comment, the issue would be held
    // for good: listClaims never returns it, so nothing would release it.
    route(/commentCreate/, () => {
      throw new Error("Linear: gave up after 6 attempts (last status 502)")
    })
    route(/comment\s*\(id:/, () => ({ comment: null }))
    await expect(createLinearTracker().claimIssue("STEP-7", "eve")).rejects.toThrow(/502/)
    expect(sent(/issueUpdate/)).toHaveLength(0)
  })

  it("refuses when the team has no In Progress state, before writing anything", async () => {
    // Assigned but left in its old state, the issue would be invisible to
    // listClaims, which reads In Progress only: held, and never swept.
    route(/teams\s*\(/, () => ({
      teams: {
        nodes: [
          {
            id: "team-uuid",
            key: "STEP",
            name: "STEP",
            states: { nodes: STATES.filter((s) => s.name !== "In Progress") },
            labels: { nodes: LABELS, pageInfo: PAGE_END },
          },
        ],
      },
    }))
    await expect(createLinearTracker().claimIssue("STEP-7", "eve")).rejects.toThrow(/In Progress/)
    expect(sent(/commentCreate|issueUpdate/)).toHaveLength(0)
  })

  it("refuses an issue someone else holds, before writing anything", async () => {
    route(/issues\s*\(/, () => ({ issues: { nodes: [{ ...ISSUE, assignee: { id: "user-nate" } }], pageInfo: PAGE_END } }))
    await expect(createLinearTracker().claimIssue("STEP-7", "eve")).rejects.toThrow(/STEP-7/)
    expect(sent(/commentCreate|issueUpdate/)).toHaveLength(0)
  })

  it("claims an issue the key's owner already holds, as when a parked issue comes back", async () => {
    route(/issues\s*\(/, () => ({ issues: { nodes: [{ ...ISSUE, assignee: { id: "user-eve" } }], pageInfo: PAGE_END } }))
    await createLinearTracker().claimIssue("STEP-7", "eve")
    expect(sent(/commentCreate/)).toHaveLength(1)
    expect(sent(/issueUpdate/)).toHaveLength(1)
  })
})

describe("claim comments", () => {
  it("parse back, and a heartbeat keeps the claim line and replaces the previous beat", () => {
    const body = claimCommentBody("eve", "2026-09-24T08:00:00.000Z")
    expect(parseClaim(body)).toEqual({ claimant: "eve", claimedAt: "2026-09-24T08:00:00.000Z" })
    const beaten = withHeartbeat(withHeartbeat(body, "2026-09-24T08:15:00.000Z"), "2026-09-24T08:30:00.000Z")
    expect(beaten).toBe("claimed by eve at 2026-09-24T08:00:00.000Z\nheartbeat 2026-09-24T08:30:00.000Z")
    expect(parseClaim(beaten)?.claimant).toBe("eve")
    expect(parseClaim("released: stale")).toBeNull()
    // Claims are ranked by comparing their times as strings, which holds only
    // for the one format claimCommentBody is given (toISOString).
    expect(parseClaim("claimed by nate at noon")).toBeNull()
    expect(parseClaim("claimed by eve at 2026-09-24T08:00:00Z")).toBeNull()
  })

  it.each([
    ["a backslash break", "claimed by eve at 2026-09-24T08:00:00.000Z\\\nheartbeat 2026-09-24T08:15:00.000Z"],
    ["a space", "claimed by eve at 2026-09-24T08:00:00.000Z heartbeat 2026-09-24T08:15:00.000Z"],
  ])("still parse when Linear gives the heartbeat break back as %s, and the next beat rebuilds a clean body", (_, body) => {
    // Linear derives `body` from its own document model, so the break we
    // wrote may not be the break we read back. The claim must still parse,
    // and the next heartbeat must not carry the old one along with it.
    expect(parseClaim(body)).toEqual({ claimant: "eve", claimedAt: "2026-09-24T08:00:00.000Z" })
    expect(withHeartbeat(body, "2026-09-24T08:30:00.000Z")).toBe(
      "claimed by eve at 2026-09-24T08:00:00.000Z\nheartbeat 2026-09-24T08:30:00.000Z",
    )
  })

  it("pick the newest claim, for one claimant when asked, with the edit time as the heartbeat", () => {
    const comments = [
      { id: "c1", body: "claimed by eve at 2026-09-24T06:00:00.000Z", createdAt: "2026-09-24T06:00:00.000Z", editedAt: null },
      { id: "c2", body: "claimed by bob at 2026-09-24T07:00:00.000Z", createdAt: "2026-09-24T07:00:00.000Z", editedAt: "2026-09-24T07:45:00.000Z" },
    ]
    expect(newestClaim(comments)).toEqual({
      claimant: "bob",
      commentId: "c2",
      claimedAt: "2026-09-24T07:00:00.000Z",
      heartbeatAt: "2026-09-24T07:45:00.000Z",
    })
    expect(newestClaim(comments, "eve")?.heartbeatAt).toBe("2026-09-24T06:00:00.000Z")
    expect(newestClaim([], "eve")).toBeNull()
  })
})

describe("touchClaim", () => {
  it("edits the mini's newest claim comment, and reports false when the mini holds none", async () => {
    route(/startsWith/, () => ({
      issue: {
        comments: {
          nodes: [{ id: "c1", body: "claimed by eve at 2026-09-24T06:00:00.000Z", createdAt: "2026-09-24T06:00:00.000Z", editedAt: null }],
        },
      },
    }))
    const tracker = createLinearTracker()
    expect(await tracker.touchClaim("STEP-7", "eve")).toBe(true)
    const [edit] = sent(/commentUpdate/)
    expect(edit[1].id).toBe("c1")
    expect(edit[1].input.body).toMatch(/^claimed by eve at 2026-09-24T06:00:00\.000Z\nheartbeat \d{4}-/)
    expect(await tracker.touchClaim("STEP-7", "bob")).toBe(false)
    expect(sent(/commentUpdate/)).toHaveLength(1)
  })
})

describe("releaseIssue", () => {
  it("unassigns, puts the issue back in Ready and says why", async () => {
    await createLinearTracker().releaseIssue("STEP-7", "claim by eve has had no heartbeat for 7 hours")
    expect(sent(/issueUpdate/)[0][1].input).toEqual({ stateId: "state-ready", assigneeId: null })
    expect(sent(/commentCreate/)[0][1].input.body).toBe("released: claim by eve has had no heartbeat for 7 hours")
  })
})

describe("listClaims", () => {
  const held = (n: number, assignee: string, claims: string[]) => ({
    ...ISSUE,
    id: `uuid-${n}`,
    identifier: `STEP-${n}`,
    state: { name: "In Progress" },
    assignee: { id: assignee },
    comments: {
      nodes: claims.map((body, i) => ({ id: `c${n}-${i}`, body, createdAt: "2026-09-24T06:00:00.000Z", editedAt: "2026-09-24T06:15:00.000Z" })),
    },
  })

  it("returns the key owner's In Progress issues that carry a claim comment, and skips the rest", async () => {
    route(/startsWith/, () => ({
      issues: {
        nodes: [held(7, "user-eve", ["claimed by eve at 2026-09-24T06:00:00.000Z"]), held(9, "user-eve", [])],
        pageInfo: PAGE_END,
      },
    }))
    const claims = await createLinearTracker().listClaims()
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({ claimant: "eve", commentId: "c7-0", heartbeatAt: "2026-09-24T06:15:00.000Z" })
    expect(claims[0].issue).toMatchObject({ id: "STEP-7", assigneeId: "user-eve" })
    const [[query, variables]] = sent(/startsWith/)
    expect(query).toMatch(/"In Progress"/)
    expect(variables).toMatchObject({ prefix: "claimed by " })
  })

  it("asks only for issues assigned to the key's owner, so a person's issue is never a claim to release", async () => {
    // An agent's claim comment outlives the claim. Once a person assigns an
    // issue to themselves, an "any assignee" filter would hand the sweeper
    // that person's issue with a long-dead heartbeat, and the sweeper would
    // unassign them and put it back in the agents' queue.
    route(/startsWith/, () => ({ issues: { nodes: [], pageInfo: PAGE_END } }))
    await createLinearTracker().listClaims()
    const [[query]] = sent(/startsWith/)
    expect(query).toMatch(/assignee:\s*\{\s*isMe:\s*\{\s*eq:\s*true\s*\}\s*\}/)
    expect(query).not.toMatch(/null:\s*false/)
  })

  it("reads every page, so a claim past the first page is still swept", async () => {
    // The sweeper releases what this returns. A claim on a page it never read
    // would hold its issue forever.
    // Both pages hold the key owner's issues: isMe returns nothing else.
    route(/startsWith/, (variables) =>
      variables.after
        ? { issues: { nodes: [held(2, "user-eve", ["claimed by eve at 2026-09-24T02:00:00.000Z"])], pageInfo: PAGE_END } }
        : {
            issues: {
              nodes: [held(1, "user-eve", ["claimed by eve at 2026-09-24T01:00:00.000Z"])],
              pageInfo: { hasNextPage: true, endCursor: "claims-1" },
            },
          },
    )
    const claims = await createLinearTracker().listClaims()
    expect(claims.map((c) => [c.issue.id, c.claimant, c.claimedAt])).toEqual([
      ["STEP-1", "eve", "2026-09-24T01:00:00.000Z"],
      ["STEP-2", "eve", "2026-09-24T02:00:00.000Z"],
    ])
    expect(sent(/startsWith/).map(([, variables]) => variables.after)).toEqual([null, "claims-1"])
  })
})

describe("listByState", () => {
  it("ranks the named state like listReady and fetches the winners in full", async () => {
    const triage = [
      { ...ISSUE, id: "uuid-1", identifier: "STEP-1", priority: 4 },
      { ...ISSUE, id: "uuid-2", identifier: "STEP-2", priority: 1 },
    ]
    // The ranking query and the full fetch both filter on the state; only
    // the full fetch names ids.
    route(/stateName/, (variables) => ({
      issues: { nodes: variables.ids ? triage.filter((i) => variables.ids.includes(i.id)) : triage, pageInfo: PAGE_END },
    }))
    const issues = await createLinearTracker().listByState("Triage", 10)
    const queries = sent(/stateName/)
    expect(queries).toHaveLength(2)
    for (const [, variables] of queries) expect(variables).toMatchObject({ stateName: "Triage" })
    expect(issues.map((i) => i.id)).toEqual(["STEP-2", "STEP-1"])
  })

  it("lists only the given issues, ranked among themselves, so one far down the state still comes (STEP-3368)", async () => {
    // Thirty in Triage: 1-10 Urgent, 11-20 High, 21-30 Medium. STEP-25 ranks
    // past the top 20, so cutting the whole state first would lose it.
    const triage = Array.from({ length: 30 }, (_, i) => ({ ...ISSUE, id: `uuid-${i + 1}`, identifier: `STEP-${i + 1}`, priority: 1 + Math.floor(i / 10) }))
    const numberOf = (i: { identifier: string }) => Number(i.identifier.split("-")[1])
    // Linear applies the number filter server-side, as it does the state.
    route(/stateName/, (variables) => ({
      issues: {
        nodes: triage.filter((i) => (!variables.numbers || variables.numbers.includes(numberOf(i))) && (!variables.ids || variables.ids.includes(i.id))),
        pageInfo: PAGE_END,
      },
    }))
    const issues = await createLinearTracker().listByState("Triage", 20, ["STEP-25", "STEP-2", "OTHER-7", "not an id"])
    expect(issues.map((i) => i.id)).toEqual(["STEP-2", "STEP-25"])
    const [rankQuery, rankVariables] = sent(/stateName/)[0]
    expect(String(rankQuery)).toMatch(/number: \{ in: \$numbers \}/)
    // Another team's id, or no id at all, is not this team's issue.
    expect(rankVariables).toMatchObject({ stateName: "Triage", numbers: [25, 2] })
  })

  it("asks Linear nothing for an empty list, or one with no issue of this team", async () => {
    const tracker = createLinearTracker()
    expect(await tracker.listByState("Triage", 20, [])).toEqual([])
    expect(await tracker.listByState("Triage", 20, ["OTHER-7"])).toEqual([])
    expect(await tracker.listReady(250, [])).toEqual([])
    expect(sent(/stateName/)).toHaveLength(0)
  })

  it("refuses a state the team does not have, rather than read it as an empty queue", async () => {
    // updateIssue refuses the same name. A typo or a wrong case here would
    // otherwise look like a quiet queue for as long as nobody noticed.
    await expect(createLinearTracker().listByState("triage")).rejects.toThrow(/triage/)
    expect(sent(/stateName/)).toHaveLength(0)
  })
})
