/**
 * A person's Class change on their request (Wave 2, D1): acted on once,
 * through the answer recorder's own Linear account when it lowers, and never
 * replayed over a raise made since. Made-up people (Ada, Ben) and ids.
 */
import { describe, expect, it } from "vitest"
import { issue } from "../../__tests__/fakes.ts"
import { listNew } from "../../fsq.ts"
import type { InstructionEntry } from "../../slack/instruction.ts"
import { readRecords, saveRecord } from "../store.ts"
import { BOARD, doorsSetup, NEEDS_COLUMNS, REQ, T0 } from "./fake-monday.ts"

const LABELS = { issueLabels: { nodes: ["auto", "look", "try"].map((c) => ({ id: `l-${c}`, name: `approval/${c}`, team: { key: "STEP" } })) } }

function setup(seed = [issue({ id: "STEP-10", uuid: "u10", state: "In Progress", labels: ["approval/try"] })], withKey = true) {
  const sent: Array<{ query: string; vars: Record<string, any> }> = []
  const linear = { down: false }
  const recorder = async <T,>(query: string, vars: Record<string, unknown> = {}): Promise<T> => {
    if (linear.down) throw new Error("Linear: gave up after 3 attempts (status 503)")
    sent.push({ query, vars: vars as Record<string, any> })
    return (query.includes("issueLabels") ? LABELS : { issueUpdate: { success: true }, commentCreate: { success: true } }) as T
  }
  const s = doorsSetup(seed, { requests: true, recorder: withKey ? recorder : null })
  const lowered = () => sent.filter((q) => q.query.includes("issueUpdate")).map((q) => q.vars.input.addedLabelIds)
  return { ...s, sent, linear, lowered }
}

/** A request item on the Requests board, linked, with its record. */
function requestRecord(s: ReturnType<typeof setup>, id: string): string {
  const itemId = s.monday.request("111", `Request for ${id}`, undefined, "r_active", REQ)
  saveRecord(s.paths, { key: `request-${itemId}`, kind: "request", issue: id, itemId, state: "Waiting on agent", bodyHash: null, createdAt: T0.toISOString(), doneAt: null, handled: [], linked: true })
  return itemId
}

/** A person setting the Class column: the value, and the activity log's line. */
async function setClass(s: ReturnType<typeof setup>, itemId: string, userId: string, label: string): Promise<void> {
  await s.monday.api.setColumns(REQ, itemId, { r_class: { label } })
  s.monday.answers(itemId, userId, label, "r_class")
}

