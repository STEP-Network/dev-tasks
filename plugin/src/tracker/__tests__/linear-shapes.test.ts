/**
 * Linear shapes for Wave 2 (spec 4): a parent with sub-issues, a project
 * with milestones, and due dates. Every create names its own id, so a front
 * door that stops half-way and runs again makes nothing twice.
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
const { stableUuid } = await import("../ids.ts")

const TEAM = { teams: { nodes: [{ id: "team-uuid", key: "STEP", name: "STEP", states: { nodes: [{ id: "state-ready", name: "Ready", type: "unstarted", position: 2 }] }, labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } }] } }
const raw = (identifier: string, id: string) => ({ id, identifier, title: "t", description: "", url: `https://linear.app/step/issue/${identifier}`, priority: 3, updatedAt: "2026-09-25T00:00:00.000Z", state: { name: "Ready" }, labels: { nodes: [] } })
const KEY = stableUuid("trackerctl:STEP-7:task-1")
const PROJECT_KEY = stableUuid("trackerctl:STEP-7")

/** Answers each query by the first needle it contains. */
function route(answers: Array<[string, (vars: Record<string, any>) => unknown]>) {
  requestMock.mockImplementation(async (query: string, vars: Record<string, any>) => {
    const hit = answers.find(([needle]) => query.includes(needle))
    if (!hit) throw new Error(`unexpected query: ${query.slice(0, 80)}`)
    return hit[1](vars)
  })
}
const sentWith = (needle: string) => requestMock.mock.calls.filter(([q]) => String(q).includes(needle)).map(([, v]) => v)

let stderr: MockInstance
beforeEach(() => {
  requestMock.mockReset()
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
})
afterEach(() => stderr.mockRestore())

describe("sub-issues and due dates", () => {
  it("files a sub-issue under its parent's uuid, in a project milestone, with a due date", async () => {
    route([["teams(", () => TEAM], ["issueCreate", (v) => ({ issueCreate: { issue: raw("STEP-8", v.input.id) } })], ["issues(", () => ({ issues: { nodes: [raw("STEP-7", "parent-uuid")] } })]])
    await createLinearTracker().createIssue({ title: "Task 1", parent: "STEP-7", projectId: "proj-1", milestoneId: "ms-1", dueDate: "2026-10-09", clientId: KEY })
    expect(sentWith("issueCreate")[0].input).toMatchObject({ id: KEY, parentId: "parent-uuid", projectId: "proj-1", projectMilestoneId: "ms-1", dueDate: "2026-10-09" })
  })

  it("refuses a due date that is not YYYY-MM-DD before any write", async () => {
    route([["teams(", () => TEAM]])
    await expect(createLinearTracker().createIssue({ title: "x", dueDate: "9 October" })).rejects.toThrow(/YYYY-MM-DD/)
    expect(sentWith("issueCreate")).toEqual([])
  })

  it("refuses a parent it cannot find before any write", async () => {
    route([["teams(", () => TEAM], ["issues(", () => ({ issues: { nodes: [] } })]])
    await expect(createLinearTracker().createIssue({ title: "x", parent: "STEP-9999" })).rejects.toThrow(/no issue STEP-9999/)
    expect(sentWith("issueCreate")).toEqual([])
  })

  it("sets and clears an issue's due date, project and milestone", async () => {
    route([["teams(", () => TEAM], ["issueUpdate", () => ({ issueUpdate: { issue: raw("STEP-7", "u7") } })], ["issues(", () => ({ issues: { nodes: [raw("STEP-7", "u7")] } })]])
    await createLinearTracker().updateIssue("STEP-7", { dueDate: "2026-10-16", projectId: "proj-1", milestoneId: null })
    await createLinearTracker().updateIssue("STEP-7", { dueDate: null, projectId: null })
    expect(sentWith("issueUpdate").map((v) => v.input)).toEqual([{ dueDate: "2026-10-16", projectId: "proj-1", projectMilestoneId: null }, { dueDate: null, projectId: null }])
    await expect(createLinearTracker().updateIssue("STEP-7", { dueDate: "next Friday" })).rejects.toThrow(/YYYY-MM-DD/)
    expect(sentWith("issueUpdate")).toHaveLength(2)
  })
})

