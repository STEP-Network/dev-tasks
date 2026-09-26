import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew, putOnce } from "../../fsq.ts"
import { mondayOutbox } from "../../monday/store.ts"
import { actedAt, fileTestDayCommand, heardOnce, pendingCommands, slackName, slackTime, tellDoor } from "../commands.ts"
import { archiveRun, isTestDayKey, openDecisionFor, readRun, saveRun, testDayKey } from "../store.ts"
import { FAILED_WAITING, run, T0 } from "./fixtures.ts"

const paths = () => agentPaths(mkdtempSync(join(tmpdir(), "agentd-testday-")))

describe("test-day commands and state (Wave 3)", () => {
  it("files one command per key, for agentd", () => {
    const p = paths()
    const c = {
      key: "testday:msg:CQ:1.1", verb: "start" as const, who: "Ada", whoId: "UADA", whoKey: "monday:111", via: "slack" as const,
      door: { kind: "slack" as const, channel: "CQ", threadTs: "1.1", ts: "1.1" }, at: T0.toISOString(),
    }
    expect(fileTestDayCommand(p, c, T0)).toBe(true)
    expect(fileTestDayCommand(p, c, T0)).toBe(false)
    expect(pendingCommands(p).map((e) => e.payload.verb)).toEqual(["start"])
    expect(listNew(p.inbox)[0].payload).toMatchObject({ type: "testday", receivedAt: T0.toISOString(), whoKey: "monday:111" })
  })

  it("lists only test-day commands, never the front door's messages beside them", () => {
    const p = paths()
    fileTestDayCommand(p, { key: "testday:a", verb: "release", who: "Ada", whoId: "111", whoKey: "monday:111", via: "monday", door: { kind: "none" }, at: T0.toISOString() }, T0)
    putOnce(p.inbox, "msg:CQ:9.9", { type: "reply", receivedAt: T0.toISOString() })
    expect(pendingCommands(p).map((e) => e.payload.key)).toEqual(["testday:a"])
    expect(pendingCommands(agentPaths(mkdtempSync(join(tmpdir(), "agentd-testday-"))))).toEqual([])
  })

  it("lists commands by when the person acted, whichever door, and by key at the same moment", () => {
    const p = paths()
    const base = { who: "Ada", whoId: "111", whoKey: "monday:111", door: { kind: "none" as const } }
    // File names would order these testday:log < testday:monday < testday:msg.
    fileTestDayCommand(p, { ...base, key: "testday:monday:u9", verb: "cancel", via: "monday", at: "2026-10-02T08:03:00.000Z" }, T0)
    fileTestDayCommand(p, { ...base, key: "testday:log:1", verb: "release", via: "monday", at: "2026-10-02T08:02:00.000Z" }, T0)
    // At the same moment, by key: file names sort these two the other way (testday_a before testday_x).
    fileTestDayCommand(p, { ...base, key: "testday_a", verb: "start", via: "slack", at: "2026-10-02T08:01:00.000Z" }, T0)
    fileTestDayCommand(p, { ...base, key: "testday:x", verb: "start", via: "slack", at: "2026-10-02T08:01:00.000Z" }, T0)
    expect(pendingCommands(p).map((e) => e.payload.key)).toEqual(["testday:x", "testday_a", "testday:log:1", "testday:monday:u9"])
  })

  it("lists a command filed without when the person acted after every other, and does not crash", () => {
    const p = paths()
    const base = { who: "Ada", whoId: "111", whoKey: "monday:111", via: "slack" as const, door: { kind: "none" as const } }
    // Its key sorts first, and it was filed first: it still goes last.
    putOnce(p.inbox, "testday:a-old", { ...base, key: "testday:a-old", verb: "start", type: "testday", receivedAt: "2026-10-02T07:00:00.000Z" })
    fileTestDayCommand(p, { ...base, key: "testday:z-new", verb: "cancel", at: "2026-10-02T09:00:00.000Z" }, T0)
    expect(pendingCommands(p).map((e) => e.payload.key)).toEqual(["testday:z-new", "testday:a-old"])
  })

  it("reads when a person acted, from a Slack ts or a Monday time, as full ISO", () => {
    expect(slackTime("1790000000.000100")).toBe("2026-09-21T14:13:20.000Z")
    expect(actedAt("2026-10-02T08:00:00Z", T0)).toBe("2026-10-02T08:00:00.000Z")
    expect(actedAt("not a time", T0)).toBe(T0.toISOString())
    expect(actedAt(null, T0)).toBe(T0.toISOString())
  })

  it("names a Slack person from config, without asking Slack", () => {
    const config = ConfigSchema.parse({
      mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UADA"] },
      bridges: { monday: { people: [{ id: "111", name: "Ada", slackId: "UADA" }], defaultPerson: "111" } },
    })
    expect(slackName(config, "UADA")).toBe("Ada")
    expect(slackName(config, "UBEN")).toBe("UBEN")
  })

  it("hears a message once, however many copies Slack sends", () => {
    const p = paths()
    expect(heardOnce(p, "msg:CQ:2000.1")).toBe(true)
    expect(heardOnce(p, "msg:CQ:2000.1")).toBe(false)
    expect(heardOnce(p, "msg:CQ:2000.2")).toBe(true)
  })

  it("answers at the door the command came from", () => {
    const p = paths()
    tellDoor(p, { kind: "slack", channel: "CQ", threadTs: "1.1", ts: "1.2" }, "Started.", T0)
    tellDoor(p, { kind: "monday", itemId: "4000", updateId: "u1", threadId: "u0" }, "Started.", T0)
    tellDoor(p, { kind: "none" }, "Nobody hears this.", T0)
    expect(listNew(p.outbox).map((e) => e.payload)).toEqual([expect.objectContaining({ kind: "reply", channelId: "CQ", threadTs: "1.1", text: "Started." })])
    expect(listNew(mondayOutbox(p)).map((e) => e.payload)).toEqual([expect.objectContaining({ itemId: "4000", threadId: "u0", like: "u1", text: "Started." })])
  })

  it("keys a test day and knows its keys", () => {
    expect(testDayKey("2026-10-02")).toBe("testday-2026-10-02")
    expect(isTestDayKey("testday-2026-10-02")).toBe(true)
    expect(isTestDayKey("testday-2026-10-02-2")).toBe(true)
    expect(isTestDayKey("STEP-7")).toBe(false)
    expect(isTestDayKey("testday-item")).toBe(false)
    expect(isTestDayKey("xtestday-2026-10-02")).toBe(false)
  })

  it("finds the open decision for an issue in the current run, and none once it is answered or archived", () => {
    const p = paths()
    expect(openDecisionFor(p, "STEP-7")).toBeNull()
    saveRun(p, run({ checkpoints: [FAILED_WAITING] }))
    expect(openDecisionFor(p, "STEP-7")?.n).toBe(4)
    expect(openDecisionFor(p, "STEP-8")).toBeNull()
    expect(readRun(p)?.id).toBe("2026-10-02")
    saveRun(p, run({ checkpoints: [{ ...FAILED_WAITING, decision: { ...FAILED_WAITING.decision, answer: "fix", by: "Ada" } }] }))
    expect(openDecisionFor(p, "STEP-7")).toBeNull()
    saveRun(p, run({ checkpoints: [FAILED_WAITING] }))
    archiveRun(p, readRun(p)!)
    expect(readRun(p)).toBeNull()
    expect(openDecisionFor(p, "STEP-7")).toBeNull()
  })
})
