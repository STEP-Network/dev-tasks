import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { agentPaths } from "../../config.ts"
import { listNew, putOnce, writeJsonAtomic } from "../../fsq.ts"
import { listJobs, moveJob, submitJob } from "../../jobs.ts"
import { fakeExec, fakeTracker, issue } from "../../__tests__/fakes.ts"
import { parseCli, run, UsageError, type AgentctlDeps } from "../agentctl.ts"

const NOW = new Date("2026-09-24T12:00:00.000Z")
let root = ""
let printed: string[] = []
const out = (line: string) => {
  printed.push(line)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentctl-"))
  process.env.AGENTD_HOME = root
  printed = []
})
afterEach(() => {
  delete process.env.AGENTD_HOME
})

function writeConfig() {
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({ mini: "eve", repo: { path: "/Users/eve/polads" }, pluginRoot: "/Users/eve/dev-tasks/plugin", slack: { allowedUsers: ["UNATE"] }, queue: { mode: "open" } }),
  )
}

function deps(over: Partial<AgentctlDeps> = {}): Partial<AgentctlDeps> {
  const fake = fakeTracker([issue({ id: "STEP-1", labels: ["polads", "agent-ready"] })])
  return { tracker: () => fake.tracker, exec: fakeExec().exec, now: () => NOW, env: {}, isTTY: () => true, ...over }
}

describe("parseCli", () => {
  it("splits the command, its words and its flags", () => {
    expect(parseCli(["job", "submit", "--issue", "STEP-7", "--dry"])).toEqual({ command: "job", rest: ["submit"], flags: { issue: "STEP-7", dry: true } })
  })
})

