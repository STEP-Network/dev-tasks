/**
 * The Requests board (spec 4 and 6): a person's new item filed as a Triage
 * issue, and each request's Stage, Progress, columns and group kept in step
 * with its anchor issue and the anchor's tasks. Made-up people and ids.
 */
import { describe, expect, it } from "vitest"
import { issue } from "../../__tests__/fakes.ts"
import { readRecords, saveRecord } from "../store.ts"
import { BOARD, doorsSetup, REQ, T0, THREAD } from "./fake-monday.ts"

type Opts = Parameters<typeof doorsSetup>[1]
const setup = (seed: Parameters<typeof doorsSetup>[0] = [], opts: Opts = {}) => doorsSetup(seed, { ...opts, requests: true })

/** A request item on the Requests board, as fromBoard leaves one: filed, its record saved, linked unless told otherwise. */
function requestRecord(monday: ReturnType<typeof setup>["monday"], id: string, paths: ReturnType<typeof setup>["paths"], linked = true): string {
  const itemId = monday.request("111", `Request for ${id}`, undefined, "r_active", REQ)
  saveRecord(paths, { key: `request-${itemId}`, kind: "request", issue: id, itemId, state: "Waiting on agent", bodyHash: null, createdAt: T0.toISOString(), doneAt: null, handled: [], linked })
  return itemId
}

