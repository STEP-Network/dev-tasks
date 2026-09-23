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
vi.mock("../linear-client.ts", () => ({
  linearRequest: (...args: unknown[]) => requestMock(...args),
  LINEAR_ENDPOINT: "https://api.linear.app/graphql",
  loadLinearKey: () => "test-key",
  resetLinearClientForTests: () => {},
}))

const { createLinearTracker } = await import("../linear.ts")

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
        labels: { nodes: [{ id: "label-chore", name: "chore" }] },
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
      },
    })

    const issues = await createLinearTracker().listReady(10)

    const [query, variables] = requestMock.mock.calls[0]
    expect(query).toMatch(/issues\(/)
    expect(variables).toMatchObject({ teamKey: "STEP", stateName: "Ready", first: 10 })
    expect(issues.map((i) => i.id)).toEqual(["STEP-2", "STEP-3", "STEP-1"])
  })
})

describe("the adapter identifies itself", () => {
  it("reports kind linear", () => {
    expect(createLinearTracker().kind).toBe("linear")
  })
})
