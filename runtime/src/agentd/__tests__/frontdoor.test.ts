import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew } from "../../fsq.ts"
import type { Logger } from "../../log.ts"
import type { UsageSnapshot } from "../../usage.ts"
import { fakeExec } from "../../__tests__/fakes.ts"
import { recordSandboxProbe } from "../../cli/sandbox-probe.ts"
import type { ExecResult } from "../../worker/git.ts"
import {
  adoptSessionId,
  applyFrontDoor,
  claudeCommand,
  decideFrontDoor,
  FRESH_FRONT_DOOR,
  frontDoorAlive,
  FrontDoorRefused,
  frontDoorSettingsPath,
  readFrontDoorState,
  shellQuote,
  superviseFrontDoor,
  type FrontDoorState,
} from "../frontdoor.ts"

const NOW = new Date("2026-09-24T12:00:00.000Z")
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()
const state = (over: Partial<FrontDoorState> = {}): FrontDoorState => ({ ...FRESH_FRONT_DOOR, sessionId: "s-1", lastStartAt: minutesAgo(300), starts: [], ...over })
const input = (over: Record<string, unknown> = {}) => ({ now: NOW, alive: true, lastTickAt: new Date(minutesAgo(2)), state: state(), usage: null, staleTickMinutes: 45, ...over })

describe("decideFrontDoor", () => {
  it("starts a new session the first time", () => {
    expect(decideFrontDoor(input({ alive: false, state: FRESH_FRONT_DOOR, lastTickAt: null }))).toEqual({ kind: "start", mode: "new", reason: "first start", fastExits: 0 })
  })

  it("resumes the session after it exits, and starts fresh after two exits right after starting", () => {
    expect(decideFrontDoor(input({ alive: false }))).toMatchObject({ kind: "start", mode: "resume", fastExits: 0 })
    const justStarted = state({ lastStartAt: new Date(NOW.getTime() - 30_000).toISOString(), fastExits: 1 })
    expect(decideFrontDoor(input({ alive: false, state: justStarted }))).toMatchObject({ kind: "start", mode: "new", fastExits: 2 })
  })

  it("does nothing while it wakes up, including the first minutes after a start", () => {
    expect(decideFrontDoor(input())).toEqual({ kind: "none" })
    expect(decideFrontDoor(input({ lastTickAt: null, state: state({ lastStartAt: minutesAgo(3) }) }))).toEqual({ kind: "none" })
  })

  it("types the loop prompt in once when no wakeup follows a start within five minutes", () => {
    const started = state({ lastStartAt: minutesAgo(6) })
    expect(decideFrontDoor(input({ lastTickAt: new Date(minutesAgo(60)), state: started }))).toMatchObject({ kind: "kick" })
    expect(decideFrontDoor(input({ lastTickAt: new Date(minutesAgo(60)), state: { ...started, kickedAt: minutesAgo(1) } }))).toEqual({ kind: "none" })
    expect(decideFrontDoor(input({ lastTickAt: new Date(minutesAgo(1)), state: started }))).toEqual({ kind: "none" })
  })

  it("restarts a session that stopped waking up", () => {
    expect(decideFrontDoor(input({ lastTickAt: new Date(minutesAgo(50)) }))).toEqual({ kind: "restart", reason: "no wakeup for 50 minutes" })
  })

  it("waits for the usage limit to reset instead of restarting into it", () => {
    const resetsAt = NOW.getTime() / 1000 + 1800
    const usage = { at: NOW.toISOString(), fiveHourPct: 100, fiveHourResetsAt: resetsAt, sevenDayPct: 40, sevenDayResetsAt: resetsAt + 86_400 }
    expect(decideFrontDoor(input({ lastTickAt: new Date(minutesAgo(50)), usage }))).toMatchObject({
      kind: "wait", until: new Date(resetsAt * 1000 + 60_000).toISOString(), alert: false,
    })
  })

  it("stops trying for 30 minutes after three starts in an hour, and says so", () => {
    const busy = state({ starts: [minutesAgo(50), minutesAgo(30), minutesAgo(5)] })
    expect(decideFrontDoor(input({ alive: false, state: busy }))).toMatchObject({ kind: "wait", alert: true, until: new Date(NOW.getTime() + 30 * 60_000).toISOString() })
    expect(decideFrontDoor(input({ alive: false, state: { ...busy, waitUntil: minutesAgo(-10) } }))).toEqual({ kind: "none" })
  })
})

