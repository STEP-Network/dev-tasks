/**
 * The Linear adapter, driven through a mocked `linearRequest`.
 *
 * The assertions that carry weight are about WHAT IS SENT, not what comes
 * back: an identifier resolved by team key + number rather than by guessing
 * that `issue(id:)` accepts "STEP-123"; a state set by looking the NAME up on
 * the team rather than hardcoding a workspace-specific UUID; and a claim that
 * still records a comment when the claimant resolves to no Linear user, which
 * is the normal case for a mini.
 */

import { describe, it, expect, beforeEach, vi } from "vitest"

const requestMock = vi.fn()
vi.mock("../linear-client.ts", async (importOriginal) => ({
  // The real module, so LinearCreateConflictError is the class linear.ts checks for.
  ...(await importOriginal<typeof import("../linear-client.ts")>()),
  linearRequest: (...args: unknown[]) => requestMock(...args),
}))

const { createLinearTracker } = await import("../linear.ts")
const { LinearCreateConflictError } = await import("../linear-client.ts")

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const TEAM = {
  teams: {
    nodes: [
      {
        id: "team-uuid",
        key: "STEP",
        name: "STEP",
        states: {
          nodes: [
            { id: "state-ready", name: "Ready", type: "unstarted", position: 2 },
            { id: "state-progress", name: "In Progress", type: "started", position: 4 },
          ],
        },
        labels: {
          nodes: [{ id: "label-chore", name: "chore" }],
          pageInfo: { hasNextPage: false, endCursor: "labels-1" },
        },
      },
    ],
  },
}

const ISSUE_FIELDS = {
  id: "issue-uuid",
  identifier: "STEP-123",
  title: "Fix the thing",
  description: "Preamble.\n\n## Acceptance criteria\n\n- [ ] works",
  url: "https://linear.app/step/issue/STEP-123",
  priority: 2,
  updatedAt: "2026-09-01T00:00:00.000Z",
  state: { name: "Ready" },
  labels: { nodes: [{ name: "product/polads" }] },
}

beforeEach(() => {
  requestMock.mockReset()
})

