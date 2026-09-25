import { describe, expect, it } from "vitest"
import { approvalPatch, classOfLabels, LowersClass, touchesApproval } from "../approval.ts"

describe("classOfLabels", () => {
  it("takes the highest approval label and ignores the rest", () => {
    expect(classOfLabels(["polads", "approval/look", "approval/auto"])).toBe("look")
    // Whatever order Linear lists them in.
    expect(classOfLabels(["approval/auto", "polads", "approval/try"])).toBe("try")
    expect(classOfLabels(["approval/nope"])).toBeNull()
  })
})

describe("approvalPatch", () => {
  it("leaves a patch that touches no approval label alone", () => {
    const patch = { state: "Ready", addLabels: ["agent-ready"] }
    expect(touchesApproval(patch)).toBe(false)
    expect(approvalPatch(["approval/try"], patch)).toBe(patch)
  })

  it("sets a first class", () => {
    expect(approvalPatch(["polads"], { addLabels: ["approval/look"] })).toEqual({ addLabels: ["approval/look"] })
  })

  it("raises a class and removes the lower label in the same write", () => {
    expect(approvalPatch(["polads", "approval/auto"], { addLabels: ["approval/try", "agent-ready"] })).toEqual({
      addLabels: ["approval/try", "agent-ready"],
      removeLabels: ["approval/auto"],
    })
  })

  it("refuses to lower a class", () => {
    expect(() => approvalPatch(["approval/try"], { addLabels: ["approval/auto"], removeLabels: ["approval/try"] })).toThrow(LowersClass)
  })

  it("refuses to remove the only class", () => {
    expect(() => approvalPatch(["approval/look"], { removeLabels: ["approval/look"] })).toThrow(LowersClass)
  })

  it("refuses two classes in one write", () => {
    expect(() => approvalPatch([], { addLabels: ["approval/look", "approval/try"] })).toThrow(LowersClass)
  })

  it("keeps the same class without touching other labels", () => {
    expect(approvalPatch(["approval/look"], { addLabels: ["approval/look"], removeLabels: ["awaiting-answer"] })).toEqual({
      addLabels: ["approval/look"],
      removeLabels: ["awaiting-answer"],
    })
  })
})