describe("adoptSessionId", () => {
  const usage = (sessionId: string, at: string): UsageSnapshot => ({ at, sessionId, fiveHourPct: null, fiveHourResetsAt: null, sevenDayPct: null, sevenDayResetsAt: null })

  it("takes the id the status line reports after the last start", () => {
    expect(adoptSessionId(state({ sessionId: null, lastStartAt: minutesAgo(5) }), usage("s-2", minutesAgo(4))).sessionId).toBe("s-2")
  })

  it("ignores a report from before the last start, and no report at all", () => {
    const s = state({ sessionId: null, lastStartAt: minutesAgo(5) })
    expect(adoptSessionId(s, usage("s-old", minutesAgo(9)))).toBe(s)
    expect(adoptSessionId(s, null)).toBe(s)
  })

  it("ignores the previous id that a person's own session wrote back after the start", () => {
    // Any session on the mini records the limits and keeps the front door's
    // id and its time as it found them (bin/statusline.sh).
    const s = state({ sessionId: null, lastStartAt: minutesAgo(5) })
    expect(adoptSessionId(s, { ...usage("s-old", minutesAgo(1)), sessionAt: minutesAgo(9) })).toBe(s)
    expect(adoptSessionId(s, { ...usage("s-new", minutesAgo(1)), sessionAt: minutesAgo(2) }).sessionId).toBe("s-new")
  })
})

describe("claudeCommand", () => {
  it("opens the Slack channel as an approved one, never a development one that asks for a confirmation at every start (STEP-3293)", () => {
    const base = { claudePath: "claude", resumeId: null, model: "sonnet", settingsPath: "/s.json" }
    const on = claudeCommand({ ...base, channel: true })
    expect(on).toBe("claude --channels plugin:dev-tasks@dev-tasks-marketplace --settings /s.json --model sonnet --permission-mode auto --permission-prompts none '/loop /dev-tasks:front-door'")
    expect(on).not.toMatch(/dangerously|development-channels/)
    expect(claudeCommand({ ...base, channel: false })).not.toContain("--channels")
  })

  it("resumes with the model, auto mode, no prompts, and re-arms the loop", () => {
    expect(claudeCommand({ claudePath: "/Users/eve/.local/bin/claude", resumeId: "0f3c", model: "sonnet", settingsPath: "/Users/eve/.agentd/front-door-settings.json" })).toBe(
      "/Users/eve/.local/bin/claude --resume 0f3c --settings /Users/eve/.agentd/front-door-settings.json --model sonnet --permission-mode auto --permission-prompts none '/loop /dev-tasks:front-door'",
    )
  })

  it("starts a new session without pinning an id", () => {
    expect(claudeCommand({ claudePath: "claude", resumeId: null, model: "sonnet", settingsPath: "/s.json" })).toBe(
      "claude --settings /s.json --model sonnet --permission-mode auto --permission-prompts none '/loop /dev-tasks:front-door'",
    )
  })

  it("quotes anything a shell would split", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote("/plain/path-1.2")).toBe("/plain/path-1.2")
    expect(shellQuote("$(touch x)")).toBe("'$(touch x)'")
  })
})

const quiet: Logger = { info() {}, warn() {}, error() {} }

const VERSION = "2.1.281 (Claude Code)"

/** A mini where the front door may start: its settings rendered, and the sandbox probe passed on the installed claude. */
function setup(responses: Array<[RegExp, Partial<ExecResult>]> = []) {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-fd-")))
  const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/Users/eve/polads" }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] }, frontDoor: { claudePath: "/usr/local/bin/claude" } })
  mkdirSync(paths.state, { recursive: true })
  writeFileSync(frontDoorSettingsPath(paths), JSON.stringify({ sandbox: { enabled: true, allowUnsandboxedCommands: false } }))
  recordSandboxProbe(paths, { at: NOW.toISOString(), claudePath: "/usr/local/bin/claude", claudeVersion: VERSION, ok: true, checks: [] })
  const exec = fakeExec([...responses, [/ --version$/, { stdout: `${VERSION}\n` }]])
  // The version check before each start is not what these tests look at.
  const f = { ...exec, lines: () => exec.lines().filter((l) => !l.endsWith(" --version")) }
  return { paths, config, f, deps: { paths, config, exec: exec.exec, now: () => NOW, log: quiet } }
}