describe("readIssue", () => {
  it("resolves STEP-123 by team key and NUMBER, never by passing the identifier as an id", async () => {
    requestMock.mockResolvedValueOnce({ issues: { nodes: [ISSUE_FIELDS] } })

    const issue = await createLinearTracker().readIssue("STEP-123")

    const [query, variables] = requestMock.mock.calls[0]
    expect(query).toMatch(/issues\(/)
    expect(variables).toMatchObject({ teamKey: "STEP", number: 123 })
    expect(issue.id).toBe("STEP-123")
    expect(issue.uuid).toBe("issue-uuid")
    expect(issue.state).toBe("Ready")
    expect(issue.labels).toEqual(["product/polads"])
  })

  it("splits the acceptance criteria out of the description", async () => {
    requestMock.mockResolvedValueOnce({ issues: { nodes: [ISSUE_FIELDS] } })
    const issue = await createLinearTracker().readIssue("STEP-123")
    expect(issue.acceptanceCriteria).toBe("- [ ] works")
    // The description is NOT truncated — the criteria are a projection of it.
    expect(issue.description).toMatch(/Preamble/)
  })

  it("throws a message naming the identifier when nothing matches", async () => {
    requestMock.mockResolvedValueOnce({ issues: { nodes: [] } })
    await expect(createLinearTracker().readIssue("STEP-999")).rejects.toThrowError(/STEP-999/)
  })

  it("accepts a raw UUID and looks it up by id", async () => {
    requestMock.mockResolvedValueOnce({ issue: ISSUE_FIELDS })
    await createLinearTracker().readIssue("11111111-2222-3333-4444-555555555555")
    expect(requestMock.mock.calls[0][0]).toMatch(/issue\(id:/)
  })
})

describe("createIssue", () => {
  it("creates on the STEP team, resolving the state NAME to an id", async () => {
    requestMock
      .mockResolvedValueOnce(TEAM)
      .mockResolvedValueOnce({ issueCreate: { issue: { ...ISSUE_FIELDS, identifier: "STEP-500" } } })

    const issue = await createLinearTracker().createIssue({
      title: "Ship the thing",
      description: "body",
      state: "Ready",
    })

    const [, variables] = requestMock.mock.calls[1]
    expect(variables.input).toMatchObject({
      teamId: "team-uuid",
      title: "Ship the thing",
      description: "body",
      stateId: "state-ready",
    })
    expect(issue.id).toBe("STEP-500")
  })

  it("omits stateId entirely when the requested state does not exist", async () => {
    requestMock
      .mockResolvedValueOnce(TEAM)
      .mockResolvedValueOnce({ issueCreate: { issue: ISSUE_FIELDS } })

    await createLinearTracker().createIssue({ title: "x", state: "Nonexistent" })

    // Sending a bogus stateId would fail the whole create; omitting it lets
    // Linear apply the team default, which is the right fallback for a
    // traceability issue opened by /ship.
    expect(requestMock.mock.calls[1][1].input.stateId).toBeUndefined()
  })

  it("finds a label that sits past the first page of team labels", async () => {
    // The migration's epic/<slug> labels alone can push `chore` off a first
    // page; reading one page skipped it without a word.
    const firstPage = {
      teams: {
        nodes: [
          {
            ...TEAM.teams.nodes[0],
            labels: {
              nodes: [{ id: "label-epic", name: "some-epic" }],
              pageInfo: { hasNextPage: true, endCursor: "labels-1" },
            },
          },
        ],
      },
    }
    requestMock
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce({
        team: {
          labels: {
            nodes: [{ id: "label-chore", name: "chore" }],
            pageInfo: { hasNextPage: false, endCursor: "labels-2" },
          },
        },
      })
      .mockResolvedValueOnce({ issueCreate: { issue: ISSUE_FIELDS } })

    await createLinearTracker().createIssue({ title: "x", labels: ["chore"] })

    // One team, not the default 50: Linear multiplies the nested labels(first:
    // 250) by the outer connection's page size, and 50 x 250 labels is past
    // its 10,000-point cap for a single query.
    expect(requestMock.mock.calls[0][0]).toMatch(/teams\(first: 1,/)
    expect(requestMock.mock.calls[1][1]).toMatchObject({ id: "team-uuid", after: "labels-1" })
    expect(requestMock.mock.calls[2][1].input.labelIds).toEqual(["label-chore"])
  })
})

describe("creates carry an id of the adapter's own", () => {
  it("createIssue sends a UUID v4 as the issue id", async () => {
    requestMock
      .mockResolvedValueOnce(TEAM)
      .mockResolvedValueOnce({ issueCreate: { issue: ISSUE_FIELDS } })

    await createLinearTracker().createIssue({ title: "x" })

    expect(requestMock.mock.calls[1][1].input.id).toMatch(UUID_V4)
  })

  it("comment sends a UUID v4 as the comment id, a fresh one per comment", async () => {
    requestMock
      .mockResolvedValueOnce({ issues: { nodes: [ISSUE_FIELDS] } })
      .mockResolvedValueOnce({ commentCreate: { success: true } })
      .mockResolvedValueOnce({ issues: { nodes: [ISSUE_FIELDS] } })
      .mockResolvedValueOnce({ commentCreate: { success: true } })

    const tracker = createLinearTracker()
    await tracker.comment("STEP-123", "one")
    await tracker.comment("STEP-123", "two")

    const [query, variables] = requestMock.mock.calls[1]
    expect(query).toMatch(/commentCreate/)
    expect(variables.input).toMatchObject({ issueId: "issue-uuid", body: "one" })
    expect(variables.input.id).toMatch(UUID_V4)
    expect(requestMock.mock.calls[3][1].input.id).not.toBe(variables.input.id)
  })
})

describe("a retry refused as 'already exists' is settled by reading the id back", () => {
  it("createIssue returns the issue its earlier attempt created", async () => {
    requestMock
      .mockResolvedValueOnce(TEAM)
      .mockRejectedValueOnce(new LinearCreateConflictError("Linear: Entity Issue with id x already exists"))
      .mockResolvedValueOnce({ issue: { ...ISSUE_FIELDS, identifier: "STEP-501" } })

    const issue = await createLinearTracker().createIssue({ title: "Ship the thing" })

    const sentId = requestMock.mock.calls[1][1].input.id
    const [readQuery, readVariables] = requestMock.mock.calls[2]
    expect(readQuery).toMatch(/issue\(id:/)
    expect(readVariables).toEqual({ id: sentId })
    expect(issue.id).toBe("STEP-501")
  })

  it("comment succeeds once the comment reads back", async () => {
    requestMock
      .mockResolvedValueOnce({ issues: { nodes: [ISSUE_FIELDS] } })
      .mockRejectedValueOnce(new LinearCreateConflictError("Linear: Entity Comment with id x already exists"))
      .mockResolvedValueOnce({ comment: { id: "comment-uuid" } })

    await expect(createLinearTracker().comment("STEP-123", "hi")).resolves.toBeUndefined()

    const sentId = requestMock.mock.calls[1][1].input.id
    expect(requestMock.mock.calls[2][0]).toMatch(/comment\(id:/)
    expect(requestMock.mock.calls[2][1]).toEqual({ id: sentId })
  })

  it("rethrows the conflict when nothing reads back", async () => {
    // Linear also reports PHANTOM insert conflicts, for ids nothing holds.
    // Calling that a success would drop the comment without a word.
    requestMock
      .mockResolvedValueOnce({ issues: { nodes: [ISSUE_FIELDS] } })
      .mockRejectedValueOnce(new LinearCreateConflictError("Linear: conflict on insert"))
      .mockRejectedValueOnce(new Error("Linear: Entity not found: Comment"))

    await expect(createLinearTracker().comment("STEP-123", "hi")).rejects.toThrowError(/conflict on insert/)
  })
})

describe("claimIssue", () => {
  it("moves the issue to In Progress and comments, even with no matching user", async () => {
    requestMock
      .mockResolvedValueOnce({ issues: { nodes: [ISSUE_FIELDS] } }) // readIssue
      .mockResolvedValueOnce(TEAM)                                   // team + states
      .mockResolvedValueOnce({ users: { nodes: [] } })               // no such user
      .mockResolvedValueOnce({ issueUpdate: { success: true } })
      .mockResolvedValueOnce({ commentCreate: { success: true } })
      .mockResolvedValueOnce({ issues: { nodes: [{ ...ISSUE_FIELDS, state: { name: "In Progress" } }] } })

    const issue = await createLinearTracker().claimIssue("STEP-123", "bob")

    const update = requestMock.mock.calls.find((c) => String(c[0]).includes("issueUpdate"))
    expect(update?.[1].input).toMatchObject({ stateId: "state-progress" })
    expect(update?.[1].input.assigneeId).toBeUndefined()

    const comment = requestMock.mock.calls.find((c) => String(c[0]).includes("commentCreate"))
    expect(comment?.[1].input.body).toMatch(/claimed/i)
    expect(comment?.[1].input.body).toMatch(/bob/)

    expect(issue.state).toBe("In Progress")
  })
})

describe("attachLink", () => {
  it("uses attachmentLinkURL, the same mutation the migration uses", async () => {
    requestMock
      .mockResolvedValueOnce({ issues: { nodes: [ISSUE_FIELDS] } })
      .mockResolvedValueOnce({ attachmentLinkURL: { success: true } })

    await createLinearTracker().attachLink("STEP-123", "https://github.com/x/y/pull/1", "PR #1")

    const call = requestMock.mock.calls[1]
    expect(call[0]).toMatch(/attachmentLinkURL/)
    expect(call[1]).toMatchObject({
      issueId: "issue-uuid",
      url: "https://github.com/x/y/pull/1",
      title: "PR #1",
    })
  })
})

describe("listReady", () => {
  it("filters on the Ready state and sorts by priority then age", async () => {
    requestMock.mockResolvedValueOnce({
      issues: {
        nodes: [
          { ...ISSUE_FIELDS, identifier: "STEP-1", priority: 0, updatedAt: "2026-01-01T00:00:00.000Z" },
          { ...ISSUE_FIELDS, identifier: "STEP-2", priority: 1, updatedAt: "2026-09-01T00:00:00.000Z" },
          { ...ISSUE_FIELDS, identifier: "STEP-3", priority: 3, updatedAt: "2026-02-01T00:00:00.000Z" },
        ],
        pageInfo: { hasNextPage: false, endCursor: "ready-1" },
      },
    })

    const issues = await createLinearTracker().listReady(10)

    const [query, variables] = requestMock.mock.calls[0]
    expect(query).toMatch(/issues\(/)
    expect(variables).toMatchObject({ teamKey: "STEP", stateName: "Ready" })
    expect(issues.map((i) => i.id)).toEqual(["STEP-2", "STEP-3", "STEP-1"])
  })

  it("pages through the whole queue before sorting, so an Urgent issue on page 2 still comes first", async () => {
    // Linear pages in createdAt order, so a NEW Urgent issue lands on the
    // last page. Sorting only the first page handed the front door the
    // oldest Low issues instead.
    requestMock
      .mockResolvedValueOnce({
        issues: {
          nodes: [
            { ...ISSUE_FIELDS, identifier: "STEP-1", priority: 4, updatedAt: "2026-01-01T00:00:00.000Z" },
            { ...ISSUE_FIELDS, identifier: "STEP-2", priority: 3, updatedAt: "2026-02-01T00:00:00.000Z" },
          ],
          pageInfo: { hasNextPage: true, endCursor: "ready-1" },
        },
      })
      .mockResolvedValueOnce({
        issues: {
          nodes: [{ ...ISSUE_FIELDS, identifier: "STEP-9", priority: 1, updatedAt: "2026-09-20T00:00:00.000Z" }],
          pageInfo: { hasNextPage: false, endCursor: "ready-2" },
        },
      })

    const issues = await createLinearTracker().listReady(2)

    expect(issues.map((i) => i.id)).toEqual(["STEP-9", "STEP-2"])
    expect(requestMock.mock.calls[0][1]).toMatchObject({ after: null })
    expect(requestMock.mock.calls[1][1]).toMatchObject({ after: "ready-1" })
    // The page size is not the limit, and it stays small: Linear refuses a
    // query over 10,000 complexity points, and one issue with its nested
    // labels costs about 58, so a page of 250 would be refused outright.
    expect(requestMock.mock.calls[0][1].first).toBeLessThanOrEqual(100)
  })

  it("throws rather than looping when Linear hands back a cursor that does not advance", async () => {
    const stuck = {
      issues: { nodes: [ISSUE_FIELDS], pageInfo: { hasNextPage: true, endCursor: "same" } },
    }
    requestMock.mockResolvedValueOnce(stuck).mockResolvedValueOnce(stuck)

    await expect(createLinearTracker().listReady(5)).rejects.toThrowError(/cursor/)
  })
})

describe("the adapter identifies itself", () => {
  it("reports kind linear", () => {
    expect(createLinearTracker().kind).toBe("linear")
  })
})
