import { describe, expect, it } from "vitest"
import { createPeopleView, uatSteps, type LinearRequest } from "../people.ts"

const raw = (identifier: string, over: Record<string, unknown> = {}) => ({
  id: `uuid-${identifier}`, identifier, title: `Title ${identifier}`, description: "## Goal\n\nFix it.", url: `https://linear.app/step/issue/${identifier}`,
  dueDate: null, state: { name: "On hold", type: "unstarted" }, labels: { nodes: [{ name: "polads" }] },
  assignee: { name: "Eve", email: "eve@polads.eu" }, creator: { name: "Nate", email: "nate@polads.eu" },
  attachments: { nodes: [{ url: "https://slack.com/archives/C1/p1" }, { url: "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1679" }] },
  comments: { nodes: [] },
  ...over,
})

/** Answers each query in turn with one page, and records the queries and their variables. */
function fakeRequest(pages: unknown[][]) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
  const request: LinearRequest = async <T,>(query: string, variables: Record<string, unknown> = {}) => {
    calls.push({ query, variables })
    if (/issueUpdate/.test(query)) return { issueUpdate: { success: true } } as T
    const nodes = pages.shift() ?? []
    return { issues: { nodes, pageInfo: { hasNextPage: pages.length > 0 && !/number/.test(JSON.stringify(variables)), endCursor: `c${calls.length}` } } } as T
  }
  return { request, calls }
}

describe("the people's view of Linear (STEP-3289)", () => {
  it("lists what needs a person: needs-human anywhere open, a question or a to-do only while its issue is On hold", async () => {
    const { request, calls } = fakeRequest([
      [
        raw("STEP-1", { labels: { nodes: [{ name: "needs-human" }] }, state: { name: "In Progress", type: "started" } }),
        raw("STEP-2", { labels: { nodes: [{ name: "awaiting-answer" }] } }),
        raw("STEP-3", { labels: { nodes: [{ name: "human-todo" }] }, state: { name: "Refining", type: "backlog" } }),
      ],
      [raw("STEP-4", { labels: { nodes: [{ name: "human-todo" }] }, dueDate: "2026-10-01" })],
    ])
    const found = await createPeopleView(request).needsYou()
    expect(found.map((i) => i.id)).toEqual(["STEP-1", "STEP-2", "STEP-4"])
    expect(found[2]).toMatchObject({
      uuid: "uuid-STEP-4", state: "On hold", labels: ["human-todo"], dueDate: "2026-10-01",
      owner: { name: "Eve", email: "eve@polads.eu" }, requester: { name: "Nate", email: "nate@polads.eu" },
      prUrl: "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1679",
    })
    // Every page, on team STEP, open issues only, with any of the three labels.
    expect(calls).toHaveLength(2)
    expect(calls[1].variables).toMatchObject({ after: "c1" })
    expect(calls[0].variables).toMatchObject({ team: "STEP", labels: ["needs-human", "human-todo", "awaiting-answer"] })
    expect(calls[0].query).toMatch(/type: \{ nin: \["completed", "canceled", "duplicate"\] \}/)
  })

  it("lists what waits for UAT, with the steps a person must check", async () => {
    const review = "# UAT review — Fix the date (STEP-5)\n\n## ✅ Agent-verified\n- route 200\n\n## 👀 You must check\n1. **Open the notice**\n   - Expect: the date\n\n## Identifiers\n| a | b |"
    const { request, calls } = fakeRequest([[raw("STEP-5", { state: { name: "Waiting for UAT", type: "started" }, comments: { nodes: [{ body: review, createdAt: "2026-09-24T10:00:00Z" }] } })]])
    const [found] = await createPeopleView(request).waitingForUat()
    expect(found.uatSteps).toBe("1. **Open the notice**\n   - Expect: the date")
    expect(calls[0].variables).toMatchObject({ state: "Waiting for UAT" })
  })

  it("reads issues by their identifiers, in one query", async () => {
    const { request, calls } = fakeRequest([[raw("STEP-7"), raw("STEP-9")]])
    expect((await createPeopleView(request).byIdentifiers(["STEP-7", "STEP-9", "BAD-1"])).map((i) => i.id)).toEqual(["STEP-7", "STEP-9"])
    expect(calls[0].variables).toMatchObject({ team: "STEP", numbers: [7, 9] })
    expect(await createPeopleView(request).byIdentifiers([])).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it("makes a failed check's issue a sub-issue of the change it failed", async () => {
    const { request, calls } = fakeRequest([])
    await createPeopleView(request).setParent("uuid-child", "uuid-parent")
    expect(calls[0].variables).toEqual({ id: "uuid-child", input: { parentId: "uuid-parent" } })
  })
})

describe("uatSteps", () => {
  it("takes the You must check section of the newest Agent UAT review, and nothing when there is none", () => {
    const review = (steps: string) => `# UAT review — T (STEP-5)\n\n## 👀 You must check\n${steps}\n\n## Gaps\n- none`
    expect(uatSteps([{ body: review("1. old"), createdAt: "2026-09-23T10:00:00Z" }, { body: review("1. new"), createdAt: "2026-09-24T10:00:00Z" }])).toBe("1. new")
    expect(uatSteps([{ body: "# UAT review\n\n## ✅ Agent-verified\n- all", createdAt: "x" }])).toBeNull()
    expect(uatSteps([])).toBeNull()
  })
})
