import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew, putOnce, writeJsonAtomic } from "../../fsq.ts"
import { listJobs, recordPr, submitJob } from "../../jobs.ts"
import { parseInstruction } from "../../slack/instruction.ts"
import type { Logger } from "../../log.ts"
import { fakeExec, fakeTracker } from "../../__tests__/fakes.ts"
import { recordSandboxProbe } from "../../cli/sandbox-probe.ts"
import { frontDoorSettingsPath } from "../frontdoor.ts"
import { Every } from "../health.ts"
import { checkLocal, freshMemo, killGroup, runDuties, type DutyDeps } from "../main.ts"

const CONFIG = { mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] } }
const RUNTIME = fileURLToPath(new URL("../../..", import.meta.url))

function home(profileMini: string | null) {
  const h = mkdtempSync(join(tmpdir(), "agentd-home-"))
  mkdirSync(join(h, ".agentd"), { recursive: true })
  writeFileSync(join(h, ".agentd", "config.json"), JSON.stringify(CONFIG))
  mkdirSync(join(h, ".claude"))
  writeFileSync(join(h, ".claude", "dev-tasks-profile.json"), JSON.stringify({ profile: "agent", devSurface: "preview", mini: profileMini }))
  return h
}

function secret(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o600)
}

// A key exported in the shell that runs the tests would skip the key file check.
const inherited = process.env.LINEAR_API_KEY
beforeEach(() => {
  delete process.env.LINEAR_API_KEY
})
afterEach(() => {
  if (inherited === undefined) delete process.env.LINEAR_API_KEY
  else process.env.LINEAR_API_KEY = inherited
})

/** agentd as launchd runs it, with the mini from the real hooks/lib/profile.sh, and no Linear, tmux or Sentry in reach. */
const runAgentd = (h: string) =>
  spawnSync(join(RUNTIME, "node_modules", ".bin", "tsx"), [join(RUNTIME, "src", "agentd", "main.ts")], {
    cwd: h,
    env: { PATH: process.env.PATH ?? "", HOME: h },
    encoding: "utf8",
    timeout: 30_000,
  })