describe("run", () => {
  it("queues a develop job and refuses a second for the same issue", async () => {
    expect(await run(["job", "submit", "--issue", "STEP-7"], out, deps())).toBe(0)
    expect(listJobs(agentPaths(), "pending")[0]).toMatchObject({ issue: "STEP-7", model: null })
    await expect(run(["job", "submit", "--issue", "STEP-7"], out, deps())).rejects.toThrow(/already pending/)
    await run(["job", "list"], out, deps())
    expect(JSON.parse(printed.at(-1)!)).toMatchObject({ pending: [{ issue: "STEP-7" }], running: [], done: [] })
  })

  it("takes only the config's worker models for a job", async () => {
    writeConfig()
    await run(["job", "submit", "--issue", "STEP-8", "--model", "opus"], out, deps())
    expect(listJobs(agentPaths(), "pending").find((j) => j.issue === "STEP-8")).toMatchObject({ model: "opus" })
    for (const model of ["claude-anything", "--dangerously", "true"]) {
      await expect(run(["job", "submit", "--issue", "STEP-9", "--model", model], out, deps()), model).rejects.toThrow(/--model must be one of sonnet, opus/)
    }
    await expect(run(["job", "submit", "--issue", "STEP-9", "--model"], out, deps())).rejects.toBeInstanceOf(UsageError)
    expect(listJobs(agentPaths(), "pending").map((j) => j.issue)).toEqual(["STEP-8"])
  })

  it("queues a question in the issue's thread", async () => {
    await run(["ask", "--issue", "STEP-7", "--text", "Which date?"], out, deps())
    expect(listNew(agentPaths().outbox)[0].payload).toMatchObject({ kind: "issue", issue: "STEP-7", text: "Which date?", question: true })
  })

  it("queues a post in one of the four channels, and a reply in a thread", async () => {
    await run(["slack", "post", "--channel", "agents", "--text", "hello"], out, deps())
    await run(["slack", "reply", "--channel", "C0INTAKE", "--thread", "1790000000.000100", "--text", "Filed STEP-9."], out, deps())
    expect(listNew(agentPaths().outbox).map((e) => e.payload)).toMatchObject([
      { kind: "post", channel: "agents", text: "hello" },
      { kind: "reply", channelId: "C0INTAKE", threadTs: "1790000000.000100", text: "Filed STEP-9." },
    ])
  })

  it("refuses a bad issue id, an unknown channel, a bad thread and a missing text as usage errors", async () => {
    await expect(run(["ask", "--issue", "7", "--text", "x"], out, deps())).rejects.toBeInstanceOf(UsageError)
    await expect(run(["slack", "post", "--channel", "general", "--text", "x"], out, deps())).rejects.toBeInstanceOf(UsageError)
    await expect(run(["slack", "reply", "--channel", "C1", "--thread", "1.1"], out, deps())).rejects.toBeInstanceOf(UsageError)
    await expect(run(["slack", "reply", "--channel", "polads-intake", "--thread", "1.1", "--text", "x"], out, deps())).rejects.toBeInstanceOf(UsageError)
    await expect(run(["slack", "reply", "--channel", "C1", "--thread", "yesterday", "--text", "x"], out, deps())).rejects.toBeInstanceOf(UsageError)
    await expect(run(["nosuch"], out, deps())).rejects.toBeInstanceOf(UsageError)
    expect(listNew(agentPaths().outbox)).toEqual([])
  })

  it("takes a message from a file, as written, where no shell expands people's words", async () => {
    const file = join(root, "reply.md")
    writeFileSync(file, "They asked for $(touch pwned) and `this`.\nSecond line.\n")
    await run(["slack", "reply", "--channel", "C0INTAKE", "--thread", "1790000000.000100", "--text-file", file], out, deps())
    await run(["ask", "--issue", "STEP-7", "--text-file", file], out, deps())
    expect(listNew<{ text: string }>(agentPaths().outbox).map((e) => e.payload.text)).toEqual([
      "They asked for $(touch pwned) and `this`.\nSecond line.",
      "They asked for $(touch pwned) and `this`.\nSecond line.",
    ])
    await expect(run(["ask", "--issue", "STEP-7", "--text", "x", "--text-file", file], out, deps())).rejects.toBeInstanceOf(UsageError)
    await expect(run(["ask", "--issue", "STEP-7"], out, deps())).rejects.toThrow(/--text or --text-file/)
  })

  it("sends no secrets file and no token, from a file or inline", async () => {
    // agentctl runs outside the front door's sandbox, so it keeps them out itself.
    const tokens = join(root, "notes.md")
    writeFileSync(tokens, "SLACK_BOT_TOKEN=xoxb-1234-5678-abcdef\n")
    await expect(run(["slack", "post", "--channel", "agents", "--text-file", tokens], out, deps())).rejects.toThrow(/carries a key or a token/)
    await expect(run(["slack", "post", "--channel", "agents", "--text", "see lin_api_abcdefghijkl"], out, deps())).rejects.toBeInstanceOf(UsageError)
    await expect(run(["slack", "post", "--channel", "agents", "--text-file", join(root, ".env")], out, deps())).rejects.toThrow(/secrets file/)
    expect(listNew(agentPaths().outbox)).toEqual([])
  })

  it("lifts no pause and runs no probe from the front door's own session", async () => {
    writeFileSync(agentPaths().pauseFile, JSON.stringify({ at: NOW.toISOString(), reason: "a person" }))
    await expect(run(["resume"], out, deps({ env: { AGENTD_FRONT_DOOR: "1" } }))).rejects.toThrow(/for a person at a terminal/)
    await expect(run(["probe-hooks"], out, deps({ env: { AGENTD_FRONT_DOOR: "1" } }))).rejects.toThrow(/for a person at a terminal/)
    // A variable set in front of the command can clear the mark, but not give the front door's Bash a terminal.
    await expect(run(["resume"], out, deps({ env: {}, isTTY: () => false }))).rejects.toThrow(/for a person at a terminal/)
    await expect(run(["probe-sandbox"], out, deps({ env: {}, isTTY: () => false }))).rejects.toThrow(/for a person at a terminal/)
    expect(existsSync(agentPaths().pauseFile)).toBe(true)
    await run(["resume"], out, deps({ env: {} }))
    expect(existsSync(agentPaths().pauseFile)).toBe(false)
  })

  it("pauses with a reason, and resume lifts any pause, agentd's own included", async () => {
    await run(["pause", "--reason", "rehearsal"], out, deps())
    expect(JSON.parse(readFileSync(agentPaths().pauseFile, "utf8"))).toEqual({ at: NOW.toISOString(), reason: "rehearsal" })
    await run(["resume"], out, deps())
    expect(existsSync(agentPaths().pauseFile)).toBe(false)
    writeFileSync(agentPaths().pauseFile, JSON.stringify({ at: NOW.toISOString(), reason: "early losses on two different issues in a row" }))
    await run(["resume"], out, deps())
    expect(printed.at(-1)).toBe('{"paused":false,"was":"early losses on two different issues in a row"}')
    expect(existsSync(agentPaths().pauseFile)).toBe(false)
  })

  it("acks inbox events by key", async () => {
    putOnce(agentPaths().inbox, "msg:CAG:1900.1", { type: "mention" })
    await run(["ack", "msg:CAG:1900.1", "msg:CAG:none"], out, deps())
    expect(printed.at(-1)).toBe('{"acked":1}')
    expect(listNew(agentPaths().inbox)).toEqual([])
    await expect(run(["ack"], out, deps())).rejects.toBeInstanceOf(UsageError)
  })

  it("prints the digest for tick, with why the mini is paused", async () => {
    writeConfig()
    writeFileSync(agentPaths().pauseFile, JSON.stringify({ at: NOW.toISOString(), reason: "update" }))
    await run(["tick"], out, deps())
    expect(JSON.parse(printed.at(-1)!)).toMatchObject({ mini: "eve", paused: true, pauseReason: "update", develop: null, heldBack: [], linearError: null })
  })

  it("shows status from the local state, agentd's error and the held-back issues included", async () => {
    writeConfig()
    const paths = agentPaths()
    writeJsonAtomic(join(paths.state, "agentd.json"), { pid: 4100, at: NOW.toISOString(), error: "agentd: config.json is invalid" })
    writeJsonAtomic(join(paths.state, "bridge.json"), { at: NOW.toISOString(), connected: true, outboxWaiting: 0, outboxFailed: 0 })
    // Two early losses in a row on STEP-3 hold it back.
    for (const minute of [1, 2]) {
      const job = submitJob(paths, "STEP-3", null, new Date(NOW.getTime() - (10 - minute) * 60_000))
      moveJob(paths, job.id, "pending", "done", { lostEarly: true, endedAt: new Date(NOW.getTime() - (10 - minute) * 60_000 + 1).toISOString() })
    }
    // STEP-4 was held back too, but a person has moved it on since: no longer Ready, no longer shown.
    for (const minute of [3, 4]) {
      const job = submitJob(paths, "STEP-4", null, new Date(NOW.getTime() - (10 - minute) * 60_000))
      moveJob(paths, job.id, "pending", "done", { lostEarly: true, endedAt: new Date(NOW.getTime() - (10 - minute) * 60_000 + 1).toISOString() })
    }
    const fake = fakeTracker([issue({ id: "STEP-3" }), issue({ id: "STEP-4", state: "Released" })])
    const tmux = fakeExec([[/has-session/, { code: 1 }]])
    await run(["status"], out, deps({ exec: tmux.exec, tracker: () => fake.tracker }))
    const lines = printed.at(-1)!.split("\n")
    expect(lines[0]).toBe("eve")
    expect(lines[1]).toBe("agentd: NOT RUNNING: agentd: config.json is invalid")
    expect(lines[2]).toMatch(/^front door: NOT RUNNING/)
    expect(lines).toContain("held back: STEP-3. Its last two workers were lost early. agentctl job submit --issue <id> runs one by hand")
    expect(lines.at(-1)).toBe("linear: ok (eve@polads.eu)")
    expect(tmux.lines()).toEqual(["tmux -L agentd has-session -t =frontdoor"])
  })

  it("reports the ledger over a number of days", async () => {
    const paths = agentPaths()
    mkdirSync(paths.logs, { recursive: true })
    writeFileSync(
      join(paths.logs, "ledger.jsonl"),
      [
        JSON.stringify({ at: "2026-09-24T09:00:00.000Z", type: "worker.end", status: "done", minutes: 30, costUsd: 2.5 }),
        "not json",
        JSON.stringify({ at: "2026-09-10T09:00:00.000Z", type: "worker.end", status: "done", minutes: 30, costUsd: 2.5 }),
      ].join("\n"),
    )
    await run(["report", "--days", "1"], out, deps())
    expect(printed.at(-1)!.split("\n").slice(0, 2)).toEqual(["since 2026-09-23", "jobs: 1 (done 1)"])
    await expect(run(["report", "--days", "0"], out, deps())).rejects.toBeInstanceOf(UsageError)
  })
})