describe("a person's Class change on their request (D1)", () => {
  it("lowers it through the recorder, says so on the item, and announces it in #polads-agents", async () => {
    const s = setup()
    const itemId = requestRecord(s, "STEP-10")
    await s.bridge.sync()
    await setClass(s, itemId, "111", "Look")
    s.later(1)
    await s.bridge.sync()
    expect(s.lowered()).toEqual([["l-look"]])
    expect(s.sent.find((q) => q.query.includes("commentCreate"))?.vars.input.body).toBe(`Class lowered from Try to Look by Ada on Monday, as they asked (https://step.monday.com/boards/${REQ}/pulses/${itemId}).`)
    expect(s.texts(itemId).at(-1)).toBe("Eve: Done: STEP-10 is now Look, as Ada asked. Nothing needed from you.")
    expect(s.slack().filter((m) => m.kind === "post")).toEqual([
      expect.objectContaining({ channel: "agents", text: `STEP-10 was lowered from Try to Look by Ada on Monday (https://step.monday.com/boards/${REQ}/pulses/${itemId}). If Ada did not do this, raise it back in Linear.` }),
    ])
  })

  it("a replayed change after a raise does nothing (review, 2026-09-25)", async () => {
    const s = setup()
    const itemId = requestRecord(s, "STEP-10")
    await s.bridge.sync()
    await setClass(s, itemId, "111", "Look")
    s.later(1)
    await s.bridge.sync()
    // The diff floor raises it back to Try in between (Wave 1's check, as the agent). The next read reaches
    // five minutes back, so the log still holds Ada's change.
    s.fake.issues.set("STEP-10", { ...s.fake.issues.get("STEP-10")!, labels: ["approval/try"] })
    s.later(2)
    await s.bridge.sync()
    expect(s.lowered()).toHaveLength(1)
    expect(s.fake.issues.get("STEP-10")!.labels).toContain("approval/try")
  })

  it("acts only on the newest of several changes in one read, and never on one older than the last it acted on", async () => {
    const s = setup()
    const itemId = requestRecord(s, "STEP-10")
    await s.bridge.sync()
    await setClass(s, itemId, "222", "Auto")
    s.later(1)
    await setClass(s, itemId, "111", "Look")
    s.later(1)
    await s.bridge.sync()
    expect(s.lowered()).toEqual([["l-look"]])
    expect(s.texts(itemId).at(-1)).toBe("Eve: Done: STEP-10 is now Look, as Ada asked. Nothing needed from you.")
    // A change the log shows late, from before the one acted on, is not acted on.
    const [rec] = readRecords(s.paths)
    expect(rec.classAt).toBe(new Date(T0.getTime() + 60_000).toISOString())
    s.monday.answers(itemId, "222", "Auto", "r_class")
    const late = s.monday.calls.length
    saveRecord(s.paths, { ...rec, classAt: new Date(T0.getTime() + 10 * 60_000).toISOString() })
    s.later(1)
    await s.bridge.sync()
    expect(s.lowered()).toHaveLength(1)
    expect(s.monday.calls.slice(late).filter((c) => c.method === "postUpdate")).toEqual([])
  })

  it("never reads the bridge's own Class write, or someone not on the list, as a person's", async () => {
    const s = setup()
    const itemId = requestRecord(s, "STEP-10")
    await s.bridge.sync()
    s.monday.answers(itemId, "900", "Look", "r_class")
    s.monday.answers(itemId, "333", "Auto", "r_class")
    s.later(1)
    await s.bridge.sync()
    expect(s.sent).toEqual([])
    expect(s.slack().filter((m) => m.kind === "post")).toEqual([])
    // Left alone, not tripped over.
    expect(s.warned.filter((w) => /class/.test(w))).toEqual([])
  })

  it("never acts on a change whose time it cannot read, and it holds no later change back (review)", async () => {
    const s = setup()
    const itemId = requestRecord(s, "STEP-10")
    await s.bridge.sync()
    // Kept as Monday wrote it (client.ts logTime): as a string it sorts after every real time.
    s.monday.answers(itemId, "111", "Auto", "r_class", "garbage")
    s.later(1)
    await s.bridge.sync()
    expect(s.sent).toEqual([])
    expect(readRecords(s.paths)[0].classAt).toBeUndefined()
    await setClass(s, itemId, "111", "Look")
    s.later(1)
    await s.bridge.sync()
    expect(s.lowered()).toEqual([["l-look"]])
  })

  it("hears a change the log shows late, from before its last read", async () => {
    const s = setup()
    const itemId = requestRecord(s, "STEP-10")
    await s.bridge.sync()
    s.monday.at(new Date(T0.getTime() - 60_000))
    await setClass(s, itemId, "111", "Look")
    s.later(1)
    await s.bridge.sync()
    expect(s.lowered()).toEqual([["l-look"]])
  })

  it("raises through the agent's own tracker, and announces nothing", async () => {
    const s = setup([issue({ id: "STEP-10", uuid: "u10", state: "In Progress", labels: ["approval/look"] })])
    const itemId = requestRecord(s, "STEP-10")
    await s.bridge.sync()
    await setClass(s, itemId, "111", "Try")
    s.later(1)
    await s.bridge.sync()
    expect(s.sent).toEqual([])
    expect(s.fake.issues.get("STEP-10")!.labels).toEqual(["approval/try"])
    expect(s.texts(itemId).at(-1)).toBe("Eve: Done: STEP-10 is now Try, as Ada asked. Nothing needed from you.")
    expect(s.slack().filter((m) => m.kind === "post")).toEqual([])
  })

  it("without the recorder's key, says to lower it in Linear, and puts Linear's class back in the column", async () => {
    const s = setup(undefined, false)
    const itemId = requestRecord(s, "STEP-10")
    await s.bridge.sync()
    await setClass(s, itemId, "111", "Look")
    s.later(1)
    await s.bridge.sync()
    expect(s.texts(itemId).at(-1)).toBe(
      "Eve: Only a person can lower the approval level, and I cannot do it for you here yet. You can do it in Linear: open STEP-10 and set the label approval/look.",
    )
    expect(s.monday.items.get(itemId)!.columns.r_class?.text).toBe("Try")
    expect(s.slack().filter((m) => m.kind === "post")).toEqual([])
    // Said once: the next read still holds the change, and it is handled.
    const said = s.texts(itemId).length
    s.later(1)
    await s.bridge.sync()
    expect(s.texts(itemId)).toHaveLength(said)
  })

  it("keeps a change Linear could not take until it can, however long the log has moved on", async () => {
    const s = setup()
    const itemId = requestRecord(s, "STEP-10")
    await s.bridge.sync()
    await setClass(s, itemId, "111", "Look")
    s.linear.down = true
    s.later(1)
    await s.bridge.sync()
    s.later(20)
    await s.bridge.sync()
    s.later(20)
    await s.bridge.sync()
    expect(s.sent).toEqual([])
    s.linear.down = false
    s.later(20)
    await s.bridge.sync()
    expect(s.lowered()).toEqual([["l-look"]])
    expect(readRecords(s.paths)[0].classRetry).toBeUndefined()
    s.later(20)
    await s.bridge.sync()
    expect(s.lowered()).toHaveLength(1)
  })

  it("drops a kept change once the person clears the column after it", async () => {
    const s = setup()
    const itemId = requestRecord(s, "STEP-10")
    await s.bridge.sync()
    await setClass(s, itemId, "111", "Look")
    s.linear.down = true
    s.later(1)
    await s.bridge.sync()
    expect(readRecords(s.paths)[0].classRetry).toMatchObject({ text: "Look" })
    s.monday.answers(itemId, "111", "", "r_class")
    s.linear.down = false
    s.later(1)
    await s.bridge.sync()
    s.later(20)
    await s.bridge.sync()
    expect(s.sent).toEqual([])
    expect(readRecords(s.paths)[0].classRetry).toBeUndefined()
  })
})

