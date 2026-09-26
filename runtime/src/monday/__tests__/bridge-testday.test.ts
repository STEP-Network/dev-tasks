/**
 * Test day on the Monday board (Wave 3, WS7): the fixed verbs and the Test
 * day item's presses file one command each for agentd, and never reach
 * Linear. Made-up people (Ada 111, Ben 222) and ids.
 */
import { describe, expect, it } from "vitest"
import { issue } from "../../__tests__/fakes.ts"
import { pendingCommands, TESTDAY_HELP } from "../../testday/commands.ts"
import { readRecords } from "../store.ts"
import { AGENT, doorsSetup, NEEDS_COLUMNS as COL } from "./fake-monday.ts"

const ADA = "111"
const BEN = "222"
const STRANGER = "333"
const commands = (s: ReturnType<typeof doorsSetup>) => pendingCommands(s.paths).map((e) => e.payload)

describe("test day on the Monday board (Wave 3, WS7)", () => {
  it("begin testday as an update on any item files a start, answered there, and never reaches the issue", async () => {
    const s = doorsSetup([issue({ id: "STEP-7", title: "Export", state: "In Progress", labels: ["needs-human"] })], { testDay: true })
    await s.bridge.sync()
    const item = s.monday.item(/Export/)!
    const said = s.monday.says(item.id, ADA, "begin testday")
    s.later(3)
    await s.bridge.sync()
    expect(commands(s)).toEqual([
      expect.objectContaining({ verb: "start", who: "Ada", whoId: ADA, whoKey: "monday:111", via: "monday", door: { kind: "monday", itemId: item.id, updateId: said, threadId: said } }),
    ])
    expect(s.fake.called("updateIssue")).toEqual([])
    // Heard once: the next poll files nothing more.
    s.later(3)
    await s.bridge.sync()
    expect(commands(s)).toHaveLength(1)
  })

  it("a person's Start on the Test day item's status column files a start; the agent's own writes, a stranger's and another item's file nothing", async () => {
    const s = doorsSetup([issue({ id: "STEP-7", title: "Export", state: "In Progress", labels: ["needs-human"] })], { testDay: true })
    await s.bridge.sync()
    const itemId = await s.testDayItem()
    s.monday.answers(itemId, ADA, "Start", "col_status")
    s.monday.answers(itemId, AGENT, "Preparing", "col_status")
    s.monday.answers(itemId, STRANGER, "Start", "col_status")
    s.monday.answers(s.monday.item(/Export/)!.id, BEN, "Start", "col_status")
    s.later(3)
    await s.bridge.sync()
    expect(commands(s).map((c) => [c.verb, c.who, c.via, c.door])).toEqual([["start", "Ada", "monday", { kind: "monday", itemId, updateId: null, threadId: null }]])
    s.later(3)
    await s.bridge.sync()
    expect(commands(s)).toHaveLength(1)
  })

  it("reads the status column only while test day is on", async () => {
    const on = doorsSetup([], { testDay: true })
    await on.bridge.sync()
    expect(on.monday.called("readBoard").map((c) => c[2])).toContainEqual([COL.answer, "col_status"])
    const off = doorsSetup([], { testDay: "off" })
    await off.bridge.sync()
    expect(off.monday.called("readBoard").map((c) => c[2])).toEqual([[COL.answer]])
  })

  it("Release and Cancel are presses too; any other label a person sets is ignored", async () => {
    const s = doorsSetup([], { testDay: true })
    const itemId = await s.testDayItem()
    s.monday.answers(itemId, BEN, "Release", "col_status")
    s.monday.answers(itemId, ADA, "Released", "col_status")
    s.monday.answers(itemId, ADA, "Cancel", "col_status")
    s.later(3)
    await s.bridge.sync()
    expect(commands(s).map((c) => [c.verb, c.who])).toEqual([["release", "Ben"], ["cancel", "Ada"]])
    expect(readRecords(s.paths).find((r) => r.key === "testday-item")!.handled).toHaveLength(3)
  })

  it("a verdict update on the Test day item is a checkpoint verdict; other words there get the help, not Linear", async () => {
    const s = doorsSetup([], { testDay: true })
    const itemId = await s.testDayItem()
    s.monday.says(itemId, BEN, "4 pass")
    s.monday.says(itemId, ADA, "looks fine to me")
    s.later(3)
    await s.bridge.sync()
    await s.bridge.drain()
    expect(commands(s)).toEqual([expect.objectContaining({ verb: "verdict", n: 4, verdict: "pass", note: "", who: "Ben", whoKey: "monday:222" })])
    expect(s.texts(itemId).filter((t) => t.includes("Here I read three things"))).toHaveLength(1)
    expect(s.fake.called("readIssue")).toEqual([])
    expect(s.fake.called("updateIssue")).toEqual([])
  })

  it("fix before release or next week on a failed checkpoint's decision item is its decision, for that issue", async () => {
    const s = doorsSetup([], { testDay: true })
    const itemId = await s.testDayItem("testday-decision", "STEP-7")
    s.monday.says(itemId, ADA, "Next week.")
    s.monday.says(itemId, BEN, "4 fail")
    s.later(3)
    await s.bridge.sync()
    expect(commands(s)).toEqual([expect.objectContaining({ verb: "decide", issue: "STEP-7", answer: "next-week", who: "Ada" })])
    await s.bridge.drain()
    expect(s.texts(itemId).some((t) => t.includes(TESTDAY_HELP.slice(0, 30)))).toBe(true)
    expect(s.fake.called("updateIssue")).toEqual([])
  })

  it("a verdict or a decision said on an issue's own item is words for that issue, as always", async () => {
    const s = doorsSetup([issue({ id: "STEP-7", title: "Export", state: "In Progress", labels: ["needs-human"] })], { testDay: true })
    await s.bridge.sync()
    const item = s.monday.item(/Export/)!
    s.monday.says(item.id, ADA, "next week")
    s.monday.says(item.id, BEN, "4 pass")
    s.later(3)
    await s.bridge.sync()
    expect(commands(s)).toEqual([])
    expect(s.fake.issues.get("STEP-7")!.description).toContain("next week")
    expect(s.fake.issues.get("STEP-7")!.description).toContain("4 pass")
  })

  it("the morning digest counts a failed checkpoint's decision, and never the Test day item as a change to try", async () => {
    const s = doorsSetup([], { testDay: true, digest: true })
    await s.testDayItem()
    await s.testDayItem("testday-decision", "STEP-7")
    await s.bridge.sync()
    const digest = s.slack().find((m) => "text" in m && /^Good morning/.test(String(m.text)))
    expect(digest && "text" in digest ? digest.text : null).toMatch(/^Good morning\. Waiting for you: 1 decision\./)
    expect(digest && "text" in digest ? digest.text : "").not.toMatch(/to try on test day/)
  })

  it("test-day items are never closed by the needs pass, and never get a Slack thread of their own", async () => {
    const s = doorsSetup([], { testDay: true })
    const itemId = await s.testDayItem()
    const decision = await s.testDayItem("testday-decision", "STEP-7")
    // Wherever a person moves it: the Test day item stands for no issue.
    await s.monday.api.moveItem(itemId, "g_fyi")
    for (let i = 0; i < 3; i++) {
      s.later(3)
      await s.bridge.sync()
    }
    expect(s.monday.called("setColumns").filter((c) => c[1] === itemId || c[1] === decision)).toEqual([])
    expect(s.monday.called("moveItem")).toEqual([[itemId, "g_fyi"]])
    expect(s.slack().filter((m) => "issue" in m && (m as { issue?: string }).issue === "testday")).toEqual([])
    expect(readRecords(s.paths).filter((r) => r.kind.startsWith("testday")).map((r) => r.state)).toEqual(["Needs you", "Needs you"])
  })

  it("with test day off, begin testday on an item is words for its issue, as before", async () => {
    const s = doorsSetup([issue({ id: "STEP-7", title: "Export", state: "In Progress", labels: ["needs-human"] })], { testDay: "off" })
    await s.bridge.sync()
    const item = s.monday.item(/Export/)!
    s.monday.says(item.id, ADA, "begin testday")
    s.later(3)
    await s.bridge.sync()
    expect(commands(s)).toEqual([])
    expect(s.fake.issues.get("STEP-7")!.description).toContain("begin testday")
  })
})
