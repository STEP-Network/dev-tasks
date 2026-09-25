import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { jobPath, listJobs, readWatchedPrs, recordPr, type WatchedPr } from "../../jobs.ts"
import { fakeExec, fakeTracker, issue } from "../../__tests__/fakes.ts"
import { listNew } from "../../fsq.ts"
import { openDecisions } from "../decisions.ts"
import { saveUserTestState } from "../../usertest/state.ts"
import { conflictWith, MAX_CONFLICT_ROUNDS, MAX_REVISE_ROUNDS, planRevision, PR_FIELDS, reviseOwnPr, type OwnPrView } from "../revise.ts"

const URL = "https://github.com/example/repo/pull/7"
const pr: WatchedPr = { issue: "STEP-7", url: URL, openedAt: "2026-09-25T10:00:00.000Z" }
const clean: OwnPrView = {
  url: URL, number: 7, state: "OPEN", headRefName: "STEP-7-x", headRefOid: "h1", baseRefName: "staging",
  mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", author: { login: "agent-bot" }, statusCheckRollup: [],
}
const clashing: OwnPrView = { ...clean, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }
const ctx = { mini: "eve", required: ["Test"], infra: {}, base: "staging" }
const CONFLICT = "merge conflict with staging"
const redTest = [{ name: "Test", conclusion: "FAILURE", detailsUrl: "https://github.com/x/actions/runs/1/job/2" }]

afterEach(() => {
  delete process.env.AGENTD_HOME
})