describe("runDuties", () => {
  const NOW = new Date("2026-09-24T12:00:00.000Z")
  const SHA = "0123456789abcdef0123456789abcdef01234567"

  function duties(over: Partial<DutyDeps> = {}) {
    const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-duties-")))
    const config = ConfigSchema.parse({ ...CONFIG, repo: { path: "/r" } })
    const f = fakeExec([
      [/ls-remote/, { stdout: `${SHA}\trefs/heads/staging\n` }],
      [/ --version$/, { stdout: "2.1.281 (Claude Code)\n" }],
    ])
    // A mini where the front door may start: its settings, and the sandbox probe passed on its claude.
    mkdirSync(paths.state, { recursive: true })
    writeFileSync(frontDoorSettingsPath(paths), JSON.stringify({ sandbox: { enabled: true, allowUnsandboxedCommands: false } }))
    recordSandboxProbe(paths, { at: NOW.toISOString(), claudePath: "claude", claudeVersion: "2.1.281 (Claude Code)", ok: true, checks: [] })
    let t = NOW.getTime()
    const problems: string[][] = []
    const log: Logger = {
      info() {},
      warn: (msg, fields) => {
        if (msg === "unhealthy") problems.push((fields as { problems: string[] }).problems)
      },
      error() {},
    }
    const checkIns: string[] = []
    const d: DutyDeps = {
      paths, config, log, exec: f.exec, tracker: fakeTracker([]).tracker, now: () => new Date(t), every: new Every(() => t),
      bootAt: new Date(NOW.getTime() - 86_400_000), liveness: () => "ours", kill: () => {}, spawnWorker: () => 5001,
      sentryUrl: null,
      checkIn: async (url) => {
        checkIns.push(url)
        return { ok: true, status: 200 }
      },
      ...over,
    }
    const bridge = (outboxFailed: number) =>
      writeJsonAtomic(join(paths.state, "bridge.json"), { at: new Date(t).toISOString(), connected: true, outboxWaiting: 0, outboxFailed })
    return { d, f, paths, problems, checkIns, bridge, advance: (minutes: number) => void (t += minutes * 60_000) }
  }

  it("acts on a person's Slack reply in the same pass, and starts the revise job it queues (STEP-3285)", async () => {
    const pr = "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1679"
    const view = { url: pr, number: 1679, state: "OPEN", headRefName: "STEP-7-fix-the-date", headRefOid: "abc", baseRefName: "staging", statusCheckRollup: [] }
    const spawned: string[] = []
    const f = fakeExec([
      [/^gh pr view /, { stdout: JSON.stringify(view) }],
      [/ls-remote/, { stdout: `${SHA}\trefs/heads/staging\n` }],
      [/ --version$/, { stdout: "2.1.281 (Claude Code)\n" }],
    ])
    const { d, paths } = duties({ exec: f.exec, spawnWorker: (id) => (spawned.push(id), 5001) })
    recordPr(paths, { issue: "STEP-7", url: pr, openedAt: NOW.toISOString() })
    putOnce(paths.inbox, "instr:CQ:1700.5", {
      type: "instruction", key: "instr:CQ:1700.5", issue: "STEP-7", channel: "CQ", ts: "1700.5", threadTs: "1700.1",
      user: "UNATE", userName: "Nate", text: "take care of it", ...parseInstruction("take care of it"), receivedAt: NOW.toISOString(),
    })
    await runDuties(d, freshMemo())
    expect(listJobs(paths, "running")).toEqual([expect.objectContaining({ issue: "STEP-7", kind: "revise" })])
    expect(spawned).toEqual([listJobs(paths, "running")[0].id])
    expect(listNew<{ kind: string; text?: string }>(paths.outbox).map((e) => e.payload.kind)).toEqual(["reply", "react"])
  })

  it("refreshes the checkout and cleans up only while no job is pending or running", async () => {
    const busy = duties()
    submitJob(busy.paths, "STEP-1", null, NOW)
    await runDuties(busy.d, freshMemo())
    expect(busy.f.lines().some((l) => l.includes(" ls-remote ") || l.includes(" worktree prune"))).toBe(false)

    // Paused, a pending job never starts: waiting is enough to hold the housekeeping back.
    const waiting = duties()
    mkdirSync(waiting.paths.root, { recursive: true })
    writeFileSync(waiting.paths.pauseFile, "")
    submitJob(waiting.paths, "STEP-1", null, NOW)
    await runDuties(waiting.d, freshMemo())
    expect(waiting.f.lines().some((l) => l.includes(" ls-remote ") || l.includes(" worktree prune"))).toBe(false)

    const idle = duties()
    await runDuties(idle.d, freshMemo())
    expect(idle.f.lines().some((l) => l.includes(" ls-remote "))).toBe(true)
    expect(idle.f.lines().some((l) => l.includes(" worktree prune"))).toBe(true)
  })

  it("checks in to Sentry only when a check-in URL is configured", async () => {
    const without = duties()
    await runDuties(without.d, freshMemo())
    expect(without.checkIns).toEqual([])
    const withUrl = duties({ sentryUrl: "https://o1.ingest.de.sentry.io/api/2/cron/eve-mini/k/" })
    await runDuties(withUrl.d, freshMemo())
    expect(withUrl.checkIns).toEqual([expect.stringMatching(/^https:\/\/o1\.ingest\.de\.sentry\.io\/api\/2\/cron\/eve-mini\/k\/\?status=(ok|error)$/)])
  })

  it("says nothing of a front door it has just started, as after a reboot", async () => {
    const { d, problems, bridge } = duties()
    bridge(0)
    await runDuties(d, freshMemo())
    expect(problems.flat().filter((p) => p.includes("front door"))).toEqual([])
  })

  it("keeps why it would not start the front door, and says it once", async () => {
    const errors: string[] = []
    const { d, paths } = duties()
    const log: Logger = { info() {}, warn() {}, error: (msg) => void errors.push(msg) }
    writeFileSync(frontDoorSettingsPath(paths), "{ not json")
    const memo = freshMemo()
    await runDuties({ ...d, log }, memo)
    await runDuties({ ...d, log }, memo)
    expect(memo.frontDoorRefused).toMatch(/not valid JSON/)
    expect(errors.filter((m) => m === "front door not started")).toHaveLength(1)
    // The mini stays paused meanwhile, with the reason, as agentctl pause would write it.
    expect(JSON.parse(readFileSync(paths.pauseFile, "utf8")).reason).toMatch(/^the front door was not started: .*not valid JSON/)
    writeFileSync(frontDoorSettingsPath(paths), JSON.stringify({ sandbox: { enabled: true, allowUnsandboxedCommands: false } }))
    await runDuties({ ...d, log }, memo)
    expect(memo.frontDoorRefused).toBeNull()
  })

  it("keeps a pause a person set when it will not start the front door", async () => {
    const { d, paths } = duties()
    writeFileSync(paths.pauseFile, JSON.stringify({ at: NOW.toISOString(), reason: "a person" }))
    rmSync(frontDoorSettingsPath(paths))
    await runDuties(d, freshMemo())
    expect(JSON.parse(readFileSync(paths.pauseFile, "utf8")).reason).toBe("a person")
  })

  it("reports messages Slack refused for good only when their count grows past what it first saw", async () => {
    const { d, problems, bridge, advance } = duties()
    const memo = freshMemo()
    bridge(2)
    await runDuties(d, memo)
    expect(problems.flat().some((p) => p.startsWith("Slack refused"))).toBe(false)
    advance(5)
    bridge(3)
    await runDuties(d, memo)
    expect(problems.flat()).toContain("Slack refused 1 more message for good, kept in ~/.agentd/outbox/failed")
  })

  it("reports a checkout the refresh had to leave alone", async () => {
    const { d, problems } = duties({ exec: fakeExec([[/status --porcelain/, { stdout: " M lib/x.ts\n" }]]).exec })
    await runDuties(d, freshMemo())
    expect(problems.flat()).toContain("the main checkout has local changes, so it is no longer kept on origin's base")
  })
})