describe("\"make it look\" on a Monday item (D1)", () => {
  it("goes to agentd from a request's update, and from a Needs-you item without moving its State", async () => {
    const s = setup([issue({ id: "STEP-10", uuid: "u10", state: "In Progress", labels: ["approval/try"] }), issue({ id: "STEP-7", state: "In Progress", labels: ["needs-human", "approval/try"] })])
    const itemId = requestRecord(s, "STEP-10")
    await s.bridge.sync()
    const needs = [...s.monday.items.values()].find((i) => s.monday.boardOf(i.id) === BOARD)!
    s.monday.says(itemId, "111", "make it look")
    s.monday.says(needs.id, "222", "Make it auto.")
    s.later(1)
    await s.bridge.sync()
    const filed = listNew<InstructionEntry>(s.paths.inbox).map((e) => [e.payload.issue, e.payload.actions, e.payload.userName])
    expect(filed).toEqual(expect.arrayContaining([["STEP-10", ["class-look"], "Ada"], ["STEP-7", ["class-auto"], "Ben"]]))
    expect(s.monday.items.get(needs.id)!.columns[NEEDS_COLUMNS.state]?.text).toBe("Needs you")
    // agentd answers them (agentd/instructions.ts): the bridge says nothing of its own.
    expect(s.texts(itemId).filter((t) => t.startsWith("Eve:"))).toEqual([])
    // The bridge itself changed nothing in Linear.
    expect(s.sent).toEqual([])
  })
})