describe("frontDoorAlive", () => {
  it("asks tmux for the session by its exact name, since a bare name also matches frontdoor-old", async () => {
    const alive = setup()
    expect(await frontDoorAlive(alive.deps)).toBe(true)
    expect(alive.f.lines()).toEqual(["tmux -L agentd has-session -t =frontdoor"])
    const gone = setup([[/has-session/, { code: 1, stderr: "can't find session: =frontdoor" }]])
    expect(await frontDoorAlive(gone.deps)).toBe(false)
  })

  it("runs the tmux that install.sh recorded, on the front door's own server", async () => {
    // A LaunchAgent gets no login shell's PATH, and a server a person started
    // would hand the front door that person's shell environment.
    const { f, deps } = setup()
    const config = { ...deps.config, frontDoor: { ...deps.config.frontDoor, tmuxPath: "/opt/homebrew/bin/tmux" } }
    await frontDoorAlive({ ...deps, config })
    await applyFrontDoor({ ...deps, config }, FRESH_FRONT_DOOR, { kind: "start", mode: "new", reason: "first start", fastExits: 0 })
    expect(f.lines().map((l) => l.split(" ").slice(0, 3).join(" "))).toEqual(["/opt/homebrew/bin/tmux -L agentd", "/opt/homebrew/bin/tmux -L agentd"])
  })
})

