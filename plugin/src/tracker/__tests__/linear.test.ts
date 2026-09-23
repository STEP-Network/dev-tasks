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

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest"

const requestMock = vi.fn()
vi.mock("../linear-client.ts", () => ({
  linearRequest: (...args: unknown[]) => requestMock(...args),
  LINEAR_ENDPOINT: "https://api.linear.app/graphql",
  loadLinearKey: () => "test-key",
  resetLinearClientForTests: () => {},
}))

const { createLinearTracker } = await import("../linear.ts")

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

let stderr: MockInstance

beforeEach(() => {
  requestMock.mockReset()
  // The fixtures answer every create with ISSUE_FIELDS' fixed id, which the
  // adapter reports on stderr as Linear ignoring its client id.
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(() => {
  stderr.mockRestore()
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

  it("says so on stderr when Linear answers with an id other than the one sent", async () => {
    // Retries are idempotent only while Linear honours the client id. If it
    // ever stopped, this is the one place that would show it.
    requestMock
      .mockResolvedValueOnce(TEAM)
      .mockResolvedValueOnce({ issueCreate: { issue: ISSUE_FIELDS } })

    await createLinearTracker().createIssue({ title: "x" })

    expect(stderr.mock.calls.map((c) => String(c[0])).join("")).toMatch(/client id/)
  })

  it("stays quiet when Linear keeps the client id", async () => {
    requestMock
      .mockResolvedValueOnce(TEAM)
      .mockImplementationOnce(async (_query: string, variables: { input: { id: string } }) => ({
        issueCreate: { issue: { ...ISSUE_FIELDS, id: variables.input.id } },
      }))

    await createLinearTracker().createIssue({ title: "x" })

    expect(stderr).not.toHaveBeenCalled()
  })
})

describe("a create that threw is settled by reading its own id back", () => {
  // Whatever the error said: a 5xx that outlasted the retries, a refusal in
  // unexpected words, a dropped connection. The id is a fresh UUID minted by
  // this call, so finding it can only mean this call's write landed.
  it("createIssue returns the issue when its id reads back", async () => {
    requestMock
      .mockResolvedValueOnce(TEAM)
      .mockRejectedValueOnce(new Error("Linear: gave up after 6 attempts (last status 502)"))
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
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ comment: { id: "comment-uuid" } })

    await expect(createLinearTracker().comment("STEP-123", "hi")).resolves.toBeUndefined()

    const sentId = requestMock.mock.calls[1][1].input.id
    expect(requestMock.mock.calls[2][0]).toMatch(/comment\(id:/)
    expect(requestMock.mock.calls[2][1]).toEqual({ id: sentId })
  })

  it("rethrows the create's own error when nothing reads back", async () => {
    // Linear also reports PHANTOM insert conflicts, for ids nothing holds.
    // Calling that a success would drop the comment without a word.
    requestMock
      .mockResolvedValueOnce({ issues: { nodes: [ISSUE_FIELDS] } })
      .mockRejectedValueOnce(new Error("Linear: conflict on insert"))
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
  // Ranking reads three fields per issue; the full issue (description,
  // labels) is fetched for the winners only. `lean` is a ranking node and
  // `echoFull` plays the second query, answering in REVERSE of the order it
  // was asked, since Linear's order is its own and the ranking is ours.
  const lean = (n: number, priority: number, updatedAt: string) => ({ id: `uuid-${n}`, priority, updatedAt })
  const page = (nodes: unknown[], endCursor: string, hasNextPage = false) => ({
    issues: { nodes, pageInfo: { hasNextPage, endCursor } },
  })
  const echoFull = async (_query: string, variables: { ids: string[] }) => ({
    issues: {
      nodes: [...variables.ids]
        .reverse()
        .map((id) => ({ ...ISSUE_FIELDS, id, identifier: `STEP-${id.slice("uuid-".length)}` })),
    },
  })
  const fullFetches = () => requestMock.mock.calls.filter(([query]) => /id: \{ in: \$ids \}/.test(String(query)))

  it("filters on the Ready state and sorts by priority then age", async () => {
    requestMock
      .mockResolvedValueOnce(
        page(
          [
            lean(1, 0, "2026-01-01T00:00:00.000Z"),
            lean(2, 1, "2026-09-01T00:00:00.000Z"),
            lean(3, 3, "2026-02-01T00:00:00.000Z"),
          ],
          "ready-1",
        ),
      )
      .mockImplementationOnce(echoFull)

    const issues = await createLinearTracker().listReady(10)

    const [query, variables] = requestMock.mock.calls[0]
    expect(query).toMatch(/issues\(/)
    expect(variables).toMatchObject({ teamKey: "STEP", stateName: "Ready" })
    expect(issues.map((i) => i.id)).toEqual(["STEP-2", "STEP-3", "STEP-1"])
  })

  it("pages through the whole queue before sorting, so an Urgent issue on page 2 still comes first", async () => {
    // Linear pages in its own order, not by priority. Sorting only the first
    // page handed the front door whatever sat there, and an Urgent issue on
    // a later page never came up.
    requestMock
      .mockResolvedValueOnce(
        page([lean(1, 4, "2026-01-01T00:00:00.000Z"), lean(2, 3, "2026-02-01T00:00:00.000Z")], "ready-1", true),
      )
      .mockResolvedValueOnce(page([lean(9, 1, "2026-09-20T00:00:00.000Z")], "ready-2"))
      .mockImplementationOnce(echoFull)

    const issues = await createLinearTracker().listReady(2)

    expect(issues.map((i) => i.id)).toEqual(["STEP-9", "STEP-2"])
    expect(requestMock.mock.calls[0][1]).toMatchObject({ after: null })
    expect(requestMock.mock.calls[1][1]).toMatchObject({ after: "ready-1" })
  })

  it("keeps the cost to the ranking fields plus `limit` full issues (the cost shape)", async () => {
    // Paging full issues cost ~5,800 points a page (each one's nested labels
    // count as 50), so ~28,900 a call on a 440-issue queue, against a budget
    // of 3M points an hour per user with the front door polling every minute.
    // A ranking node is ~1.3 points: 250 a page is ~330. Three full issues
    // are ~175. So the same call is now ~830 points in three requests.
    const queue = Array.from({ length: 440 }, (_, i) => lean(i, 3, `2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z`))
    requestMock
      .mockResolvedValueOnce(page(queue.slice(0, 250), "ready-1", true))
      .mockResolvedValueOnce(page(queue.slice(250), "ready-2"))
      .mockImplementationOnce(echoFull)

    const issues = await createLinearTracker().listReady(3)

    const ranking = requestMock.mock.calls.slice(0, 2)
    for (const [query, variables] of ranking) {
      expect(String(query)).toMatch(/nodes \{ id priority updatedAt \}/)
      expect(String(query)).not.toMatch(/labels|description/)
      expect(variables.first).toBeLessThanOrEqual(250)
    }
    expect(fullFetches()).toHaveLength(1)
    const [fullQuery, fullVariables] = fullFetches()[0]
    expect(String(fullQuery)).toMatch(/labels/)
    expect(fullVariables.ids).toHaveLength(3)
    expect(fullVariables.ids).toEqual(issues.map((i) => i.uuid))
    expect(requestMock).toHaveBeenCalledTimes(3)
  })

  it("fetches a large limit's full issues in chunks that stay under the complexity cap", async () => {
    // 100 full issues are ~5,800 points. One query for 150 would be ~8,700,
    // and a limit of 200 would be refused outright.
    const queue = Array.from({ length: 160 }, (_, i) => lean(i, 2, `2026-02-01T00:00:00.${String(i).padStart(3, "0")}Z`))
    requestMock
      .mockResolvedValueOnce(page(queue, "ready-1"))
      .mockImplementationOnce(echoFull)
      .mockImplementationOnce(echoFull)

    const issues = await createLinearTracker().listReady(150)

    expect(fullFetches().map(([, variables]) => variables.ids.length)).toEqual([100, 50])
    expect(issues).toHaveLength(150)
    expect(issues[0].uuid).toBe("uuid-0")
    expect(issues[149].uuid).toBe("uuid-149")
  })

  it("asks for full issues still in Ready, and drops one that left it since the ranking", async () => {
    requestMock
      .mockResolvedValueOnce(
        page([lean(1, 1, "2026-01-01T00:00:00.000Z"), lean(2, 2, "2026-01-01T00:00:00.000Z")], "ready-1"),
      )
      .mockResolvedValueOnce({ issues: { nodes: [{ ...ISSUE_FIELDS, id: "uuid-2", identifier: "STEP-2" }] } })

    const issues = await createLinearTracker().listReady(2)

    const [fullQuery, fullVariables] = fullFetches()[0]
    expect(String(fullQuery)).toMatch(/state: \{ name: \{ eq: \$stateName \} \}/)
    expect(fullVariables).toMatchObject({ stateName: "Ready" })
    expect(issues.map((i) => i.id)).toEqual(["STEP-2"])
  })

  it("does not run the second query when nothing is Ready", async () => {
    requestMock.mockResolvedValueOnce(page([], "ready-1"))

    expect(await createLinearTracker().listReady(5)).toEqual([])
    expect(requestMock).toHaveBeenCalledTimes(1)
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
