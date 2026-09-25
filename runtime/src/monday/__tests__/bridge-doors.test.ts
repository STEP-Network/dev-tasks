/**
 * The two doors (spec 6): every Needs-you item has one Slack thread, and what
 * a person settles in one door is said in the other. Made-up people and ids.
 */
import { describe, expect, it } from "vitest"
import { recordAnswer } from "../../answer.ts"
import { enqueueSlack } from "../../outbox.ts"
import { withRecommendation } from "../../plain.ts"
import { issue } from "../../__tests__/fakes.ts"
import { readRecords, saveRecord } from "../store.ts"
import { BOARD, doorsSetup, NEEDS_COLUMNS as COL, ownThread, T0, THREAD } from "./fake-monday.ts"

/** T0 plus minutes, as the recorder takes a time. */
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000).toISOString()

describe("a Slack thread for every new item (spec 6)", () => {
  it("opens one thread for a new item, with the Monday link, and writes the thread's link back once", async () => {
    const { bridge, monday, paths, slack, later, warned } = doorsSetup([issue({ id: "STEP-1", title: "Export", state: "In Progress", labels: ["needs-human"] })])
    await bridge.sync()
    // The item's link comes with the board's next read: its thread opens then, a poll later.
    expect(slack()).toEqual([])
    expect(warned.filter((m) => /thread/i.test(m))).toEqual([])
    later(2)
    await bridge.sync()
    const item = monday.item(/Export/)!
    expect(slack()).toEqual([expect.objectContaining({ kind: "issue", issue: "STEP-1", question: false, text: `This is also on the Monday board: ${item.url}. Answer here or there, whichever suits you.` })])
    ownThread(paths, "STEP-1") // the Slack bridge opened it (send.ts) and recorded its link
    later(2)
    await bridge.sync()
    later(2)
    await bridge.sync()
    expect(slack()).toHaveLength(1)
    expect(monday.called("setColumns").filter(([, , v]) => "col_thread" in (v as object))).toEqual([[BOARD, item.id, { col_thread: { url: THREAD, text: "Slack thread" } }]])
  })

  it("posts in another mini's thread by the issue's Slack link, not a second thread", async () => {
    const { bridge, monday, slack, later } = doorsSetup([issue({ id: "STEP-1", title: "Export", state: "In Progress", labels: ["needs-human"] })], { extra: { "STEP-1": { slackThread: THREAD } } })
    await bridge.sync()
    later(2)
    await bridge.sync()
    const item = monday.item(/Export/)!
    expect(slack()).toEqual([expect.objectContaining({ kind: "reply", channelId: "CQ", threadTs: "1790000000.000100" })])
    expect(monday.called("setColumns").filter(([, , v]) => "col_thread" in (v as object))).toEqual([[BOARD, item.id, { col_thread: { url: THREAD, text: "Slack thread" } }]])
  })

  it("until the board has its Slack thread column (go-live), says nothing in Slack and nothing more on Monday", async () => {
    const { bridge, monday, fake, paths, slack, later, texts } = doorsSetup(
      [
        issue({ id: "STEP-1", title: "Which date", state: "On hold", labels: ["awaiting-answer"] }),
        issue({ id: "STEP-4", title: "New checkout", state: "Waiting for UAT", labels: ["polads", "approval/try"] }),
        // Open throughout: it would get a thread.
        issue({ id: "STEP-6", title: "Export", state: "In Progress", labels: ["needs-human"] }),
      ],
      { newLayout: false },
    )
    ownThread(paths, "STEP-1", T0.toISOString())
    await bridge.sync()
    const question = monday.item(/Which date/)!
    const tried = monday.item(/New checkout/)!
    later(1)
    // Settled in both doors: an answer on Monday, and a verdict given elsewhere.
    monday.says(question.id, "111", "the order date")
    fake.issues.set("STEP-4", { ...fake.issues.get("STEP-4")!, state: "Approved" })
    later(1)
    await bridge.sync()
    later(2)
    await bridge.sync()
    expect(fake.issues.get("STEP-1")!.state).not.toBe("On hold")
    expect(monday.items.get(tried.id)!.groupId).toBe("g_done")
    expect(slack()).toEqual([])
    expect(texts(tried.id).filter((t) => t.startsWith("Eve: Done:"))).toEqual([])
  })

  it("gives an open item made before this change its thread, a back-fill", async () => {
    const { bridge, monday, paths, slack } = doorsSetup([issue({ id: "STEP-1", title: "Export", state: "In Progress", labels: ["needs-human"] })])
    const itemId = await monday.api.createItem(BOARD, "g_needs", "Needs a person: Export", { [COL.linear]: { url: "https://linear.app/step/issue/STEP-1", text: "STEP-1" } })
    saveRecord(paths, { key: "needs-STEP-1", kind: "needs", issue: "STEP-1", itemId, state: "Needs you", bodyHash: "old", createdAt: T0.toISOString(), doneAt: null, handled: [] })
    await bridge.sync()
    expect(slack()).toEqual([expect.objectContaining({ kind: "issue", issue: "STEP-1", question: false })])
  })

  it("gives a per-issue Test day item made before this change none, the accepted exception to spec 6", async () => {
    const { bridge, monday, paths, slack } = doorsSetup([issue({ id: "STEP-4", title: "New checkout", state: "Waiting for UAT", labels: ["polads", "approval/try"] })])
    const itemId = await monday.api.createItem(BOARD, "g_test", "Try it on the test site: New checkout", { [COL.linear]: { url: "https://linear.app/step/issue/STEP-4", text: "STEP-4" } })
    saveRecord(paths, { key: "uat-STEP-4", kind: "uat", issue: "STEP-4", itemId, state: "Needs you", bodyHash: "old", createdAt: T0.toISOString(), doneAt: null, handled: [] })
    await bridge.sync()
    expect(slack()).toEqual([])
    expect(readRecords(paths)[0].thread).toBeUndefined()
  })

  it("gives a new Test day item its thread: only one made before this change goes without", async () => {
    const { bridge, slack, later } = doorsSetup([issue({ id: "STEP-4", title: "New checkout", state: "Waiting for UAT", labels: ["polads", "approval/try"] })])
    await bridge.sync()
    later(2)
    await bridge.sync()
    expect(slack()).toEqual([expect.objectContaining({ kind: "issue", issue: "STEP-4", question: false })])
  })

  it("gives a request item, and an item already Done, no thread", async () => {
    const { bridge, monday, paths, slack } = doorsSetup([issue({ id: "STEP-7", title: "Export", state: "In Progress", labels: [] }), issue({ id: "STEP-8", title: "Old", state: "In Progress", labels: [] })])
    const request = await monday.api.createItem(BOARD, "g_working", "Export to CSV", { [COL.linear]: { url: "https://linear.app/step/issue/STEP-7", text: "STEP-7" } })
    saveRecord(paths, { key: `request-${request}`, kind: "request", issue: "STEP-7", itemId: request, state: "Waiting on agent", bodyHash: null, createdAt: T0.toISOString(), doneAt: null, handled: [], linked: true })
    const done = await monday.api.createItem(BOARD, "g_done", "Needs a person: Old", { [COL.linear]: { url: "https://linear.app/step/issue/STEP-8", text: "STEP-8" } })
    saveRecord(paths, { key: "needs-STEP-8", kind: "needs", issue: "STEP-8", itemId: done, state: "Done", bodyHash: "old", createdAt: T0.toISOString(), doneAt: T0.toISOString(), handled: [] })
    await bridge.sync()
    expect(slack()).toEqual([])
  })

  it("opens no thread while Linear is out of reach: it would not know another mini's", async () => {
    const { bridge, people, slack, later } = doorsSetup([issue({ id: "STEP-1", title: "Export", state: "In Progress", labels: ["needs-human"] })], { extra: { "STEP-1": { slackThread: THREAD } } })
    await bridge.sync()
    people.needsYou = async () => {
      throw new Error("Linear is down")
    }
    later(2)
    await bridge.sync()
    expect(slack()).toEqual([])
  })
})


