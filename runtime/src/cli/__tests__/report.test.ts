import { describe, expect, it } from "vitest"
import { statusReport, summariseLedger, type StatusInput } from "../report.ts"

const NOW = new Date("2026-09-24T12:00:00.000Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

const healthy: StatusInput = {
  mini: "eve",
  paused: null,
  agentd: { pid: 4100, at: ago(10_000) },
  frontDoor: { alive: true, lastWakeAt: new Date(NOW.getTime() - 3 * 60_000), startsLastHour: 1, waitUntil: null },
  worker: { issue: "STEP-7", minutes: 12, pid: 4242 },
  pending: [],
  heldBack: [],
  bridge: { at: ago(20_000), connected: true, outboxWaiting: 2, outboxFailed: 0 },
  usage: { at: NOW.toISOString(), fiveHourPct: 23, fiveHourResetsAt: null, sevenDayPct: 41.2, sevenDayResetsAt: null },
  linear: { ok: true, email: "eve@polads.eu" },
  now: NOW,
}

describe("statusReport", () => {
  it("reads as one line per part", () => {
    expect(statusReport(healthy).split("\n")).toEqual([
      "eve",
      "agentd: running, pid 4100",
      "front door: running, last wakeup 3 min ago, 1 start(s) in the last hour",
      "worker: STEP-7, 12 min, pid 4242",
      "bridge: connected, heartbeat 0 min ago, outbox 2 waiting, 0 failed",
      "usage: 5h 23 percent, 7d 41 percent",
      "linear: ok (eve@polads.eu)",
    ])
  })

  it("shouts what is wrong: the pause and its reason, agentd's own error, held-back issues, a disconnected bridge", () => {
    const text = statusReport({
      ...healthy,
      paused: "early losses on two different issues in a row (STEP-1, STEP-2): a fault on this mini",
      agentd: { pid: 4100, at: ago(10_000), error: "agentd: /Users/eve/.agentd/config.json names mini \"eve\", but the machine profile has mini \"bob\"" },
      heldBack: ["STEP-9"],
      pending: ["STEP-8"],
      worker: null,
      bridge: { at: ago(20_000), connected: false, outboxWaiting: 0, outboxFailed: 1 },
    }).split("\n")
    expect(text[0]).toBe("eve PAUSED (early losses on two different issues in a row (STEP-1, STEP-2): a fault on this mini). agentctl resume lifts it")
    expect(text[1]).toBe('agentd: NOT RUNNING: agentd: /Users/eve/.agentd/config.json names mini "eve", but the machine profile has mini "bob"')
    expect(text[3]).toBe("worker: idle, queued: STEP-8")
    expect(text[4]).toBe("held back: STEP-9. Its last two workers were lost early. agentctl job submit --issue <id> runs one by hand")
    expect(text[5]).toBe("bridge: DISCONNECTED, heartbeat 0 min ago, outbox 0 waiting, 1 failed")
  })

  it("says a pause nobody explained, and agentd with no recent heartbeat", () => {
    const text = statusReport({ ...healthy, paused: "", agentd: { pid: 4100, at: ago(5 * 60_000) } }).split("\n")
    expect(text[0]).toBe("eve PAUSED (no reason given). agentctl resume lifts it")
    expect(text[1]).toBe("agentd: NO HEARTBEAT for 5 min (pid 4100)")
    expect(statusReport({ ...healthy, agentd: null }).split("\n")[1]).toBe("agentd: NEVER STARTED (no ~/.agentd/state/agentd.json)")
  })

  it("tells a paused outbox from a stopped bridge", () => {
    // The bridge writes its heartbeat every 30 seconds, error or not: an error
    // with a fresh heartbeat is Slack refusing the app, and the bridge still runs.
    const paused = { at: ago(20_000), connected: true, outboxWaiting: 3, outboxFailed: 0, error: "not_in_channel on #polads-agents (outbox entry 1)" }
    expect(statusReport({ ...healthy, bridge: paused }).split("\n")[4]).toBe(
      "bridge: connected, OUTBOX PAUSED: not_in_channel on #polads-agents (outbox entry 1), heartbeat 0 min ago, outbox 3 waiting, 0 failed",
    )
    expect(statusReport({ ...healthy, bridge: { ...paused, error: "invalid_auth", stopped: true } }).split("\n")[4]).toBe("bridge: STOPPED: invalid_auth")
    expect(statusReport({ ...healthy, bridge: { ...paused, at: ago(10 * 60_000), error: undefined } }).split("\n")[4]).toBe("bridge: NO HEARTBEAT for 10 min")
    expect(statusReport({ ...healthy, bridge: null }).split("\n")[4]).toBe("bridge: NO HEARTBEAT (never written)")
  })

  it("says why agentd would not start the front door", () => {
    const text = statusReport({
      ...healthy,
      agentd: { pid: 4100, at: ago(10_000), frontDoorRefused: "the sandbox probe has not passed on 2.1.290 (Claude Code): a person runs agentctl probe-sandbox" },
      frontDoor: { alive: false, lastWakeAt: null, startsLastHour: 0, waitUntil: null },
    })
    expect(text.split("\n")[1]).toBe("agentd: running, pid 4100")
    expect(text.split("\n")[2]).toBe(
      "front door: NOT RUNNING, last wakeup never, 0 start(s) in the last hour, NOT STARTED: the sandbox probe has not passed on 2.1.290 (Claude Code): a person runs agentctl probe-sandbox",
    )
  })

  it("shows a front door that is not running or waits", () => {
    const text = statusReport({ ...healthy, frontDoor: { alive: false, lastWakeAt: null, startsLastHour: 0, waitUntil: "2026-09-24T12:30:00.000Z" } })
    expect(text.split("\n")[2]).toBe("front door: NOT RUNNING, last wakeup never, 0 start(s) in the last hour, waiting until 2026-09-24T12:30:00.000Z")
  })

  it("says Linear's error and a missing usage snapshot", () => {
    const text = statusReport({ ...healthy, usage: null, linear: { ok: false, error: "fetch failed" } }).split("\n")
    expect(text.slice(-2)).toEqual(["usage: no snapshot yet", "linear: ERROR fetch failed"])
  })
})

describe("summariseLedger", () => {
  it("counts jobs, PRs, spend, questions and answer latency since a date", () => {
    const events = [
      { at: "2026-09-20T09:00:00.000Z", type: "worker.end", status: "done", minutes: 99, costUsd: 9 },
      { at: "2026-09-24T09:00:00.000Z", type: "worker.end", status: "done", minutes: 30, costUsd: 2.5 },
      { at: "2026-09-24T10:00:00.000Z", type: "worker.end", status: "blocked", minutes: 90, costUsd: 15 },
      { at: "2026-09-24T09:00:00.000Z", type: "pr.opened", issue: "STEP-7" },
      { at: "2026-09-24T09:00:00.000Z", type: "report.corrected", issue: "STEP-7", problem: "checklist" },
      { at: "2026-09-24T09:30:00.000Z", type: "report.selfCheckGaps", issue: "STEP-9", problem: "mutations" },
      { at: "2026-09-24T09:35:00.000Z", type: "report.selfCheckGaps", issue: "STEP-10", problem: "checklist" },
      { at: "2026-09-24T09:36:00.000Z", type: "report.fromCommits", issue: "STEP-11", problem: "prTitle" },
      { at: "2026-09-24T09:37:00.000Z", type: "report.fromCommits", issue: "STEP-12", problem: "report" },
      { at: "2026-09-24T09:38:00.000Z", type: "report.fromCommits", issue: "STEP-13", problem: "prTitle" },
      { at: "2026-09-24T09:40:00.000Z", type: "pr.revise", issue: "STEP-7", round: 1 },
      { at: "2026-09-24T09:50:00.000Z", type: "pr.revise", issue: "STEP-7", round: 2 },
      { at: "2026-09-24T10:00:00.000Z", type: "question.asked", issue: "STEP-8" },
      { at: "2026-09-24T10:40:00.000Z", type: "answer.applied", issue: "STEP-8" },
      { at: "2026-09-24T11:00:00.000Z", type: "usage", fiveHourPct: 20, sevenDayPct: 44 },
    ]
    expect(summariseLedger(events, new Date("2026-09-23T00:00:00.000Z"), [], NOW).split("\n")).toEqual([
      "since 2026-09-23",
      "jobs: 2 (done 1, blocked 1)",
      "PRs opened: 1, median job minutes for a PR: 30",
      "reports asked for again: 1, gone out with self-check gaps: 2, titled from commits: 3, revise rounds: 2",
      "estimated spend: USD 17.50",
      "questions: 1 asked, 1 answered, median answer 40 min",
      "front door starts: 0, claims released: 0, pauses: 0",
      "latest usage: 5h 20 percent, 7d 44 percent",
      "first-pass merges: none. Baseline: 1 of 9 (11 percent) on 2026-09-25: 8 of Eve's first 9 PRs needed a second pass",
      "PRs with a must-fix finding: none, revise rounds per PR: n/a, blocked jobs: 1, human interventions: 1, per issue: n/a",
      "first-pass trend: week to 2026-09-03: none merged, week to 2026-09-10: none merged, week to 2026-09-17: none merged, week to 2026-09-24: none merged",
    ])
  })

  it("says none when nothing happened", () => {
    expect(summariseLedger([], new Date("2026-09-23T00:00:00.000Z"), [], NOW).split("\n")).toEqual([
      "since 2026-09-23",
      "jobs: 0 (none)",
      "PRs opened: 0, median job minutes for a PR: n/a",
      "reports asked for again: 0, gone out with self-check gaps: 0, titled from commits: 0, revise rounds: 0",
      "estimated spend: USD 0.00",
      "questions: 0 asked, 0 answered, median answer n/a",
      "front door starts: 0, claims released: 0, pauses: 0",
      "latest usage: none recorded",
      "first-pass merges: none. Baseline: 1 of 9 (11 percent) on 2026-09-25: 8 of Eve's first 9 PRs needed a second pass",
      "PRs with a must-fix finding: none, revise rounds per PR: n/a, blocked jobs: 0, human interventions: 0, per issue: n/a",
      "first-pass trend: week to 2026-09-03: none merged, week to 2026-09-10: none merged, week to 2026-09-17: none merged, week to 2026-09-24: none merged",
    ])
  })
})

describe("the Slack channel's status line (STEP-3293)", () => {
  const NOW2 = new Date("2026-09-25T10:00:00.000Z")
  const status = (channel: StatusInput["channel"]) => statusReport({ ...healthy, now: NOW2, bridge: null, channel }).split("\n").find((l) => l.startsWith("slack channel:"))
  it("says whether the channel server runs, never that the front door gets its pushes, and how many messages wait (STEP-3293 review)", () => {
    // Claude Code never says whether it registered the channel: the messages still open say whether they reach the front door.
    expect(status({ at: "2026-09-25T09:59:30.000Z", waiting: 1, off: null })).toBe("slack channel: server running, 1 message waiting for the front door")
    expect(status({ at: "2026-09-25T09:50:00.000Z", waiting: 2, off: null })).toBe("slack channel: server NOT RUNNING for 10 min, 2 messages waiting for the front door")
    expect(status({ at: null, waiting: 0, off: null })).toBe("slack channel: server never ran: messages wait for the front door's next wakeup, 0 messages waiting for the front door")
    expect(status({ at: null, waiting: 0, off: "frontDoor.channel in config.json" })).toBe("slack channel: off (frontDoor.channel in config.json), 0 messages waiting for the front door")
    for (const line of [status({ at: "2026-09-25T09:59:30.000Z", waiting: 1, off: null }), status({ at: null, waiting: 0, off: null })]) expect(line).not.toMatch(/connected|\(s\)/)
    expect(status(undefined)).toBeUndefined()
  })
})
