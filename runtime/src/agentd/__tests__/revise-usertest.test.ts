import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listJobs, readWatchedPrs, recordPr, type WatchedPr } from "../../jobs.ts"
import { fakeExec, fakeTracker, issue } from "../../__tests__/fakes.ts"
import { saveUserTestState, type UserTestState } from "../../usertest/state.ts"
import { planRevision, reviseOwnPr, type OwnPrView } from "../revise.ts"

const URL = "https://github.com/example/repo/pull/7"
const pr: WatchedPr = { issue: "STEP-7", url: URL, openedAt: "2026-09-25T10:00:00.000Z" }
const view: OwnPrView = { url: URL, number: 7, state: "OPEN", headRefName: "STEP-7-x", headRefOid: "h1", author: { login: "agent-bot" }, statusCheckRollup: [] }
const ctx = { mini: "eve", required: [], infra: {} }
const found = (head: string, over: Partial<UserTestState> = {}): UserTestState => ({ issue: "STEP-7", url: URL, head, verdict: "findings", findings: ["major: X (/en)"], at: "2026-09-25T10:30:00.000Z", ...over })

afterEach(() => {
  delete process.env.AGENTD_HOME
})

describe("planRevision with the browser test's findings (WS5)", () => {
  it("sends this head's findings back once", () => {
    expect(planRevision(view, pr, { ...ctx, usertest: found("h1") })).toEqual({ kind: "revise", handled: ["usertest:h1"], reasons: ["the browser test found problems"] })
    expect(planRevision(view, { ...pr, revise: { rounds: 1, handled: ["usertest:h1"] } }, { ...ctx, usertest: found("h1") })).toEqual({ kind: "none" })
  })

  it("never sends back findings at another head, a pass, or none", () => {
    expect(planRevision(view, pr, { ...ctx, usertest: found("h0") })).toEqual({ kind: "none" })
    expect(planRevision(view, pr, { ...ctx, usertest: found("h1", { verdict: "pass", findings: [] }) })).toEqual({ kind: "none" })
    expect(planRevision(view, pr, { ...ctx, usertest: null })).toEqual({ kind: "none" })
  })
})

describe("reviseOwnPr with the browser test's findings (WS5)", () => {
  it("hands the findings to the revise job it queues", async () => {
    process.env.AGENTD_HOME = mkdtempSync(join(tmpdir(), "agentd-ut-revise-"))
    const paths = agentPaths()
    const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/repo" }, pluginRoot: "/plugin", slack: { allowedUsers: ["U0EXAMPLE"] } })
    recordPr(paths, pr)
    saveUserTestState(paths, found("h1"))
    const deps = { exec: fakeExec().exec, paths, config, now: () => new Date("2026-09-25T11:00:00Z"), log: { info: () => {}, warn: () => {}, error: () => {} }, tracker: fakeTracker([issue({ id: "STEP-7" })]).tracker }
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], view, [])
    expect(listJobs(paths, "pending")[0]).toMatchObject({ kind: "revise", revise: { reasons: ["the browser test found problems"], usertestFindings: ["major: X (/en)"] } })
    expect(readWatchedPrs(paths)[0].revise?.handled).toEqual(["usertest:h1"])
  })
})
