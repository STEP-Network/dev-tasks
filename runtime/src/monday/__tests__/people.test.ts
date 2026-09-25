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

/** A person's steps, as review-uat's report writes them (SKILL.md, Output Format). */
const STEPS = [
  "1. **The publication date on the notice**, because only a person can judge it on a real notice",
  "   - URL: `https://test.polads.eu/da/notice/abc123`",
  "   - Sign in as: `advertiser@test.polads.eu`",
  "   - Steps: open the notice, then its PDF",
  "   - Expect: the publication date, not the order date",
  "   - ⚠️ none",
].join("\n")

/** The comment review-uat posts: its "## Agent UAT review, {date}" heading (linear-io.md), then the Step 8 report. */
const REVIEW = [
  "## Agent UAT review, 2026-09-24",
  "",
  "# UAT review — Fix the date (STEP-5)",
  "Merged abc1234 (PR #1679) · https://test.polads.eu · Reviewed 2026-09-24",
  "",
  "## What shipped",
  "**Problem:** the notice showed the order date. **Solution:** the page reads publicationDate.",
  "",
  "## ✅ Agent-verified",
  "- The page renders: route 200, no console errors",
  "",
  "## 👀 You must check",
  STEPS,
  "",
  "## Identifiers",
  "| What | Value | Source |",
  "|---|---|---|",
  "| a Confirmed notice | `abc123` | public API |",
  "",
  "## Outcome",
  "Waiting for UAT: run the checks above, then reply PASS or FAIL",
].join("\n")

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

  it("lists what waits for UAT, with the steps a person must check from the newest Agent UAT review", async () => {
    const { request, calls } = fakeRequest([[raw("STEP-5", { state: { name: "Waiting for UAT", type: "started" }, comments: { nodes: [{ body: REVIEW, createdAt: "2026-09-24T10:00:00Z" }] } })]])
    const [found] = await createPeopleView(request).waitingForUat()
    expect(found.uatSteps).toBe(STEPS)
    expect(calls[0].variables).toMatchObject({ state: "Waiting for UAT" })
    // The review comment opens with "## Agent UAT review, <date>" (review-uat's linear-io.md): no prefix filter would find it.
    expect(calls[0].query).toContain('comments(first: 10, filter: { body: { contains: "UAT review" } })')
  })

  it("reads an issue's parent, its project and the link of its Slack thread (Wave 2)", async () => {
    const PR = "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1679"
    const THREAD = "https://acme.slack.com/archives/CQ/p1790000000000100"
    const { request, calls } = fakeRequest([[raw("STEP-11", {
      parent: { identifier: "STEP-10" },
      project: { id: "p1", name: "Translations", url: "u", targetDate: "2026-10-30" },
      attachments: { nodes: [{ url: PR, title: "PR" }, { url: THREAD, title: "Slack intake thread" }] },
    })]])
    const [found] = await createPeopleView(request).byIdentifiers(["STEP-11"])
    expect(found).toMatchObject({ parent: "STEP-10", project: { id: "p1", name: "Translations", url: "u", targetDate: "2026-10-30" }, slackThread: THREAD, prUrl: PR })
    expect(calls[0].query).toContain("parent { identifier }")
    expect(calls[0].query).toContain("attachments(first: 10) { nodes { url title } }")
    const [plain] = await createPeopleView(fakeRequest([[raw("STEP-12", { attachments: { nodes: [{ url: THREAD, title: "Slack thread" }] } })]]).request).byIdentifiers(["STEP-12"])
    expect(plain).toMatchObject({ parent: null, project: null, slackThread: THREAD })
  })

  it("reads issues by their identifiers, in one query sized to them", async () => {
    const { request, calls } = fakeRequest([[raw("STEP-7"), raw("STEP-9")]])
    expect((await createPeopleView(request).byIdentifiers(["STEP-7", "STEP-9", "BAD-1"])).map((i) => i.id)).toEqual(["STEP-7", "STEP-9"])
    expect(calls[0].variables).toMatchObject({ team: "STEP", numbers: [7, 9], first: 2 })
    expect(await createPeopleView(request).byIdentifiers([])).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it("files a failed check's issue under the change it failed, at that change's priority", async () => {
    const { request, calls } = fakeRequest([])
    await createPeopleView(request).adoptFix("uuid-child", "uuid-parent", 2)
    expect(calls[0].variables).toEqual({ id: "uuid-child", input: { parentId: "uuid-parent", priority: 2 } })
  })

  it("reads a UAT fix's parent, and which of the parent's UAT fixes are still open", async () => {
    const child = (identifier: string, title: string, state: string) => ({ identifier, title, state: { name: state } })
    const { request, calls } = fakeRequest([[{
      parent: {
        identifier: "STEP-5", state: { name: "Needs Correction" },
        children: { nodes: [child("STEP-8", "UAT fix: the date", "Approved"), child("STEP-9", "UAT fix: the label", "In Progress"), child("STEP-10", "Translate it", "Ready"), child("STEP-11", "UAT fix: old", "Released")] },
      },
    }]])
    expect(await createPeopleView(request).parentOf("STEP-8")).toEqual({ id: "STEP-5", state: "Needs Correction", openFixes: ["STEP-9"] })
    expect(calls[0].variables).toMatchObject({ team: "STEP", number: 8 })
    const none = fakeRequest([[{ parent: null }]])
    expect(await createPeopleView(none.request).parentOf("STEP-8")).toBeNull()
  })
})

describe("uatSteps", () => {
  it("takes the You must check section of the newest Agent UAT review, nested or not, and nothing when there is none", () => {
    expect(uatSteps([{ body: REVIEW.replace(STEPS, "1. old"), createdAt: "2026-09-23T10:00:00Z" }, { body: REVIEW, createdAt: "2026-09-24T10:00:00Z" }])).toBe(STEPS)
    // Under its "## Agent UAT review" heading the report's sections may sit a level down.
    const nested = REVIEW.replace(/^## (?!Agent)/gm, "### ")
    expect(uatSteps([{ body: nested, createdAt: "2026-09-24T10:00:00Z" }])).toBe(STEPS)
    expect(uatSteps([{ body: "## Agent UAT review, 2026-09-24\n\n## ✅ Agent-verified\n- all", createdAt: "x" }])).toBeNull()
    expect(uatSteps([{ body: "A comment that is not a review.\n\n## You must check\n1. nothing", createdAt: "x" }])).toBeNull()
    expect(uatSteps([])).toBeNull()
  })
})
