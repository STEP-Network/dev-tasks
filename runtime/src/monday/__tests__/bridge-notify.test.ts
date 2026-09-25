/**
 * Urgent pings and the morning digest on the coordinator's bridge (spec 6,
 * Notifications). Made-up people and ids. 06:00Z is 08:00 in Copenhagen on
 * Friday 25 September 2026.
 */
import { describe, expect, it } from "vitest"
import { issue } from "../../__tests__/fakes.ts"
import type { Logger } from "../../log.ts"
import { createMondayBridge } from "../bridge.ts"
import { saveRecord } from "../store.ts"
import { doorsSetup, REQ, T0, THREAD } from "./fake-monday.ts"

const FRI_08 = new Date("2026-09-25T06:00:00.000Z")
const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} }
type Sent = { kind: string; text?: string; channel?: string }
const pings = (slack: () => Sent[]) => slack().filter((m) => m.text?.startsWith("<@"))
const digests = (slack: () => Sent[]) => slack().filter((m) => m.kind === "post" && m.channel === "questions")

describe("money or legal questions close to their date (spec 6)", () => {
  it("pings once per item and due date across polls, @-mentioning the item's Person", async () => {
    const { bridge, slack, later } = doorsSetup([issue({ id: "STEP-30", title: "VAT on invoices", state: "In Progress", labels: ["needs-human", "money"] })], {
      start: FRI_08,
      extra: { "STEP-30": { dueDate: "2026-09-26" } },
    })
    await bridge.sync()
    // The item's link comes with the next read: its ping then.
    expect(pings(slack)).toEqual([])
    later(2)
    await bridge.sync()
    later(2)
    await bridge.sync()
    const sent = pings(slack)
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toMatch(/^<@UADA> STEP-30 needs an answer by 2026-09-26, and it touches money or legal wording. Please answer in this thread or on Monday: https:\/\/step\.monday\.com\//)
  })

  it("no ping for a money question due in three days, for a question that is neither money nor legal, or at 20:00", async () => {
    const soon = doorsSetup(
      [
        issue({ id: "STEP-31", title: "Prices", state: "In Progress", labels: ["needs-human", "money"] }),
        issue({ id: "STEP-32", title: "Colours", state: "In Progress", labels: ["needs-human"] }),
        // A change to try is no question, whatever its labels.
        issue({ id: "STEP-34", title: "New prices", state: "Waiting for UAT", labels: ["polads", "money"] }),
      ],
      { start: FRI_08, extra: { "STEP-31": { dueDate: "2026-09-28" }, "STEP-32": { dueDate: "2026-09-26" }, "STEP-34": { dueDate: "2026-09-26" } } },
    )
    await soon.bridge.sync()
    soon.later(2)
    await soon.bridge.sync()
    expect(pings(soon.slack)).toEqual([])
    const late = doorsSetup([issue({ id: "STEP-33", title: "Label wording", state: "In Progress", labels: ["needs-human", "regulatory"] })], {
      start: new Date("2026-09-25T18:00:00.000Z"),
      extra: { "STEP-33": { dueDate: "2026-09-26" } },
    })
    await late.bridge.sync()
    late.later(2)
    await late.bridge.sync()
    expect(pings(late.slack)).toEqual([])
  })

  it("pings in another mini's thread when the issue's link names one", async () => {
    const { bridge, slack, later } = doorsSetup([issue({ id: "STEP-30", title: "VAT on invoices", state: "In Progress", labels: ["needs-human", "money"] })], {
      start: FRI_08,
      extra: { "STEP-30": { dueDate: "2026-09-26", slackThread: THREAD } },
    })
    await bridge.sync()
    later(2)
    await bridge.sync()
    expect(slack().filter((m) => m.text?.startsWith("<@"))).toEqual([expect.objectContaining({ kind: "reply", channelId: "CQ", threadTs: "1790000000.000100" })])
  })

  it("pings a legal question too", async () => {
    const { bridge, slack, later } = doorsSetup([issue({ id: "STEP-33", title: "Label wording", state: "In Progress", labels: ["needs-human", "regulatory"] })], {
      start: FRI_08,
      extra: { "STEP-33": { dueDate: "2026-09-25" } },
    })
    await bridge.sync()
    later(2)
    await bridge.sync()
    expect(pings(slack)).toHaveLength(1)
  })
})

describe("the morning digest (spec 6, D5)", () => {
  it("posts one digest at 08:00 on a working day, across two polls and a restart", async () => {
    const { bridge, slack, later, paths, config, monday, fake, people } = doorsSetup([], { start: FRI_08, digest: true })
    await bridge.sync()
    later(2)
    await bridge.sync()
    const again = createMondayBridge({ paths, config, log: quiet, now: () => new Date(FRI_08.getTime() + 4 * 60_000), api: monday.api, tracker: fake.tracker, people })
    await again.sync()
    expect(digests(slack)).toEqual([expect.objectContaining({ text: "Good morning. Nothing needs you this morning." })])
  })

  it("shows Wave 3's test-day line", async () => {
    const { bridge, slack } = doorsSetup([], { start: FRI_08, digest: true, testDayLine: () => "Test day in progress (14 of 20 checked)." })
    await bridge.sync()
    expect(digests(slack)).toEqual([expect.objectContaining({ text: "Good morning.\nTest day in progress (14 of 20 checked)." })])
  })

  it("posts nothing until go-live switches it on", async () => {
    const { bridge, slack } = doorsSetup([], { start: FRI_08 })
    await bridge.sync()
    expect(digests(slack)).toEqual([])
  })

  it("the digest counts the open items by the group they are in, and shows the Requests line", async () => {
    const { bridge, slack, later, monday, paths } = doorsSetup(
      [
        issue({ id: "STEP-1", title: "Which date", state: "On hold", labels: ["awaiting-answer"] }),
        issue({ id: "STEP-2", title: "Which page", state: "On hold", labels: ["awaiting-answer"] }),
        issue({ id: "STEP-10", title: "Wider buttons", state: "Waiting for UAT", labels: ["approval/look"] }),
      ],
      { start: new Date("2026-09-25T05:58:00.000Z"), digest: true, requests: true },
    )
    const request = monday.request("111", "Wider buttons", undefined, "r_active", REQ)
    saveRecord(paths, { key: `request-${request}`, kind: "request", issue: "STEP-10", itemId: request, state: "Waiting on agent", bodyHash: null, createdAt: T0.toISOString(), doneAt: null, handled: [], linked: true })
    await bridge.sync()
    expect(digests(slack)).toEqual([])
    later(2)
    await bridge.sync()
    const [digest] = digests(slack)
    expect(digest.text).toMatch(/^Good morning\. Waiting for you: 2 decisions\.\nDecide: <https:\/\/step\.monday\.com\/[^|]+\|[^>]+>, <[^>]+>\nRequests: 1 active, 1 ready to test\.$/)
  })
})
