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

  it("queues a question in the issue's thread, always with this mini's recommendation (STEP-3293)", async () => {
    await run(["ask", "--issue", "STEP-7", "--text", "Which date?", "--recommendation", "the publication date"], out, deps())
    expect(listNew(agentPaths().outbox)[0].payload).toMatchObject({
      kind: "issue", issue: "STEP-7", question: true,
      text: "Which date?\n\nMy recommendation: the publication date. Reply yes to go with it, or tell me what you want instead.",
    })
    await expect(run(["ask", "--issue", "STEP-7", "--text", "Which date?"], out, deps())).rejects.toThrow(/--recommendation or --recommendation-file is required/)
    await expect(run(["ask", "--issue", "STEP-7", "--text", "Which date?", "--recommendation", "  "], out, deps())).rejects.toThrow(/the recommendation is empty/)
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
    await expect(run(["ask", "--issue", "7", "--text", "x", "--recommendation", "y"], out, deps())).rejects.toBeInstanceOf(UsageError)
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
    await run(["ask", "--issue", "STEP-7", "--text-file", file, "--recommendation", "no"], out, deps())
    expect(listNew<{ text: string }>(agentPaths().outbox).map((e) => e.payload.text)).toEqual([
      "They asked for $(touch pwned) and `this`.\nSecond line.",
      "They asked for $(touch pwned) and `this`.\nSecond line.\n\nMy recommendation: no. Reply yes to go with it, or tell me what you want instead.",
    ])
    await expect(run(["ask", "--issue", "STEP-7", "--text", "x", "--text-file", file, "--recommendation", "y"], out, deps())).rejects.toBeInstanceOf(UsageError)
    await expect(run(["ask", "--issue", "STEP-7", "--recommendation", "y"], out, deps())).rejects.toThrow(/--text or --text-file/)
  })

  it("spends a reply file in ~/.front-door once it is queued, and leaves any other file alone", async () => {
    const realHome = process.env.HOME
    process.env.HOME = join(root, "home")
    try {
      mkdirSync(join(root, "home", ".front-door"), { recursive: true })
      const reply = join(root, "home", ".front-door", "reply-1790000000.000100.md")
      const other = join(root, "notes.md")
      writeFileSync(reply, "Filed STEP-9.\n")
      writeFileSync(other, "Kept.\n")
      await run(["slack", "reply", "--channel", "C0INTAKE", "--thread", "1790000000.000100", "--text-file", reply], out, deps())
      await run(["slack", "post", "--channel", "agents", "--text-file", other], out, deps())
      expect(existsSync(reply)).toBe(false)
      expect(existsSync(other)).toBe(true)
      expect(listNew<{ text: string }>(agentPaths().outbox).map((e) => e.payload.text)).toEqual(["Filed STEP-9.", "Kept."])
    } finally {
      process.env.HOME = realHome
    }
  })

  it("keeps a token out of a pause's reason, which status and the digest show", async () => {
    await expect(run(["pause", "--reason", "SLACK_BOT_TOKEN=xoxb-1234-abcdef"], out, deps())).rejects.toBeInstanceOf(UsageError)
    expect(existsSync(agentPaths().pauseFile)).toBe(false)
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

  it("probes the worker's hooks on the binary workers run, for free with --scripted, and records either probe for doctor", async () => {
    writeConfig()
    const binary = "/sdk/claude-agent-sdk-darwin-arm64/claude"
    const exec = fakeExec([[/^\/sdk\/.*claude --version$/, { stdout: "2.1.281 (Claude Code)\n" }]]).exec
    // A session that refuses each scripted command as the guards word it, with dev-tasks loaded once.
    const scripted = [
      ...Array(6).fill("BLOCKED: Destructive command detected: 'git reset --hard'"),
      "Workers never open or merge PRs. The launcher opens the PR and arms auto-merge.",
      "Workers never read or write ~/.config or .env files: this machine's secrets live there, and no task needs them.",
    ]
    const query = async () => ((args: { options: { cwd?: string } }) =>
      (async function* () {
        yield { type: "system", subtype: "init", apiKeySource: "none", plugins: [{ name: "dev-tasks", path: "/Users/eve/dev-tasks/plugin" }] }
        for (const content of scripted) yield { type: "user", message: { content: [{ type: "tool_result", content }] } }
        void args
      })()) as unknown as AgentctlDeps["query"] extends () => Promise<infer Q> ? Q : never
    expect(await run(["probe-hooks", "--scripted"], out, deps({ exec, query, workerClaude: () => binary }))).toBe(0)
    expect(printed.at(-1)).toMatch(/^ok {3}the plugin's guard refuses git reset --hard\n[\s\S]*\nthe worker's hooks fire on 2\.1\.281 \(Claude Code\)$/)
    const record = JSON.parse(readFileSync(join(root, "state", "hooks-probe.json"), "utf8"))
    expect(record.scripted).toMatchObject({ kind: "scripted", ok: true, claudePath: binary, claudeVersion: "2.1.281 (Claude Code)", pluginHookFired: true, workerGuardFired: true })
    await expect(run(["probe-hooks", "--scripted", "yes"], out, deps({ exec, query, workerClaude: () => binary }))).rejects.toThrow(/--scripted takes no value/)
    await expect(run(["probe-hooks", "--scripted"], out, deps({ exec, query, workerClaude: () => null }))).rejects.toThrow(/Agent SDK's claude is missing.*npm ci/)

    // The real-model probe, as before, now recorded beside the scripted one. A throwaway HOME: it looks for a Claude token there.
    const savedHome = process.env.HOME
    process.env.HOME = root
    try {
      const model = async () => (() =>
        (async function* () {
          yield { type: "system", subtype: "init", apiKeySource: "none", plugins: [{ name: "dev-tasks", path: "/p" }] }
          yield { type: "user", message: { content: [{ type: "tool_result", content: "BLOCKED: Destructive command detected: 'git reset --hard'" }] } }
          yield { type: "user", message: { content: [{ type: "tool_result", content: "Workers never push. The launcher pushes your commits after you report." }] } }
        })()) as unknown as AgentctlDeps["query"] extends () => Promise<infer Q> ? Q : never
      expect(await run(["probe-hooks"], out, deps({ exec, query: model, workerClaude: () => binary }))).toBe(0)
      expect(JSON.parse(printed.at(-1)!)).toEqual({ pluginHookFired: true, workerGuardFired: true, loadedPlugins: ["dev-tasks"], apiKeySource: "none" })
      const both = JSON.parse(readFileSync(join(root, "state", "hooks-probe.json"), "utf8"))
      expect(both.model).toMatchObject({ kind: "model", ok: true, claudePath: binary, claudeVersion: "2.1.281 (Claude Code)", apiKeySource: "none" })
      expect(both.scripted).toMatchObject({ kind: "scripted", ok: true })
    } finally {
      process.env.HOME = savedHome
    }
  })

  it("retries a blocked job as a new one on its issue, for a person only", async () => {
    const done = (id: string, status: string) => {
      mkdirSync(join(root, "jobs", "done"), { recursive: true })
      writeFileSync(
        join(root, "jobs", "done", `${id}.json`),
        JSON.stringify({ id, issue: id.replace(/-\d{14}$/, ""), kind: "develop", model: "opus", submittedAt: NOW.toISOString(), result: { status, reason: "the report has no PR title" } }),
      )
    }
    done("STEP-3184-20260925071840", "blocked")
    done("STEP-5-20260925060000", "done")
    await expect(run(["retry", "STEP-3184-20260925071840"], out, deps({ env: { AGENTD_FRONT_DOOR: "1" } }))).rejects.toThrow(/for a person at a terminal/)
    await expect(run(["retry", "STEP-3184-20260925071840"], out, deps({ isTTY: () => false }))).rejects.toThrow(/for a person at a terminal/)
    expect(await run(["retry", "STEP-3184-20260925071840"], out, deps())).toBe(0)
    expect(listJobs(agentPaths(), "pending")).toEqual([
      expect.objectContaining({ issue: "STEP-3184", model: "opus", retryOf: "STEP-3184-20260925071840" }),
    ])
    await expect(run(["retry", "STEP-3184-20260925071840"], out, deps())).rejects.toThrow(/already pending/)
    await expect(run(["retry", "STEP-5-20260925060000"], out, deps())).rejects.toThrow(/ended done: only a blocked job is retried/)
    await expect(run(["retry", "STEP-6-20260925060000"], out, deps())).rejects.toThrow(/no finished job STEP-6-20260925060000/)
    for (const bad of [[], ["../../config"], ["STEP-3184"], ["a", "b"]]) await expect(run(["retry", ...bad], out, deps()), bad.join(" ")).rejects.toBeInstanceOf(UsageError)
  })

  it("probes only the front door's own claude: the record is what agentd starts it on", async () => {
    writeConfig()
    await expect(run(["probe-sandbox", "--claude", "/elsewhere/claude"], out, deps())).rejects.toThrow(/front door's own claude/)
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

describe("agentctl retro (STEP-3290)", () => {
  it("prints the PR body the weekly retro would open, and its Slack summary, and runs nothing", async () => {
    writeConfig()
    const f = fakeExec([[/^gh pr list /, { stdout: "[]" }]])
    expect(await run(["retro"], out, deps({ exec: f.exec }))).toBe(0)
    const text = printed.join("\n")
    expect(text).toContain("Weekly retro by eve, the week to 2026-09-24 (STEP-3290).")
    expect(text).toContain("| First-pass merges | none | none |")
    expect(text).toContain("## Slack, once it has run")
    expect(f.lines().every((l) => l.startsWith("gh pr list "))).toBe(true)
    expect(listNew(agentPaths().outbox)).toEqual([])
    expect(existsSync(join(root, "state", "retro.json"))).toBe(false)
  })

  it("starts the real one only for a person at a terminal, never for the front door", async () => {
    writeConfig()
    await expect(run(["retro", "--run"], out, deps({ isTTY: () => false }))).rejects.toThrow(/for a person at a terminal/)
    await expect(run(["retro", "--run"], out, deps({ env: { AGENTD_FRONT_DOOR: "1" } }))).rejects.toThrow(/for a person at a terminal/)
    expect(existsSync(join(root, "state", "retro.json"))).toBe(false)
  })
})
