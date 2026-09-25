import { describe, expect, it } from "vitest"
import { assertLinearClientId, issue } from "../../__tests__/fakes.ts"
import type { CreateIssueInput } from "../../tracker.ts"
import { linearEvidence, noEvidence } from "../evidence.ts"

/** Linear's answers to the label query, and every request made. */
function fakeLinear(hasRetroLabel: boolean) {
  const requests: Array<{ query: string; variables?: Record<string, unknown> }> = []
  const request = async <T,>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    requests.push({ query, variables })
    if (query.includes("issueLabelCreate")) return { issueLabelCreate: { success: true } } as T
    return { teams: { nodes: [{ id: "team-step", labels: { nodes: hasRetroLabel ? [{ id: "label-retro" }] : [] } }] } } as T
  }
  const created: CreateIssueInput[] = []
  const links: Array<[string, string, string | undefined]> = []
  const tracker = {
    createIssue: async (input: CreateIssueInput) => {
      created.push(input)
      // As Linear itself: a client id that is not a v4 UUID is refused (STEP-3323).
      assertLinearClientId(input.clientId)
      return issue({ id: "STEP-900", url: "https://linear.app/step/issue/STEP-900", title: input.title, labels: input.labels ?? [] })
    },
    attachLink: async (ref: string, url: string, title?: string) => void links.push([ref, url, title]),
  }
  return { requests, created, links, sink: linearEvidence(tracker, request) }
}

const INPUT = { key: "retro:eve:2026-09-25", title: "Retro evidence: eve's week to 2026-09-25", description: "Quotes, links and evidence." }

describe("the retro's evidence issue (STEP-3290)", () => {
  it("files one Triage issue in STEP, labelled dev-tasks and retro, creating the retro label the first time", async () => {
    const l = fakeLinear(false)
    expect(await l.sink.file(INPUT)).toEqual({ id: "STEP-900", url: "https://linear.app/step/issue/STEP-900" })
    expect(l.requests.map((r) => (r.query.includes("issueLabelCreate") ? "create" : "read"))).toEqual(["read", "create"])
    expect(l.requests[0].variables).toEqual({ key: "STEP", name: "retro" })
    expect(l.requests[1].variables).toEqual({ input: { name: "retro", teamId: "team-step" } })
    expect(l.created).toEqual([{ title: INPUT.title, description: INPUT.description, state: "Triage", labels: ["dev-tasks", "retro"], clientId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) }])
  })

  it("creates no label that exists, and sends the same client id for the same retro, so a retry opens no second issue", async () => {
    const l = fakeLinear(true)
    await l.sink.file(INPUT)
    await l.sink.file(INPUT)
    await l.sink.file({ ...INPUT, key: "retro:eve:2026-10-02" })
    expect(l.requests.some((r) => r.query.includes("issueLabelCreate"))).toBe(false)
    expect(l.created[0].clientId).toBe(l.created[1].clientId)
    expect(l.created[2].clientId).not.toBe(l.created[0].clientId)
  })

  it("links the PR on the issue, and a dry run files nothing", async () => {
    const l = fakeLinear(true)
    await l.sink.link("STEP-900", "https://github.com/STEP-Network/dev-tasks/pull/130")
    expect(l.links).toEqual([["STEP-900", "https://github.com/STEP-Network/dev-tasks/pull/130", "The retro's PR"]])
    await expect(noEvidence.file(INPUT)).rejects.toThrow("a dry run files no evidence")
  })
})
