import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../config.ts"
import { putOnce, readJson } from "../fsq.ts"
import { listJobs, moveJob, submitJob } from "../jobs.ts"
import { buildDigest } from "../tick.ts"
import { fakeTracker, issue } from "./fakes.ts"

const NOW = new Date("2026-09-24T10:00:00.000Z")
const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] }, queue: { mode: "open" } })

function setup(seed = [issue({ id: "STEP-1", labels: ["polads", "agent-ready"] })], failOn: string[] = []) {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-tick-")))
  const fake = fakeTracker(seed, undefined, failOn)
  return { paths, fake, deps: { paths, config, tracker: fake.tracker, now: () => NOW } }
}

const base = { channel: "CIN", ts: "1800.1", user: "UNATE", userName: "Nate", text: "<@UBOT> x", receivedAt: "2026-09-24T09:59:00.000Z" }

describe("buildDigest", () => {
  it("shows filed intakes and mentions, and hides answers and intakes not filed yet", async () => {
    const { paths, deps } = setup()
    putOnce(paths.inbox, "msg:CIN:1", { ...base, key: "msg:CIN:1", type: "intake", issue: "STEP-9", linearId: "x", receivedAt: "2026-09-24T09:58:00.000Z" })
    putOnce(paths.inbox, "msg:CIN:2", { ...base, key: "msg:CIN:2", type: "intake", issue: null, linearId: "y" })
    putOnce(paths.inbox, "msg:CQ:3", { ...base, key: "msg:CQ:3", type: "answer", issue: "STEP-7", threadTs: "1700.1" })
    putOnce(paths.inbox, "msg:CAG:4", { ...base, key: "msg:CAG:4", type: "mention", channel: "CAG", threadTs: "1900.1" })
    const digest = await buildDigest(deps)
    expect(digest.events.map((e) => [e.type, e.key, e.threadTs])).toEqual([
      ["intake", "msg:CIN:1", "1800.1"],
      ["mention", "msg:CAG:4", "1900.1"],
    ])
    // Only what the front door acts on: the bridge's own bookkeeping stays out of the model's context.
    expect(digest.events[0]).toEqual({ key: "msg:CIN:1", type: "intake", issue: "STEP-9", channel: "CIN", ts: "1800.1", threadTs: "1800.1", user: "UNATE", userName: "Nate", text: "<@UBOT> x", receivedAt: "2026-09-24T09:58:00.000Z" })
  })

  it("carries filedBy on a mention another agent files, so the front door files nothing for it", async () => {
    const { paths, deps } = setup()
    putOnce(paths.inbox, "msg:CIN:5", { ...base, key: "msg:CIN:5", type: "mention", threadTs: "1800.1", filedBy: "U0OTHERBOT1" })
    const [event] = (await buildDigest(deps)).events
    expect(event).toMatchObject({ type: "mention", filedBy: "U0OTHERBOT1" })
  })

  it("shows at most ten events, oldest first", async () => {
    const { paths, deps } = setup()
    for (let i = 0; i < 12; i++) {
      const at = new Date(NOW.getTime() - (20 - i) * 60_000).toISOString()
      putOnce(paths.inbox, `msg:CAG:${i}`, { ...base, key: `msg:CAG:${i}`, type: "mention", channel: "CAG", ts: `19${i}.1`, threadTs: `19${i}.1`, receivedAt: at })
    }
    const events = (await buildDigest(deps)).events
    expect(events.map((e) => e.key)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `msg:CAG:${i}`))
  })

  it("reports a finished job exactly once", async () => {
    const { paths, deps } = setup()
    const job = submitJob(paths, "STEP-1", null, NOW)
    moveJob(paths, job.id, "pending", "done", { result: { status: "done", reason: "done", prUrl: "https://github.com/x/pull/9", branch: "b", costUsd: 2, turns: 40, minutes: 30 } })
    expect((await buildDigest(deps)).finishedJobs).toEqual([{ issue: "STEP-1", status: "done", reason: "done", prUrl: "https://github.com/x/pull/9" }])
    expect((await buildDigest(deps)).finishedJobs).toEqual([])
    expect(listJobs(paths, "done")[0].reported).toBe(true)
  })

  it("shows the running worker and how long it has run", async () => {
    const { paths, deps } = setup()
    const job = submitJob(paths, "STEP-1", null, new Date("2026-09-24T09:00:00.000Z"))
    moveJob(paths, job.id, "pending", "running", { pid: 4242, startedAt: "2026-09-24T09:15:00.000Z" })
    expect(await buildDigest(deps)).toMatchObject({ worker: { issue: "STEP-1", startedAt: "2026-09-24T09:15:00.000Z", minutes: 45 }, develop: null, developBlockedBy: "a worker is busy" })
  })

  it("offers the next issue to develop, and none while a job is pending or the mini is paused", async () => {
    const { paths, deps } = setup()
    expect((await buildDigest(deps)).develop).toMatchObject({ id: "STEP-1", mine: false })
    submitJob(paths, "STEP-99", null, NOW)
    expect(await buildDigest(deps)).toMatchObject({ develop: null, developBlockedBy: "a worker is busy" })
    const other = setup()
    mkdirSync(other.paths.root, { recursive: true })
    writeFileSync(other.paths.pauseFile, "")
    expect(await buildDigest(other.deps)).toMatchObject({ paused: true, pauseReason: "", develop: null, refine: null, developBlockedBy: "paused" })
  })

  it("says why the mini is paused, so the front door can tell people in Slack", async () => {
    const { paths, deps } = setup()
    expect((await buildDigest(deps)).pauseReason).toBeNull()
    mkdirSync(paths.root, { recursive: true })
    // The shape agentctl pause, agentd and the runner all write.
    writeFileSync(paths.pauseFile, JSON.stringify({ at: NOW.toISOString(), reason: "early losses on two different issues in a row (STEP-1, STEP-2): a fault on this mini" }))
    expect(await buildDigest(deps)).toMatchObject({ paused: true, pauseReason: "early losses on two different issues in a row (STEP-1, STEP-2): a fault on this mini" })
  })

  it("holds develop back in light mode, and still refines", async () => {
    const { paths, deps } = setup([issue({ id: "STEP-1", labels: ["polads", "agent-ready"] }), issue({ id: "STEP-9", state: "Triage" })])
    mkdirSync(paths.state, { recursive: true })
    const resets = NOW.getTime() / 1000 + 86_400
    writeFileSync(join(paths.state, "usage.json"), JSON.stringify({ at: NOW.toISOString(), fiveHourPct: 5, fiveHourResetsAt: resets, sevenDayPct: 85, sevenDayResetsAt: resets }))
    expect(await buildDigest(deps)).toMatchObject({
      develop: null,
      developBlockedBy: "weekly usage at 85 percent (light mode)",
      refine: { id: "STEP-9", state: "Triage" },
      usage: { fiveHourPct: 5, sevenDayPct: 85 },
    })
  })

  it("asks Linear for Triage and Refining only when refining is due", async () => {
    const five = ["STEP-1", "STEP-2", "STEP-3", "STEP-4", "STEP-5"].map((id) => issue({ id, labels: ["polads", "agent-ready"] }))
    const full = setup(five)
    expect((await buildDigest(full.deps)).readyEligible).toBe(5)
    expect(full.fake.called("listByState")).toEqual([])
    const short = setup()
    await buildDigest(short.deps)
    expect(short.fake.called("listByState").map((args) => args[0])).toEqual(["Triage", "Refining"])
  })

  it("holds back an issue whose last two workers were lost early, and offers the next one", async () => {
    const { paths, deps } = setup([issue({ id: "STEP-1", labels: ["polads", "agent-ready"] }), issue({ id: "STEP-2", labels: ["polads", "agent-ready"] })])
    const lost = (at: string) => {
      const job = submitJob(paths, "STEP-1", null, new Date(at))
      moveJob(paths, job.id, "pending", "done", { endedAt: at, lostEarly: true, reported: true, result: { status: "blocked", reason: "the worker process died before reporting", prUrl: null, branch: null, costUsd: null, turns: null, minutes: 1 } })
    }
    lost("2026-09-24T09:00:00.000Z")
    expect((await buildDigest(deps)).develop).toMatchObject({ id: "STEP-1" })
    lost("2026-09-24T09:10:00.000Z")
    expect(await buildDigest(deps)).toMatchObject({ develop: { id: "STEP-2" }, heldBack: ["STEP-1"], readyEligible: 1 })
  })

  it("waits 15 minutes before offering again an issue whose last job Linear failed", async () => {
    const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()
    const failed = (minutesAgo: number) => {
      const s = setup([issue({ id: "STEP-1", labels: ["polads", "agent-ready"] }), issue({ id: "STEP-2", labels: ["polads", "agent-ready"] })])
      const job = submitJob(s.paths, "STEP-1", null, new Date(at(minutesAgo + 1)))
      moveJob(s.paths, job.id, "pending", "done", { endedAt: at(minutesAgo), linearFailed: true, reported: true, result: { status: "skipped", reason: "Linear failed before the claim: 503", prUrl: null, branch: null, costUsd: null, turns: null, minutes: 0 } })
      return s
    }
    expect((await buildDigest(failed(5).deps)).develop).toMatchObject({ id: "STEP-2" })
    expect((await buildDigest(failed(20).deps)).develop).toMatchObject({ id: "STEP-1" })
  })

  it("still offers the develop job when only the refine lists fail", async () => {
    const { deps } = setup(undefined, ["listByState"])
    expect(await buildDigest(deps)).toMatchObject({ develop: { id: "STEP-1" }, readyEligible: 1, refine: null, linearError: expect.stringMatching(/listByState failed/) })
  })

  it("reports Linear being down instead of failing the wakeup", async () => {
    const { paths, deps } = setup([], ["whoami"])
    const digest = await buildDigest(deps)
    expect(digest.linearError).toMatch(/whoami failed/)
    expect(digest.develop).toBeNull()
    // The wakeup still counts: agentd must not restart a front door because Linear is down.
    expect(readJson(join(paths.state, "frontdoor-tick.json"))).toEqual({ at: NOW.toISOString() })
  })

  it("records the wakeup for agentd and suggests when to wake next", async () => {
    const { paths, deps } = setup([])
    const digest = await buildDigest(deps)
    expect(readJson(join(paths.state, "frontdoor-tick.json"))).toEqual({ at: NOW.toISOString() })
    expect(digest.nextWakeupSeconds).toBe(300)
    expect(digest.mini).toBe("eve")
    expect(existsSync(paths.pauseFile)).toBe(false)
  })
})