describe("planRevision for a PR that clashes with its base (STEP-3340)", () => {
  it("asks gh for what it reads", () => {
    for (const field of ["mergeable", "mergeStateStatus", "baseRefName"]) expect(PR_FIELDS.split(",")).toContain(field)
  })

  it("sends a conflicting PR back once, keyed by its head", () => {
    expect(planRevision(clashing, pr, ctx)).toEqual({ kind: "revise", handled: ["conflict:h1"], reasons: [CONFLICT] })
    expect(planRevision(clashing, { ...pr, revise: { rounds: 0, handled: ["conflict:h1"], conflictRounds: 1 } }, ctx)).toEqual({ kind: "none" })
    // A new head that still clashes is new work.
    expect(planRevision({ ...clashing, headRefOid: "h2" }, { ...pr, revise: { rounds: 0, handled: ["conflict:h1"], conflictRounds: 1 } }, ctx)).toEqual({
      kind: "revise", handled: ["conflict:h2"], reasons: [CONFLICT],
    })
  })

  it("reads either of GitHub's two words for it", () => {
    expect(planRevision({ ...clean, mergeable: "CONFLICTING", mergeStateStatus: undefined }, pr, ctx)).toMatchObject({ kind: "revise", reasons: [CONFLICT] })
    expect(planRevision({ ...clean, mergeable: undefined, mergeStateStatus: "DIRTY" }, pr, ctx)).toMatchObject({ kind: "revise", reasons: [CONFLICT] })
  })

  it("waits while GitHub is still working it out, and queues nothing for a clean PR", () => {
    expect(planRevision({ ...clean, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, pr, ctx)).toEqual({ kind: "none" })
    expect(planRevision(clean, pr, ctx)).toEqual({ kind: "none" })
    expect(planRevision({ ...clean, mergeable: undefined, mergeStateStatus: undefined }, pr, ctx)).toEqual({ kind: "none" })
  })

  it("leaves a PR against another base to a person: the worker has only the mini's base", () => {
    expect(planRevision({ ...clashing, baseRefName: "main" }, pr, ctx)).toEqual({ kind: "none" })
    expect(conflictWith({ ...clashing, baseRefName: "main" }, "staging")).toBeNull()
    expect(conflictWith({ ...clashing, baseRefName: undefined }, "staging")).toBe(CONFLICT)
  })

  it("lets the merge ride along with feedback at the same head, as one review round", () => {
    expect(planRevision({ ...clashing, statusCheckRollup: redTest }, pr, ctx)).toEqual({
      kind: "revise", handled: ["check:h1:Test", "conflict:h1"], reasons: ["Test failed", CONFLICT],
    })
  })

  it("merges before it re-runs checks the infrastructure failed: a PR that clashes gets no new CI", () => {
    expect(planRevision({ ...clashing, statusCheckRollup: redTest }, pr, { ...ctx, infra: { Test: true } })).toEqual({
      kind: "revise", handled: ["conflict:h1"], reasons: [CONFLICT],
    })
  })

  it("has a cap of its own: at it, it asks, and the review rounds are left alone", () => {
    const merged = (conflictRounds: number, rounds = 0) => ({ ...pr, revise: { rounds, handled: [], conflictRounds } })
    expect(planRevision(clashing, merged(MAX_CONFLICT_ROUNDS - 1), ctx)).toMatchObject({ kind: "revise", reasons: [CONFLICT] })
    expect(planRevision(clashing, merged(MAX_CONFLICT_ROUNDS), ctx)).toEqual({ kind: "ask", handled: ["conflict:h1"], reasons: [CONFLICT] })
    // Merge rounds used up: feedback still gets its review round, and the merge rides along.
    expect(planRevision({ ...clashing, statusCheckRollup: redTest }, merged(MAX_CONFLICT_ROUNDS), ctx)).toMatchObject({ kind: "revise", reasons: ["Test failed", CONFLICT] })
    // Review rounds used up: the merge still gets its own round.
    expect(planRevision(clashing, merged(0, MAX_REVISE_ROUNDS), ctx)).toMatchObject({ kind: "revise", reasons: [CONFLICT] })
  })

  it("at the review cap, asks about the feedback first, then merges without waiting for the answer", () => {
    const capped = { ...pr, revise: { rounds: MAX_REVISE_ROUNDS, handled: [] } }
    expect(planRevision({ ...clashing, statusCheckRollup: redTest }, capped, ctx)).toEqual({ kind: "ask", handled: ["check:h1:Test"], reasons: ["Test failed"] })
    const asked = { ...pr, revise: { rounds: MAX_REVISE_ROUNDS, handled: [], asked: true, askedHead: "h1" } }
    // New feedback at the head it asked at waits for the answer. The merge does not.
    expect(planRevision({ ...clashing, statusCheckRollup: redTest }, asked, ctx)).toEqual({ kind: "revise", handled: ["conflict:h1"], reasons: [CONFLICT] })
    expect(planRevision({ ...clean, statusCheckRollup: redTest }, asked, ctx)).toEqual({ kind: "none" })
  })
})

describe("reviseOwnPr for a PR that clashes with its base (STEP-3340)", () => {
  const setup = (record: WatchedPr = pr) => {
    process.env.AGENTD_HOME = mkdtempSync(join(tmpdir(), "agentd-conflict-"))
    const paths = agentPaths()
    const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/repo" }, pluginRoot: "/plugin", slack: { allowedUsers: ["U0EXAMPLE"] } })
    recordPr(paths, record)
    const deps = { exec: fakeExec().exec, paths, config, now: () => new Date("2026-09-25T11:00:00Z"), log: { info: () => {}, warn: () => {}, error: () => {} }, tracker: fakeTracker([issue({ id: "STEP-7" })]).tracker }
    const texts = () => listNew<{ text: string }>(paths.outbox).map((e) => e.payload.text)
    return { paths, deps, texts }
  }

  it("queues one merge round at the head, counted on its own, and says so in plain words", async () => {
    const { paths, deps, texts } = setup({ ...pr, revise: { rounds: 2, handled: ["review:R1"], lastRoundAt: "2026-09-25T10:30:00.000Z" } })
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], clashing, ["Test"])
    const jobs = listJobs(paths, "pending")
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ kind: "revise", revise: { branch: "STEP-7-x", round: 1, reasons: [CONFLICT], since: "2026-09-25T10:30:00.000Z" } })
    // The review rounds' count and feedback window stay as they were.
    expect(readWatchedPrs(paths)[0].revise).toEqual({ rounds: 2, handled: ["review:R1", "conflict:h1"], lastRoundAt: "2026-09-25T10:30:00.000Z", conflictRounds: 1 })
    expect(texts()).toEqual([`STEP-7: <${URL}|PR #7> clashes with changes made to staging since it was opened, so I am combining the two, try 1 of 3. Nothing needed from you.`])

    // The job ran and ended, the head did not move: nothing more.
    rmSync(jobPath(paths, "pending", jobs[0].id))
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], clashing, ["Test"])
    expect(listJobs(paths, "pending")).toEqual([])
  })

  it("waits on UNKNOWN, then queues once GitHub has worked it out", async () => {
    const { paths, deps } = setup()
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], { ...clean, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, ["Test"])
    expect(listJobs(paths, "pending")).toEqual([])
    expect(readWatchedPrs(paths)[0].revise).toBeUndefined()
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], clashing, ["Test"])
    expect(listJobs(paths, "pending")).toHaveLength(1)
  })

  it("keeps the merge rounds' count through a review round, and names the clash once in Slack", async () => {
    const { paths, deps, texts } = setup({ ...pr, revise: { rounds: 0, handled: [], conflictRounds: 2 } })
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], { ...clashing, statusCheckRollup: redTest }, ["Test"])
    expect(listJobs(paths, "pending")[0]).toMatchObject({ revise: { round: 1, reasons: ["Test failed", CONFLICT] } })
    expect(readWatchedPrs(paths)[0].revise).toMatchObject({ rounds: 1, conflictRounds: 2, handled: ["check:h1:Test", "conflict:h1"] })
    expect(texts()).toEqual([`STEP-7: I am fixing the failing checks and the clash with newer changes in staging on <${URL}|PR #7> (Test failed), try 1 of 3. Nothing needed from you.`])
  })

  it("asks once per head at its cap, and leaves the review cap's question alone", async () => {
    const { paths, deps } = setup({ ...pr, revise: { rounds: 1, handled: [], conflictRounds: MAX_CONFLICT_ROUNDS } })
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], clashing, ["Test"])
    expect(listJobs(paths, "pending")).toEqual([])
    const asked = openDecisions(paths)
    expect(asked.map((d) => d.id)).toEqual(["conflict-STEP-7-7-h1"])
    expect(asked[0]).toMatchObject({ defaultReply: "leave it", defaultAction: { kind: "leave" } })
    expect(asked[0].question).toBe(`<${URL}|PR #7> still cannot go in: it clashes with changes made to staging since, and I have already tried to combine them 3 times.`)
    const record = readWatchedPrs(paths)[0].revise
    expect(record).toEqual({ rounds: 1, handled: ["conflict:h1"], conflictRounds: MAX_CONFLICT_ROUNDS })
    // Asked at this head: nothing more here.
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], clashing, ["Test"])
    expect(openDecisions(paths)).toHaveLength(1)
    // A new head that still clashes asks again.
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], { ...clashing, headRefOid: "h2" }, ["Test"])
    expect(openDecisions(paths).map((d) => d.id).sort()).toEqual(["conflict-STEP-7-7-h1", "conflict-STEP-7-7-h2"])
  })

  it("hands a merge round nothing of the browser test's: its findings wait for a review round", async () => {
    const { paths, deps } = setup()
    saveUserTestState(paths, { issue: "STEP-7", url: URL, head: "h0", verdict: "findings", findings: ["major: X"], at: "2026-09-25T10:30:00.000Z" })
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], clashing, ["Test"])
    expect(listJobs(paths, "pending")[0].revise).not.toHaveProperty("usertestFindings")
  })
})