describe("applyFrontDoor", () => {
  it("starts a new session in tmux in the PolAds checkout and records it", async () => {
    const { f, deps, paths } = setup()
    const next = await applyFrontDoor(deps, FRESH_FRONT_DOOR, { kind: "start", mode: "new", reason: "first start", fastExits: 0 })
    // Its own settings file, which install.sh renders: a person's own sessions keep the user's settings.
    expect(f.lines()[0]).toBe(
      `tmux -L agentd new-session -d -s frontdoor -e AGENTD_FRONT_DOOR=1 -x 220 -y 60 -c /Users/eve/polads /usr/local/bin/claude --channels plugin:dev-tasks@dev-tasks-marketplace --settings ${paths.root}/front-door-settings.json --model sonnet --permission-mode auto --permission-prompts none '/loop /dev-tasks:front-door'`,
    )
    expect(next).toMatchObject({ sessionId: null, lastStartAt: NOW.toISOString(), starts: [NOW.toISOString()], waitUntil: null, kickedAt: null })
  })

  it("kills the stuck session before resuming it", async () => {
    const { f, deps } = setup()
    await applyFrontDoor(deps, state(), { kind: "restart", reason: "no wakeup for 50 minutes" })
    expect(f.lines()[0]).toBe("tmux -L agentd kill-session -t =frontdoor")
    expect(f.lines()[1]).toContain("--resume s-1")
  })

  it("types the loop prompt, then Enter, into the session for a kick", async () => {
    const { f, deps } = setup()
    const next = await applyFrontDoor(deps, state(), { kind: "kick", reason: "no wakeup in the 5 minutes since the start" })
    expect(f.lines()).toEqual(["tmux -L agentd send-keys -t =frontdoor: -l /loop /dev-tasks:front-door", "tmux -L agentd send-keys -t =frontdoor: Enter"])
    expect(next.kickedAt).toBe(NOW.toISOString())
  })

  it("posts a waiting alert at most once an hour", async () => {
    const { paths, deps } = setup()
    const action = { kind: "wait" as const, until: "2026-09-24T12:30:00.000Z", reason: "the front door exited 3 times in the last hour", alert: true }
    const first = await applyFrontDoor(deps, state(), action)
    await applyFrontDoor(deps, first, action)
    const posts = listNew<{ text: string }>(paths.outbox)
    expect(posts).toHaveLength(1)
    expect(posts[0].payload.text).toBe("The front door exited 3 times in the last hour. Trying again at 14:30 (Europe/Copenhagen).")
    expect(first.waitUntil).toBe("2026-09-24T12:30:00.000Z")
  })

  it("tries again at the time it announced after three quick exits, not an hour later", async () => {
    const { deps } = setup()
    const busy = state({ starts: [minutesAgo(3), minutesAgo(2), minutesAgo(1)], lastStartAt: minutesAgo(1) })
    const action = decideFrontDoor(input({ alive: false, state: busy }))
    expect(action).toMatchObject({ kind: "wait", alert: true })
    const waited = await applyFrontDoor(deps, busy, action)
    const later = new Date(NOW.getTime() + 31 * 60_000)
    expect(decideFrontDoor({ ...input({ alive: false, state: waited }), now: later })).toMatchObject({ kind: "start" })
  })

  it("starts nothing, and kills nothing, while the settings or the sandbox probe are not right", async () => {
    // claude refuses a missing settings file, but starts on an unparseable one
    // with no sandbox and no deny rules, and the sandbox leans on how the
    // claude it runs treats them.
    const cases: Array<[string, (paths: ReturnType<typeof setup>["paths"]) => void, RegExp]> = [
      ["unparseable", (p) => writeFileSync(frontDoorSettingsPath(p), "{ not json"), /not valid JSON/],
      ["sandbox off", (p) => writeFileSync(frontDoorSettingsPath(p), JSON.stringify({ sandbox: { enabled: false } })), /does not turn the sandbox on/],
      ["escape hatch", (p) => writeFileSync(frontDoorSettingsPath(p), JSON.stringify({ sandbox: { enabled: true } })), /allowUnsandboxedCommands false/],
      ["no probe", (p) => rmSync(join(p.state, "sandbox-probe.json")), /has not passed on \/usr\/local\/bin\/claude, 2\.1\.281.*agentctl probe-sandbox/],
      [
        "another binary probed",
        (p) => recordSandboxProbe(p, { at: NOW.toISOString(), claudePath: "/elsewhere/claude", claudeVersion: VERSION, ok: true, checks: [] }),
        /last probe passed on 2\.1\.281 .*\/elsewhere\/claude/,
      ],
      [
        "an updated claude",
        (p) => recordSandboxProbe(p, { at: NOW.toISOString(), claudePath: "/usr/local/bin/claude", claudeVersion: "2.1.278 (Claude Code)", ok: true, checks: [] }),
        /last probe passed on 2\.1\.278/,
      ],
      ["a failed probe", (p) => recordSandboxProbe(p, { at: NOW.toISOString(), claudePath: "/usr/local/bin/claude", claudeVersion: VERSION, ok: false, checks: [] }), /last probe failed/],
    ]
    for (const [name, spoil, why] of cases) {
      const { f, deps, paths } = setup()
      spoil(paths)
      await expect(applyFrontDoor(deps, state(), { kind: "restart", reason: "no wakeup for 50 minutes" }), name).rejects.toThrow(FrontDoorRefused)
      await expect(applyFrontDoor(deps, state(), { kind: "restart", reason: "no wakeup for 50 minutes" }), name).rejects.toThrow(why)
      expect(f.lines(), name).toEqual([])
    }
  })

  it("throws with tmux's own words when the session cannot start", async () => {
    const { deps } = setup([[/new-session/, { code: 1, stderr: "no server running on /private/tmp/tmux-501/default\n" }]])
    await expect(applyFrontDoor(deps, FRESH_FRONT_DOOR, { kind: "start", mode: "new", reason: "first start", fastExits: 0 })).rejects.toThrow(
      "tmux new-session failed (1): no server running on /private/tmp/tmux-501/default",
    )
  })
})

describe("superviseFrontDoor", () => {
  it("starts the front door when it is not running, then adopts the session id the status line reports", async () => {
    const down = setup([[/has-session/, { code: 1 }]])
    expect(await superviseFrontDoor({ ...down.deps, usage: () => null })).toMatchObject({ kind: "start", mode: "new" })
    expect(readFrontDoorState(down.paths)).toMatchObject({ sessionId: null, lastStartAt: NOW.toISOString() })

    // A minute later it runs, and the status line has reported its id.
    const up = { ...setup(), paths: down.paths }
    const later = new Date(NOW.getTime() + 60_000)
    mkdirSync(up.paths.state, { recursive: true })
    writeFileSync(join(up.paths.state, "frontdoor-tick.json"), JSON.stringify({ at: later.toISOString() }))
    const usage: UsageSnapshot = { at: later.toISOString(), sessionId: "s-9", fiveHourPct: null, fiveHourResetsAt: null, sevenDayPct: null, sevenDayResetsAt: null }
    expect(await superviseFrontDoor({ ...up.deps, paths: down.paths, now: () => later, usage: () => usage })).toEqual({ kind: "none" })
    expect(readFrontDoorState(down.paths).sessionId).toBe("s-9")
  })
})
