import { describe, expect, it } from "vitest"
import { developEligible, nextWakeupSeconds, refineEligible, selectNext, type QueuePolicy } from "../select.ts"
import type { TrackerIssue } from "../tracker.ts"
import { EVE, issue } from "./fakes.ts"

const OPEN: QueuePolicy = { mode: "open", allow: [], refineWhenReadyBelow: 5, product: "polads" }
const ME = EVE.id
const ready = (id: string, over: Partial<TrackerIssue> = {}) => issue({ id, state: "Ready", labels: ["polads", "agent-ready"], ...over })

describe("developEligible", () => {
  it("wants Ready, agent-ready, this product, and nobody else holding it", () => {
    expect(developEligible(ready("STEP-1"), ME, OPEN)).toBe(true)
    expect(developEligible(ready("STEP-2", { assigneeId: ME }), ME, OPEN)).toBe(true)
    expect(developEligible(ready("STEP-3", { assigneeId: "user-alice" }), ME, OPEN)).toBe(false)
    expect(developEligible(ready("STEP-4", { labels: ["polads"] }), ME, OPEN)).toBe(false)
    expect(developEligible(ready("STEP-5", { labels: ["dev-tasks", "agent-ready"] }), ME, OPEN)).toBe(false)
    expect(developEligible(ready("STEP-6", { state: "Refining" }), ME, OPEN)).toBe(false)
  })

  it("never takes a human to-do or an issue waiting for an answer", () => {
    expect(developEligible(ready("STEP-1", { labels: ["polads", "agent-ready", "human-todo"] }), ME, OPEN)).toBe(false)
    expect(developEligible(ready("STEP-2", { labels: ["polads", "agent-ready", "awaiting-answer"] }), ME, OPEN)).toBe(false)
  })

  it("in allowlist mode takes only the listed ids", () => {
    const allow: QueuePolicy = { ...OPEN, mode: "allowlist", allow: ["STEP-2"] }
    expect(developEligible(ready("STEP-1"), ME, allow)).toBe(false)
    expect(developEligible(ready("STEP-2"), ME, allow)).toBe(true)
  })
})

describe("refineEligible", () => {
  it("takes Triage whatever its product, Refining and unrefined Ready for this product", () => {
    expect(refineEligible(issue({ id: "STEP-1", state: "Triage", labels: [] }), OPEN)).toBe(true)
    expect(refineEligible(issue({ id: "STEP-2", state: "Refining", labels: ["polads"] }), OPEN)).toBe(true)
    expect(refineEligible(issue({ id: "STEP-3", state: "Ready", labels: ["polads"] }), OPEN)).toBe(true)
    expect(refineEligible(issue({ id: "STEP-4", state: "Ready", labels: ["polads", "agent-ready"] }), OPEN)).toBe(false)
    expect(refineEligible(issue({ id: "STEP-6", state: "Backlog", labels: ["polads"] }), OPEN)).toBe(false)
  })

  it("leaves human to-dos alone until a person answers, which sends them back through Refining", () => {
    expect(refineEligible(issue({ id: "STEP-5", state: "Ready", labels: ["polads", "human-todo"] }), OPEN)).toBe(false)
    expect(refineEligible(issue({ id: "STEP-7", state: "Refining", labels: ["polads", "human-todo"] }), OPEN)).toBe(true)
    expect(refineEligible(issue({ id: "STEP-8", state: "Refining", labels: ["polads", "awaiting-answer"] }), OPEN)).toBe(false)
  })

  it("in allowlist mode refines only the listed ids", () => {
    const allow: QueuePolicy = { ...OPEN, mode: "allowlist", allow: ["STEP-2"] }
    expect(refineEligible(issue({ id: "STEP-1", state: "Triage" }), allow)).toBe(false)
    expect(refineEligible(issue({ id: "STEP-2", state: "Triage" }), allow)).toBe(true)
  })
})

describe("selectNext", () => {
  const base = { triage: [], refining: [], meId: ME, policy: OPEN, developBlockedBy: null, refineBlockedBy: null }

  it("takes the issue I already hold first, then the unassigned queue in its given order", () => {
    const s = selectNext({ ...base, ready: [ready("STEP-1"), ready("STEP-2", { assigneeId: ME }), ready("STEP-3")] })
    expect(s.develop?.id).toBe("STEP-2")
    expect(selectNext({ ...base, ready: [ready("STEP-1"), ready("STEP-3")] }).develop?.id).toBe("STEP-1")
  })

  it("develops nothing while blocked, but still counts and refines", () => {
    const s = selectNext({ ...base, ready: [ready("STEP-1")], triage: [issue({ id: "STEP-9", state: "Triage" })], developBlockedBy: "a worker is busy" })
    expect(s).toMatchObject({ develop: null, readyEligible: 1 })
    expect(s.refine?.id).toBe("STEP-9")
  })

  it("refines Triage first, then Refining, then unrefined Ready, only while fewer than five are eligible", () => {
    const unrefined = issue({ id: "STEP-20", state: "Ready", labels: ["polads"] })
    const refiningOne = issue({ id: "STEP-30", state: "Refining", labels: ["polads"] })
    expect(selectNext({ ...base, ready: [unrefined], refining: [refiningOne], triage: [issue({ id: "STEP-10", state: "Triage" })] }).refine?.id).toBe("STEP-10")
    expect(selectNext({ ...base, ready: [unrefined], refining: [refiningOne] }).refine?.id).toBe("STEP-30")
    expect(selectNext({ ...base, ready: [unrefined] }).refine?.id).toBe("STEP-20")
    const five = ["STEP-1", "STEP-2", "STEP-3", "STEP-4", "STEP-5"].map((id) => ready(id))
    expect(selectNext({ ...base, ready: [...five, unrefined] }).refine).toBeNull()
  })

  it("refines nothing while paused", () => {
    expect(selectNext({ ...base, ready: [], triage: [issue({ id: "STEP-9", state: "Triage" })], refineBlockedBy: "paused" }).refine).toBeNull()
  })
})

describe("nextWakeupSeconds", () => {
  it("is one minute after any activity", () => {
    expect(nextWakeupSeconds({ acted: true, now: new Date("2026-09-24T01:00:00Z"), timeZone: "Europe/Copenhagen" })).toBe(60)
  })

  it("is five minutes in the Copenhagen day and thirty at night", () => {
    expect(nextWakeupSeconds({ acted: false, now: new Date("2026-09-24T10:00:00Z"), timeZone: "Europe/Copenhagen" })).toBe(300)
    expect(nextWakeupSeconds({ acted: false, now: new Date("2026-09-24T21:30:00Z"), timeZone: "Europe/Copenhagen" })).toBe(1800)
  })

  it("counts the day in the configured zone, not the machine's", () => {
    // 05:30 UTC is 07:30 in Copenhagen (summer time): the working day has begun there.
    expect(nextWakeupSeconds({ acted: false, now: new Date("2026-09-24T05:30:00Z"), timeZone: "Europe/Copenhagen" })).toBe(300)
    expect(nextWakeupSeconds({ acted: false, now: new Date("2026-09-24T05:30:00Z"), timeZone: "UTC" })).toBe(1800)
  })
})