describe("createProject", () => {
  const project = (milestones: Array<{ id: string; name: string }>) => ({ id: PROJECT_KEY, name: "Translations", url: "https://linear.app/step/project/translations", targetDate: "2026-10-30", projectMilestones: { nodes: milestones.map((m) => ({ ...m, targetDate: null })) } })

  it("creates the project on the team under the caller's id, then each milestone once, with ids of its own", async () => {
    let made: Array<{ id: string; name: string }> = []
    route([
      ["teams(", () => TEAM],
      ["projectCreate", () => ({ projectCreate: { project: project([]) } })],
      ["projectMilestoneCreate", (v) => ((made = [...made, { id: v.input.id, name: v.input.name }]), { projectMilestoneCreate: { success: true } })],
      ["project(id:", () => ({ project: project(made) })],
    ])
    const p = await createLinearTracker().createProject({ name: "Translations", summary: "Every locale, by AI with page context", content: "# Plan", targetDate: "2026-10-30", milestones: [{ name: "Nordic", targetDate: "2026-10-16" }, { name: "The rest" }], clientId: PROJECT_KEY })
    expect(sentWith("projectCreate")[0].input).toEqual({ id: PROJECT_KEY, name: "Translations", teamIds: ["team-uuid"], description: "Every locale, by AI with page context", content: "# Plan", targetDate: "2026-10-30" })
    expect(sentWith("projectMilestoneCreate").map((v) => v.input)).toEqual([
      { id: stableUuid(`${PROJECT_KEY}:milestone:0`), projectId: PROJECT_KEY, name: "Nordic", targetDate: "2026-10-16" },
      { id: stableUuid(`${PROJECT_KEY}:milestone:1`), projectId: PROJECT_KEY, name: "The rest" },
    ])
    expect(p).toEqual({ id: PROJECT_KEY, name: "Translations", url: "https://linear.app/step/project/translations", targetDate: "2026-10-30", milestones: made.map((m) => ({ ...m, targetDate: null })) })
  })

  it("reads the project back when a retry finds its id taken, and makes only the missing milestones", async () => {
    route([
      ["teams(", () => TEAM],
      ["projectCreate", () => Promise.reject(new Error("Linear: Entity id already exists"))],
      ["projectMilestoneCreate", () => ({ projectMilestoneCreate: { success: true } })],
      ["project(id:", () => ({ project: project([{ id: "ms-a", name: "Nordic" }]) })],
    ])
    await createLinearTracker().createProject({ name: "Translations", milestones: [{ name: "Nordic" }, { name: "The rest" }], clientId: PROJECT_KEY })
    expect(sentWith("projectMilestoneCreate").map((v) => v.input.name)).toEqual(["The rest"])
  })

  it("keeps a create's own error when nothing landed", async () => {
    route([
      ["teams(", () => TEAM],
      ["projectCreate", () => Promise.reject(new Error("Linear: name is too long"))],
      ["project(id:", () => ({ project: null })],
    ])
    await expect(createLinearTracker().createProject({ name: "x".repeat(300), milestones: [], clientId: PROJECT_KEY })).rejects.toThrow(/name is too long/)
    expect(sentWith("projectMilestoneCreate")).toEqual([])
  })

  it("keeps a summary to Linear's one short line, and checks every id and date before any write", async () => {
    route([["teams(", () => TEAM], ["projectCreate", () => ({ projectCreate: { project: project([]) } })], ["project(id:", () => ({ project: project([]) })]])
    await createLinearTracker().createProject({ name: "p", summary: "s".repeat(300), milestones: [], clientId: PROJECT_KEY })
    expect(sentWith("projectCreate")[0].input.description).toHaveLength(255)
    requestMock.mockClear()
    await expect(createLinearTracker().createProject({ name: "p", milestones: [], clientId: "STEP-7" })).rejects.toThrow(/UUID/)
    await expect(createLinearTracker().createProject({ name: "p", targetDate: "soon", milestones: [] })).rejects.toThrow(/YYYY-MM-DD/)
    await expect(createLinearTracker().createProject({ name: "p", milestones: [{ name: "m", targetDate: "30/10" }] })).rejects.toThrow(/YYYY-MM-DD/)
    expect(sentWith("projectCreate")).toEqual([])
  })
})
