import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths } from "../../config.ts"
import { listNew } from "../../fsq.ts"
import { mondayOutbox } from "../../monday/store.ts"
import { fileTestDayCommand, heardOnce, pendingCommands, tellDoor } from "../commands.ts"
import { archiveRun, isTestDayKey, openDecisionFor, readRun, saveRun, testDayKey } from "../store.ts"
import { FAILED_WAITING, run, T0 } from "./fixtures.ts"

const paths = () => agentPaths(mkdtempSync(join(tmpdir(), "agentd-testday-")))

describe("test-day commands and state (Wave 3)", () => {
  it("files one command per key, for agentd", () => {
    const p = paths()
    const c = { key: "testday:msg:CQ:1.1", verb: "start" as const, who: "Ada", whoId: "UADA", whoKey: "monday:111", via: "slack" as const, door: { kind: "slack" as const, channel: "CQ", threadTs: "1.1", ts: "1.1" } }
    expect(fileTestDayCommand(p, c, T0)).toBe(true)
    expect(fileTestDayCommand(p, c, T0)).toBe(false)
    expect(pendingCommands(p).map((e) => e.payload.verb)).toEqual(["start"])
    expect(listNew(p.inbox)[0].payload).toMatchObject({ type: "testday", receivedAt: T0.toISOString(), whoKey: "monday:111" })
  })

  it("lists only test-day commands, never the front door's messages beside them", () => {
    const p = paths()
    fileTestDayCommand(p, { key: "testday:a", verb: "release", who: "Ada", whoId: "111", whoKey: "monday:111", via: "monday", door: { kind: "none" } }, T0)
    expect(pendingCommands(p)).toHaveLength(1)
    expect(pendingCommands(agentPaths(mkdtempSync(join(tmpdir(), "agentd-testday-"))))).toEqual([])
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
