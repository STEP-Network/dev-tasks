/**
 * The Needs-you board on the Wave 2 layout (spec 6): each need in its group,
 * and the Recommendation and Request columns. Made-up people and ids.
 */
import { describe, expect, it } from "vitest"
import { askDecision, questionText } from "../../agentd/decisions.ts"
import { enqueueSlack } from "../../outbox.ts"
import { recommendationOf, withRecommendation } from "../../plain.ts"
import { issue } from "../../__tests__/fakes.ts"
import { readRecords, saveRecord } from "../store.ts"
import { BOARD, doorsSetup, NEEDS_COLUMNS as COL, T0 } from "./fake-monday.ts"

describe("the Needs-you board's groups and columns (spec 6)", () => {
  it("puts each need in its group: a question in Decide, a plan in Approve plan, a Look in Looks good?, a Try in Test day", async () => {
    const { bridge, monday } = doorsSetup([
      issue({ id: "STEP-1", title: "Which date", state: "On hold", labels: ["awaiting-answer"] }),
      issue({ id: "STEP-2", title: "Bulk upload", state: "On hold", labels: ["awaiting-answer", "plan-to-approve", "approval/try"] }),
      issue({ id: "STEP-3", title: "Wider buttons", state: "Waiting for UAT", labels: ["polads", "approval/look"] }),
      issue({ id: "STEP-4", title: "New checkout", state: "Waiting for UAT", labels: ["polads", "approval/try"] }),
    ])
    await bridge.sync()
    const where = (name: RegExp) => {
      const item = monday.item(name)!
      return [item.groupId, item.columns[COL.kind]?.text, item.columns.col_rec?.text ?? null]
    }
    expect(where(/Which date/)).toEqual(["g_needs", "Decision", null])
    // This mini asked no plan question: the item recommends nothing it was not told to.
    expect(where(/Bulk upload/)).toEqual(["g_plan", "Approval", null])
    expect(where(/Wider buttons/)).toEqual(["g_looks", "Check", "Looks good"])
    expect(where(/New checkout/)).toEqual(["g_test", "Check", null])
  })

  it("asks for a plan's OK only while it waits on the plan question: a plan label on a needs-human issue stays in Decide", async () => {
    const { bridge, monday } = doorsSetup([issue({ id: "STEP-2", title: "Bulk upload", state: "In Progress", labels: ["needs-human", "plan-to-approve"] })])
    await bridge.sync()
    expect(monday.item(/Bulk upload/)!.groupId).toBe("g_needs")
  })

  it("writes a plan's Recommendation from its question, and none when the question gives none", async () => {
    const { bridge, monday, paths } = doorsSetup([
      issue({ id: "STEP-2", title: "Bulk upload", state: "On hold", labels: ["awaiting-answer", "plan-to-approve", "approval/try"] }),
      issue({ id: "STEP-5", title: "Split exports", state: "On hold", labels: ["awaiting-answer", "plan-to-approve", "approval/try"] }),
    ])
    enqueueSlack(paths, { kind: "issue", issue: "STEP-2", text: withRecommendation("Two tasks, this week.", "Build it as planned"), question: true }, T0)
    enqueueSlack(paths, { kind: "issue", issue: "STEP-5", text: "Two tasks or three?", question: true }, T0)
    await bridge.sync()
    expect(monday.item(/Bulk upload/)!.columns.col_rec?.text).toBe("Build it as planned")
    expect(monday.item(/Split exports/)!.columns.col_rec?.text ?? null).toBeNull()
  })

  it("takes a yes on a plan it did not ask as agreement to the item's Recommendation, which approves the plan", async () => {
    const { bridge, monday, fake, later } = doorsSetup([issue({ id: "STEP-2", title: "Bulk upload", state: "On hold", labels: ["awaiting-answer", "plan-to-approve", "approval/try"] })])
    await bridge.sync()
    const item = monday.item(/Bulk upload/)!
    // Another mini's plan: the Recommendation on the item is what a yes agrees to.
    await monday.api.setColumns(BOARD, item.id, { col_rec: "Build it as planned" })
    later(1)
    monday.says(item.id, "111", "yes")
    later(1)
    await bridge.sync()
    expect(fake.issues.get("STEP-2")!.labels).toEqual(expect.arrayContaining(["plan-approved", "approval/try"]))
    expect(fake.issues.get("STEP-2")!.description).toContain("Ada agreed with the recommendation: Build it as planned.")
  })

  it("without the new groups in config, every item goes where it went before", async () => {
    const { bridge, monday } = doorsSetup(
      [issue({ id: "STEP-2", title: "Bulk upload", state: "On hold", labels: ["awaiting-answer", "plan-to-approve"] }), issue({ id: "STEP-3", title: "Wider buttons", state: "Waiting for UAT", labels: ["polads", "approval/look"] })],
      { newLayout: false },
    )
    await bridge.sync()
    expect(monday.item(/Bulk upload/)!.groupId).toBe("g_needs")
    expect(monday.item(/Wider buttons/)!.groupId).toBe("g_test")
  })

  it("writes the Recommendation of the question as this mini asked it", async () => {
    const { bridge, monday, paths } = doorsSetup([issue({ id: "STEP-1", title: "Which date", state: "On hold", labels: ["awaiting-answer"] })])
    enqueueSlack(paths, { kind: "issue", issue: "STEP-1", text: withRecommendation("Which date should the notice show?", "use the order date"), question: true }, T0)
    await bridge.sync()
    expect(monday.item(/Which date/)!.columns.col_rec?.text).toBe("use the order date")
  })

  it("links a task's item to its request through the Request column, once the request is known", async () => {
    const { bridge, monday, paths, later } = doorsSetup([issue({ id: "STEP-11", title: "Export", state: "In Progress", labels: ["needs-human"] })], { parents: { "STEP-11": "STEP-10" } })
    await bridge.sync()
    const item = monday.item(/Export/)!
    expect(item.columns.col_request).toBeUndefined()
    saveRecord(paths, { key: "request-5001", kind: "request", issue: "STEP-10", itemId: "5001", state: "Waiting on agent", bodyHash: null, createdAt: T0.toISOString(), doneAt: null, handled: [] })
    later(2)
    await bridge.sync()
    later(2)
    await bridge.sync()
    expect(monday.called("setColumns").filter(([, , v]) => "col_request" in (v as object))).toEqual([[BOARD, item.id, { col_request: { item_ids: [5001] } }]])
  })

  it("writes the Recommendation of agentd's own decision: its default", async () => {
    const { bridge, monday, paths, config } = doorsSetup([issue({ id: "STEP-7", title: "Fix the date", state: "In Review", labels: ["polads"] })])
    const d = askDecision(paths, config, {
      id: "infra-STEP-7-abc", issue: "STEP-7", url: "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1679", question: "CI failed on its infrastructure again.",
      options: [{ reply: "re-run", does: "re-run CI in full once more" }, { reply: "leave it", does: "leave the PR to a person" }],
      defaultReply: "re-run", defaultAction: { kind: "rerun", runs: ["111"] },
    }, T0)!
    await bridge.sync()
    // As Slack words it: the default option, which a yes takes.
    expect(recommendationOf(questionText(d, config.queue.timeZone))).toBe("re-run CI in full once more")
    expect(monday.item(/Fix the date/)!.columns.col_rec?.text).toBe("re-run CI in full once more")
  })

  it("clears a stale Recommendation when the item asks again without one", async () => {
    const { bridge, monday, paths, later, fake } = doorsSetup([issue({ id: "STEP-1", title: "Which date", state: "On hold", labels: ["awaiting-answer"] })])
    enqueueSlack(paths, { kind: "issue", issue: "STEP-1", text: withRecommendation("Which date should the notice show?", "use the order date"), question: true }, T0)
    await bridge.sync()
    const item = monday.item(/Which date/)!
    expect(item.columns.col_rec?.text).toBe("use the order date")
    later(1)
    enqueueSlack(paths, { kind: "issue", issue: "STEP-1", text: "One more thing: which page?", question: true }, new Date(T0.getTime() + 60_000))
    fake.issues.set("STEP-1", { ...fake.issues.get("STEP-1")!, description: "changed" })
    later(1)
    await bridge.sync()
    expect(monday.called("setColumns").some(([, id, v]) => id === item.id && (v as Record<string, unknown>).col_rec === "")).toBe(true)
  })

  it("records no Request link before the board has the column, so go-live still writes it", async () => {
    const { bridge, paths } = doorsSetup([issue({ id: "STEP-10", title: "Export", state: "In Progress", labels: ["needs-human"] })], { newLayout: false })
    saveRecord(paths, { key: "request-5001", kind: "request", issue: "STEP-10", itemId: "5001", state: "Waiting on agent", bodyHash: null, createdAt: T0.toISOString(), doneAt: null, handled: [] })
    await bridge.sync()
    expect(readRecords(paths).find((r) => r.kind === "needs")!.requestItem).toBeUndefined()
  })

  it("writes the Request column once, and never again while it stands", async () => {
    const { bridge, monday, paths, later } = doorsSetup([issue({ id: "STEP-10", title: "Export", state: "In Progress", labels: ["needs-human"] })])
    saveRecord(paths, { key: "request-5001", kind: "request", issue: "STEP-10", itemId: "5001", state: "Waiting on agent", bodyHash: null, createdAt: T0.toISOString(), doneAt: null, handled: [] })
    await bridge.sync()
    const item = monday.item(/Export/)!
    expect(monday.called("createItem").find(([, , , v]) => "col_request" in (v as object))?.[3]).toMatchObject({ col_request: { item_ids: [5001] } })
    later(2)
    await bridge.sync()
    expect(monday.called("setColumns").filter(([, id, v]) => id === item.id && "col_request" in (v as object))).toEqual([])
  })
})