describe("the Requests board (spec 4 and 6)", () => {
  it("files a person's new item on the Requests board as a Triage issue, and writes its Linear link, Requester and Stage", async () => {
    const { bridge, monday, fake, paths } = setup()
    const itemId = monday.request("111", "Export notices as CSV", "For the yearly audit", "r_active", REQ)
    await bridge.sync()
    const filed = [...fake.issues.values()].find((i) => i.labels.includes("intake/monday"))!
    expect(filed).toMatchObject({ title: "Export notices as CSV", state: "Triage" })
    expect(monday.items.get(itemId)!.columns).toMatchObject({ r_linear: { text: filed.id }, r_stage: { text: "New" }, r_person: expect.anything() })
    expect(monday.items.get(itemId)!.groupId).toBe("r_active")
  })

  it("brings a request up to date from its anchor and tasks: stage, progress, class, size, week, links and group", async () => {
    // STEP-10 is the anchor with two tasks in a project; its Slack thread is on the issue.
    const { bridge, monday, paths, fake } = setup(
      [issue({ id: "STEP-10", title: "Translations", state: "In Progress", labels: ["approval/auto", "feature"] }), issue({ id: "STEP-11", state: "Released" }), issue({ id: "STEP-12", state: "In Progress" })],
      { parents: { "STEP-11": "STEP-10", "STEP-12": "STEP-10" }, extra: { "STEP-10": { project: { id: "p1", name: "Translations", url: "https://linear.app/step/project/translations", targetDate: "2026-10-30" }, slackThread: THREAD } } },
    )
    const itemId = requestRecord(monday, "STEP-10", paths)
    await bridge.sync()
    expect(monday.items.get(itemId)!.columns).toMatchObject({
      r_stage: { text: "Building" }, r_progress: { text: "1 of 2 done" }, r_class: { text: "Auto" }, r_size: { text: "Project" }, r_type: { text: "Feature" },
      r_linear: { text: "Translations" }, r_thread: { text: "Slack thread" },
    })
    expect(JSON.parse(monday.items.get(itemId)!.columns.r_week!.value!)).toEqual({ week: { startDate: "2026-10-26", endDate: "2026-11-01" } })
    // A task is still open: the anchor is not marked Released.
    expect(fake.issues.get("STEP-10")!.state).toBe("In Progress")
  })

  it("sizes a request with tasks and no project as a Task, and takes its week from the anchor's due date", async () => {
    const { bridge, monday, paths } = setup([issue({ id: "STEP-10", state: "In Progress" }), issue({ id: "STEP-11", state: "In Progress" })], {
      parents: { "STEP-11": "STEP-10" },
      extra: { "STEP-10": { dueDate: "2026-10-07" } },
    })
    const itemId = requestRecord(monday, "STEP-10", paths)
    await bridge.sync()
    expect(monday.items.get(itemId)!.columns.r_size?.text).toBe("Task")
    expect(JSON.parse(monday.items.get(itemId)!.columns.r_week!.value!)).toEqual({ week: { startDate: "2026-10-05", endDate: "2026-10-11" } })
  })

  it("says a released Question was answered", async () => {
    const { bridge, monday, paths } = setup([issue({ id: "STEP-10", state: "Released", labels: ["question"] })])
    const itemId = requestRecord(monday, "STEP-10", paths)
    await bridge.sync()
    expect(monday.items.get(itemId)!.columns).toMatchObject({ r_type: { text: "Question" }, r_progress: { text: "Answered" }, r_stage: { text: "Released" } })
  })

  it("links a request that was filed but stopped before its link was written", async () => {
    const { bridge, monday, paths, texts } = setup([issue({ id: "STEP-10", state: "Triage" })])
    const itemId = requestRecord(monday, "STEP-10", paths, false)
    await bridge.sync()
    expect(monday.items.get(itemId)!.columns).toMatchObject({ r_person: expect.anything(), r_linear: { text: "STEP-10" } })
    expect(texts(itemId)).toEqual(["Eve: Thanks, Ada. I filed this for the agents as STEP-10. Its Stage shows how far it has come. Nothing needed from you."])
    expect(readRecords(paths)[0].linked).toBe(true)
  })

  it("writes a column again only when Linear changes it, so a person's own edit stands", async () => {
    const { bridge, monday, later, paths } = setup([issue({ id: "STEP-10", state: "In Progress", labels: ["approval/look"] })])
    const itemId = requestRecord(monday, "STEP-10", paths)
    await bridge.sync()
    await monday.api.setColumns(REQ, itemId, { r_class: { label: "Try" } })
    later(2)
    await bridge.sync()
    expect(monday.items.get(itemId)!.columns.r_class!.text).toBe("Try")
  })

  it("says each stage change once, on the item and in the request's Slack thread", async () => {
    const { bridge, monday, fake, slack, later, texts, paths } = setup([issue({ id: "STEP-10", state: "Refining" })], { extra: { "STEP-10": { slackThread: THREAD } } })
    const itemId = requestRecord(monday, "STEP-10", paths)
    await bridge.sync()
    fake.issues.set("STEP-10", { ...fake.issues.get("STEP-10")!, state: "Ready" })
    later(2)
    await bridge.sync()
    later(2)
    await bridge.sync()
    expect(texts(itemId).filter((t) => t.includes("Building"))).toEqual(["Eve: STEP-10: Building (0 of 1 done). Nothing needed from you."])
    expect(slack().filter((m) => m.kind === "reply" && m.text.includes("Building"))).toHaveLength(1)
  })

  it("marks the anchor Released when every task is, moves the request to Released, and archives it 30 days on", async () => {
    const { bridge, monday, fake, later, paths } = setup([issue({ id: "STEP-10", state: "In Progress" }), issue({ id: "STEP-11", state: "Released" })], { parents: { "STEP-11": "STEP-10" } })
    const itemId = requestRecord(monday, "STEP-10", paths)
    await bridge.sync()
    expect(fake.issues.get("STEP-10")!.state).toBe("Released")
    expect(monday.items.get(itemId)!.groupId).toBe("r_released")
    later(29 * 24 * 60)
    await bridge.sync()
    expect(monday.items.has(itemId)).toBe(true)
    later(2 * 24 * 60)
    await bridge.sync()
    expect(monday.items.has(itemId)).toBe(false)
  })

  it("hears a person's words on a request item and adds them to the anchor issue", async () => {
    const { bridge, monday, fake, later, paths } = setup([issue({ id: "STEP-10", state: "Refining" })])
    const itemId = requestRecord(monday, "STEP-10", paths)
    await bridge.sync()
    monday.says(itemId, "222", "Only for admins, please")
    later(2)
    await bridge.sync()
    expect(fake.issues.get("STEP-10")!.description).toContain("Only for admins, please")
  })

  it("reads both boards each poll, and polls no faster than two reads a poll allow", async () => {
    const { bridge, monday, paths } = setup([], { dailyLimit: 1000 })
    await bridge.sync()
    expect(monday.called("readBoard").map(([board]) => board)).toEqual([BOARD, REQ])
    expect(bridge.pollEveryMs()).toBe(15 * 60_000)
  })

  it("files only a configured person's new item in Active", async () => {
    const { bridge, monday, fake } = setup()
    monday.request("333", "From someone not on the list", undefined, "r_active", REQ)
    monday.request("111", "Moved straight to Released", undefined, "r_released", REQ)
    await bridge.sync()
    expect([...fake.issues.values()]).toEqual([])
  })

  it("puts a declined request, and one on hold, in Declined and on hold, and archives only the declined one", async () => {
    const { bridge, monday, paths, later } = setup([issue({ id: "STEP-10", state: "Canceled" }), issue({ id: "STEP-20", state: "On hold" })])
    const declined = requestRecord(monday, "STEP-10", paths)
    const held = requestRecord(monday, "STEP-20", paths)
    await bridge.sync()
    expect([monday.items.get(declined)!.groupId, monday.items.get(held)!.groupId]).toEqual(["r_closed", "r_closed"])
    expect(monday.items.get(declined)!.columns.r_stage?.text).toBe("Declined")
    later(31 * 24 * 60)
    await bridge.sync()
    expect([monday.items.has(declined), monday.items.has(held)]).toEqual([false, true])
  })

  it("keeps the Needs-you board going when the Requests board cannot be read", async () => {
    const { bridge, monday } = setup([issue({ id: "STEP-1", title: "Which date", state: "On hold", labels: ["awaiting-answer"] })], { requestsBoardMissing: true })
    await bridge.sync()
    expect(monday.item(/Which date/)).toBeDefined()
  })

  it("needs no Requests or Agents working on group on the Needs-you board once requests have their own board", async () => {
    const { bridge, monday } = setup([issue({ id: "STEP-1", title: "Which date", state: "On hold", labels: ["awaiting-answer"] })])
    await bridge.sync()
    expect(monday.item(/Which date/)!.groupId).toBe("g_needs")
  })

  it("files nothing from the Needs-you board's old Requests group once requests have their own board", async () => {
    const { bridge, monday, fake } = setup([], { keepOldGroups: true })
    monday.request("111", "Old place", undefined, "g_req", BOARD)
    await bridge.sync()
    expect([...fake.issues.values()]).toEqual([])
  })

  it("leaves a request still on the Needs-you board to the migration (Task 11): the old flow no longer runs", async () => {
    const { bridge, monday, paths } = setup([issue({ id: "STEP-5", state: "Released" })], { keepOldGroups: true })
    const old = monday.request("111", "Old request", undefined, "g_work", BOARD)
    saveRecord(paths, { key: `request-${old}`, kind: "request", issue: "STEP-5", itemId: old, state: "Waiting on agent", bodyHash: null, createdAt: T0.toISOString(), doneAt: null, handled: [], linked: true })
    await bridge.sync()
    expect(monday.items.get(old)!.groupId).toBe("g_work")
    expect(monday.writes().filter((c) => (c.args as unknown[]).includes(old))).toEqual([])
  })

  it("says a stage change only when there was one before: a new record says nothing the first time", async () => {
    const { bridge, monday, paths, texts } = setup([issue({ id: "STEP-10", state: "Ready" })])
    const itemId = requestRecord(monday, "STEP-10", paths)
    await bridge.sync()
    expect(texts(itemId)).toEqual([])
    expect(readRecords(paths).find((r) => r.itemId === itemId)!.stage).toBe("Building")
  })
})
