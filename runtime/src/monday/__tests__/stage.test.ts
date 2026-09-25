import { describe, expect, it } from "vitest"
import { classOf, progressText, requestGroup, requestStage, typeOf, weekOf, workDone, type RequestIssue, type RequestWork } from "../stage.ts"

const TYPE: Record<string, string> = { Triage: "triage", Backlog: "backlog", Refining: "backlog", Ready: "unstarted", "On hold": "unstarted", Released: "completed", Canceled: "canceled", Duplicate: "duplicate" }
const I = (state: string, labels: string[] = []): RequestIssue => ({ state, stateType: TYPE[state] ?? "started", labels })

describe("a request's Stage and Progress, from Linear (spec 4)", () => {
  it.each<[string, RequestWork, string, string]>([
    ["no anchor yet", { anchor: null, children: [] }, "New", ""],
    ["in Triage", { anchor: I("Triage"), children: [] }, "New", ""],
    ["refining", { anchor: I("Refining"), children: [] }, "Clarifying", ""],
    ["a question open", { anchor: I("On hold", ["awaiting-answer"]), children: [] }, "Clarifying", ""],
    ["a plan to approve", { anchor: I("On hold", ["awaiting-answer", "plan-to-approve", "approval/try"]), children: [] }, "Plan to approve", ""],
    ["parked by a person", { anchor: I("On hold"), children: [] }, "On hold", "0 of 1 done"],
    ["one task, the anchor itself, in the queue", { anchor: I("Ready", ["approval/auto"]), children: [] }, "Building", "0 of 1 done"],
    ["tasks under way", { anchor: I("In Progress"), children: [I("In Progress"), I("Released")] }, "Building", "1 of 2 done"],
    ["the agents check it", { anchor: I("In Progress", ["approval/auto"]), children: [I("Agent UAT"), I("Agent UAT")] }, "Checking", "0 of 2 done"],
    ["a Look to see", { anchor: I("In Progress", ["approval/look"]), children: [I("Waiting for UAT", ["approval/look"]), I("Released")] }, "Ready to test", "1 of 2 done"],
    ["tried and approved, waiting for the release", { anchor: I("In Progress", ["approval/try"]), children: [I("Approved"), I("Approved")] }, "Ready to test", "2 of 2 done, out with the next release"],
    ["all released", { anchor: I("In Progress"), children: [I("Released"), I("Released")] }, "Released", "2 of 2 done"],
    ["the anchor released by hand while a task is back for a fix", { anchor: I("Released"), children: [I("Released"), I("Needs Correction")] }, "Building", "1 of 2 done"],
    ["a canceled task counts in neither number", { anchor: I("In Progress"), children: [I("Released"), I("Canceled")] }, "Released", "1 of 1 done"],
    ["declined", { anchor: I("Canceled"), children: [] }, "Declined", ""],
    ["a duplicate", { anchor: I("Duplicate"), children: [] }, "Declined", ""],
    ["every open task parked", { anchor: I("In Progress"), children: [I("On hold"), I("Released")] }, "On hold", "1 of 2 done"],
    ["a project of 12 tasks", { anchor: I("In Progress"), children: [...Array(4).fill(I("Released")), I("Needs Correction"), ...Array(6).fill(I("Ready")), I("Canceled")] }, "Building", "4 of 11 done"],
  ])("%s", (_, work, stage, progress) => {
    expect(requestStage(work)).toBe(stage)
    expect(progressText(work, requestStage(work), false)).toBe(progress)
  })

  it("says a released Question was answered", () => {
    expect(progressText({ anchor: I("Released", ["question"]), children: [] }, "Released", true)).toBe("Answered")
  })

  it("groups: Released alone, Declined and On hold together, the rest Active", () => {
    expect(["New", "Building", "Ready to test", "Released", "Declined", "On hold"].map((s) => requestGroup(s as never))).toEqual(["active", "active", "active", "released", "closed", "closed"])
  })

  it("marks the anchor done only when every task is settled and one was released", () => {
    expect(workDone({ anchor: I("In Progress"), children: [I("Released"), I("Canceled")] })).toBe(true)
    expect(workDone({ anchor: I("In Progress"), children: [I("Canceled")] })).toBe(false)
    expect(workDone({ anchor: I("In Progress"), children: [] })).toBe(false)
    expect(workDone({ anchor: I("In Progress"), children: [I("Released"), I("Approved")] })).toBe(false)
  })

  it("reads the class, the type and the target week", () => {
    expect([classOf(["approval/look"]), classOf(["polads"])]).toEqual(["Look", null])
    expect(["feature", "improvement", "chore", "bug", "question", "request"].map((l) => typeOf([l]))).toEqual(["Feature", "Change", "Change", "Bug", "Question", null])
    expect(weekOf("2026-10-07")).toEqual({ startDate: "2026-10-05", endDate: "2026-10-11" })
    expect(weekOf("2026-10-11")).toEqual({ startDate: "2026-10-05", endDate: "2026-10-11" })
    expect(weekOf(null)).toBeNull()
  })
})