describe("killGroup", () => {
  it("ignores a group that has already gone, and nothing else", () => {
    // Signal 0 only asks: nothing is delivered to anyone.
    expect(() => killGroup(-999999, 0)).not.toThrow()
    expect(() => killGroup(1, 0)).toThrow(/EPERM/)
  })
})

describe("starting agentd", () => {
  it("refuses when config.json and the machine profile name different minis, before it reads a secret (decision 2)", () => {
    // No Linear key exists: an error about it would mean the check came too late.
    const paths = agentPaths(home("alice"))
    expect(() => checkLocal(paths, "alice")).toThrow(/mini "eve".*mini "alice"/)
    expect(() => checkLocal(paths, null)).toThrow(/mini "eve".*no mini/)
    // The same config with the profile's agreement gets past the check, to the missing key.
    expect(() => checkLocal(paths, "eve")).toThrow(/^secrets: /)
  })

  it("reads the config and the optional Sentry check-in URL, and nothing of Slack's", () => {
    const h = home("eve")
    secret(join(h, ".config", "linear", ".env"), "LINEAR_API_KEY=lin_api_test\n")
    expect(checkLocal(agentPaths(h), "eve")).toMatchObject({ config: { mini: "eve" }, sentryUrl: null })
    secret(join(h, ".config", "agentd", "agentd.env"), "SENTRY_CRON_URL=https://o1.ingest.de.sentry.io/api/2/cron/eve-mini/k/\n")
    expect(checkLocal(agentPaths(h), "eve").sentryUrl).toBe("https://o1.ingest.de.sentry.io/api/2/cron/eve-mini/k/")
  })

  it("as a process, records the refusal in agentd.json and exits 0 so launchd leaves it stopped", () => {
    const h = home("alice")
    const run = runAgentd(h)
    expect(run.status).toBe(0)
    const status = JSON.parse(readFileSync(join(h, ".agentd", "state", "agentd.json"), "utf8"))
    expect(status).toMatchObject({ pid: expect.any(Number), error: expect.stringMatching(/mini "eve".*mini "alice"/) })
  }, 30_000)

  it("as a process, will not run beside another agentd, and leaves that one's agentd.json alone", () => {
    // A live process whose command line names agentd holds the lock, as launchd's would.
    const h = home("eve")
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "src/agentd/main.ts"], { stdio: "ignore" })
    try {
      mkdirSync(join(h, ".agentd", "state"), { recursive: true })
      writeFileSync(join(h, ".agentd", "state", "agentd.pid"), String(other.pid))
      const run = runAgentd(h)
      expect(run.status).toBe(1)
      expect(run.stderr).toMatch(new RegExp(`another agentd is running here, pid ${other.pid}`))
      expect(() => readFileSync(join(h, ".agentd", "state", "agentd.json"), "utf8")).toThrow(/ENOENT/)
    } finally {
      other.kill()
    }
  }, 30_000)
})