describe("the other door (spec 6: one answer, shown in both)", () => {
  it("mirrors a Monday answer to the Slack thread, and the item goes to Done in both", async () => {
    const { bridge, monday, paths, slack, later } = doorsSetup([issue({ id: "STEP-1", title: "Which date", state: "On hold", labels: ["awaiting-answer"] })])
    ownThread(paths, "STEP-1", T0.toISOString())
    enqueueSlack(paths, { kind: "issue", issue: "STEP-1", text: withRecommendation("Which date should the notice show?", "use the order date"), question: true }, T0)
    await bridge.sync()
    const item = monday.item(/Which date/)!
    later(1)
    monday.says(item.id, "111", "yes")
    later(1)
    await bridge.sync()
    expect(slack().at(-1)).toMatchObject({ kind: "issue", issue: "STEP-1", question: false, text: "Answered by Ada on Monday: use the order date. This is done. Nothing needed from you." })
    later(2)
    await bridge.sync()
    expect(monday.items.get(item.id)!.groupId).toBe("g_done")
  })

  it("a Slack answer recorded between polls closes the Monday item and names who answered", async () => {
    const { bridge, monday, fake, paths, later, texts } = doorsSetup([issue({ id: "STEP-1", title: "Which date", state: "On hold", labels: ["awaiting-answer"] })])
    await bridge.sync()
    const item = monday.item(/Which date/)!
    later(1)
    // The front door recorded Ben's decision from Slack through the one recorder (agentctl decide).
    await recordAnswer(
      { paths, tracker: fake.tracker },
      { issue: "STEP-1", who: "Ben", words: "the publication date", ts: "1790000100.000100", permalink: null, source: "slack", at: new Date(T0.getTime() + 60_000).toISOString(), by: "monday:222" },
      { since: T0.toISOString() },
    )
    later(1)
    await bridge.sync()
    expect(monday.items.get(item.id)!.groupId).toBe("g_done")
    expect(texts(item.id).at(-1)).toBe("Eve: Answered by Ben in Slack: the publication date. This is done. Nothing needed from you.")
  })

  it("never hears the agent's own mirror update as words", async () => {
    const { bridge, monday, fake, later } = doorsSetup([issue({ id: "STEP-1", title: "Export", state: "In Progress", labels: ["needs-human"] })])
    await bridge.sync()
    const item = monday.item(/Export/)!
    monday.says(item.id, "900", "Answered by Ada in Slack: ship it. This is done. Nothing needed from you.")
    later(2)
    await bridge.sync()
    expect(fake.calls.filter((c) => c.method === "updateIssue")).toEqual([])
  })

  it("a Look: looks good on Monday approves it and tells its Slack thread", async () => {
    const { bridge, monday, fake, paths, slack, later, texts } = doorsSetup([issue({ id: "STEP-3", title: "Wider buttons", state: "Waiting for UAT", labels: ["polads", "approval/look"] })])
    ownThread(paths, "STEP-3")
    await bridge.sync()
    const item = monday.item(/Wider buttons/)!
    later(1)
    monday.says(item.id, "222", "looks good")
    later(1)
    await bridge.sync()
    expect(fake.issues.get("STEP-3")!.state).toBe("Approved")
    expect(slack().at(-1)).toMatchObject({ kind: "issue", issue: "STEP-3", text: "Ben approved it on Monday. This is done. Nothing needed from you." })
    expect(texts(item.id).filter((t) => t.startsWith("Eve: Done:"))).toEqual([])
  })

  it("a verdict on a change no longer waiting is not an answer here: the note says where it went", async () => {
    const { bridge, monday, fake, paths, slack, later, texts } = doorsSetup([issue({ id: "STEP-3", title: "Wider buttons", state: "Waiting for UAT", labels: ["polads", "approval/look"] })])
    ownThread(paths, "STEP-3")
    await bridge.sync()
    const item = monday.item(/Wider buttons/)!
    later(1)
    // Approved in Slack a moment before Ben said so on Monday.
    fake.issues.set("STEP-3", { ...fake.issues.get("STEP-3")!, state: "Approved" })
    monday.says(item.id, "222", "looks good")
    later(1)
    await bridge.sync()
    expect(slack()).toEqual([])
    expect(texts(item.id).at(-1)).toBe("Eve: Done: STEP-3 was approved. Nothing needed from you.")
  })

  it("never opens a thread just to say what the other door settled: an item with none gets no mirror", async () => {
    const { bridge, monday, fake, slack, later } = doorsSetup([issue({ id: "STEP-3", title: "Wider buttons", state: "Waiting for UAT", labels: ["polads", "approval/look"] })])
    await bridge.sync()
    // It was made this poll: no thread yet, on this mini or another.
    const item = monday.item(/Wider buttons/)!
    const before = slack().length
    later(1)
    monday.says(item.id, "222", "looks good")
    later(1)
    await bridge.sync()
    expect(fake.issues.get("STEP-3")!.state).toBe("Approved")
    expect(slack()).toHaveLength(before)
  })

  it("names where a tried change went when it was settled in Slack", async () => {
    const { bridge, monday, fake, later, texts } = doorsSetup([
      issue({ id: "STEP-4", title: "New checkout", state: "Waiting for UAT", labels: ["polads", "approval/try"] }),
      issue({ id: "STEP-5", title: "Old checkout", state: "Waiting for UAT", labels: ["polads", "approval/try"] }),
    ])
    await bridge.sync()
    const approved = monday.item(/New checkout/)!
    const sentBack = monday.item(/Old checkout/)!
    later(1)
    fake.issues.set("STEP-4", { ...fake.issues.get("STEP-4")!, state: "Approved" })
    fake.issues.set("STEP-5", { ...fake.issues.get("STEP-5")!, state: "Needs Correction" })
    later(1)
    await bridge.sync()
    expect(texts(approved.id).at(-1)).toBe("Eve: Done: STEP-4 was approved. Nothing needed from you.")
    expect(texts(sentBack.id).at(-1)).toBe("Eve: Done: STEP-5 was sent back to be fixed. Nothing needed from you.")
  })

  it("names the answer that counts: a second, different one from Slack is not it", async () => {
    const { bridge, monday, fake, paths, later, texts } = doorsSetup([issue({ id: "STEP-1", title: "Which date", state: "On hold", labels: ["awaiting-answer"] })])
    await bridge.sync()
    const item = monday.item(/Which date/)!
    later(1)
    await recordAnswer({ paths, tracker: fake.tracker }, { issue: "STEP-1", who: "Ben", words: "the publication date", ts: "1790000100.000100", permalink: null, source: "slack", at: at(1), by: "monday:222" }, { since: T0.toISOString() })
    await recordAnswer({ paths, tracker: fake.tracker }, { issue: "STEP-1", who: "Cy", words: "the order date", ts: "1790000110.000100", permalink: null, source: "slack", at: at(1), by: "slack:UCY" }, { since: T0.toISOString() })
    later(1)
    await bridge.sync()
    expect(texts(item.id).at(-1)).toBe("Eve: Answered by Ben in Slack: the publication date. This is done. Nothing needed from you.")
  })

  it("says nothing in Slack's name for an answer given on Monday", async () => {
    const { bridge, monday, fake, paths, later, texts } = doorsSetup([issue({ id: "STEP-1", title: "Which date", state: "On hold", labels: ["awaiting-answer"] })])
    await bridge.sync()
    const item = monday.item(/Which date/)!
    later(1)
    // Recorded from Monday words the bridge had not yet marked as its own (it stopped between the two).
    await recordAnswer({ paths, tracker: fake.tracker }, { issue: "STEP-1", who: "Ada", words: "the order date", ts: "u-1", permalink: null, source: "monday", at: at(1), by: "monday:111" }, { since: T0.toISOString() })
    later(1)
    await bridge.sync()
    expect(texts(item.id).filter((t) => t.startsWith("Eve: Answered by"))).toEqual([])
  })

  it("asked again, names only an answer to the new question", async () => {
    const { bridge, monday, fake, paths, later, texts } = doorsSetup([issue({ id: "STEP-1", title: "Which date", state: "On hold", labels: ["awaiting-answer"] })])
    const again = () => fake.issues.set("STEP-1", { ...fake.issues.get("STEP-1")!, state: "On hold", labels: ["awaiting-answer"] })
    await bridge.sync()
    const item = monday.item(/Which date/)!
    // The first question, answered in Slack.
    later(1)
    await recordAnswer({ paths, tracker: fake.tracker }, { issue: "STEP-1", who: "Ben", words: "the publication date", ts: "1790000100.000100", permalink: null, source: "slack", at: at(1), by: "monday:222" }, { since: T0.toISOString() })
    later(1)
    await bridge.sync()
    // Asked again, and settled with no answer (the agent went on): the old answer is not named again.
    again()
    later(1)
    await bridge.sync()
    later(1)
    fake.issues.set("STEP-1", { ...fake.issues.get("STEP-1")!, state: "In Progress", labels: [] })
    later(1)
    await bridge.sync()
    // Asked a third time and answered on Monday, then a fourth, answered in Slack: that one is named.
    again()
    later(1)
    await bridge.sync()
    later(1)
    monday.says(item.id, "111", "the order date")
    later(1)
    await bridge.sync()
    again()
    later(1)
    await bridge.sync()
    const asked = readRecords(paths)[0].askedAt!
    await recordAnswer({ paths, tracker: fake.tracker }, { issue: "STEP-1", who: "Ben", words: "the delivery date", ts: "1790000200.000100", permalink: null, source: "slack", at: at(20), by: "monday:222" }, { since: asked })
    later(1)
    await bridge.sync()
    expect(texts(item.id).filter((t) => t.startsWith("Eve: Answered by"))).toEqual([
      "Eve: Answered by Ben in Slack: the publication date. This is done. Nothing needed from you.",
      "Eve: Answered by Ben in Slack: the delivery date. This is done. Nothing needed from you.",
    ])
  })
})
