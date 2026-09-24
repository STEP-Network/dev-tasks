import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew } from "../../fsq.ts"
import type { Logger } from "../../log.ts"
import type { UsageSnapshot } from "../../usage.ts"
import { fakeExec } from "../../__tests__/fakes.ts"
import {
  adoptSessionId,
  applyFrontDoor,
  claudeCommand,
  decideFrontDoor,
  FRESH_FRONT_DOOR,
  frontDoorAlive,
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
})

describe("claudeCommand", () => {
  it("resumes with the model, auto mode, no prompts, and re-arms the loop", () => {
    expect(claudeCommand({ claudePath: "/Users/eve/.local/bin/claude", resumeId: "0f3c", model: "sonnet" })).toBe(
      "/Users/eve/.local/bin/claude --resume 0f3c --model sonnet --permission-mode auto --permission-prompts none '/loop /dev-tasks:front-door'",
    )
  })

  it("starts a new session without pinning an id", () => {
    expect(claudeCommand({ claudePath: "claude", resumeId: null, model: "sonnet" })).toBe(
      "claude --model sonnet --permission-mode auto --permission-prompts none '/loop /dev-tasks:front-door'",
    )
  })

  it("quotes anything a shell would split", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'")
    expect(shellQuote("/plain/path-1.2")).toBe("/plain/path-1.2")
    expect(shellQuote("$(touch x)")).toBe("'$(touch x)'")
  })
})

const quiet: Logger = { info() {}, warn() {}, error() {} }

function setup(responses: Parameters<typeof fakeExec>[0] = []) {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-fd-")))
  const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/Users/eve/polads" }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] }, frontDoor: { claudePath: "/usr/local/bin/claude" } })
  const f = fakeExec(responses)
  return { paths, config, f, deps: { paths, config, exec: f.exec, now: () => NOW, log: quiet } }
}

describe("frontDoorAlive", () => {
  it("asks tmux for the session by its exact name, since a bare name also matches frontdoor-old", async () => {
    const alive = setup()
    expect(await frontDoorAlive(alive.deps)).toBe(true)
    expect(alive.f.lines()).toEqual(["tmux has-session -t =frontdoor"])
    const gone = setup([[/has-session/, { code: 1, stderr: "can't find session: =frontdoor" }]])
    expect(await frontDoorAlive(gone.deps)).toBe(false)
  })
})

describe("applyFrontDoor", () => {
  it("starts a new session in tmux in the PolAds checkout and records it", async () => {
    const { f, deps } = setup()
    const next = await applyFrontDoor(deps, FRESH_FRONT_DOOR, { kind: "start", mode: "new", reason: "first start", fastExits: 0 })
    expect(f.lines()[0]).toBe(
      "tmux new-session -d -s frontdoor -x 220 -y 60 -c /Users/eve/polads /usr/local/bin/claude --model sonnet --permission-mode auto --permission-prompts none '/loop /dev-tasks:front-door'",
    )
    expect(next).toMatchObject({ sessionId: null, lastStartAt: NOW.toISOString(), starts: [NOW.toISOString()], waitUntil: null, kickedAt: null })
  })

  it("kills the stuck session before resuming it", async () => {
    const { f, deps } = setup()
    await applyFrontDoor(deps, state(), { kind: "restart", reason: "no wakeup for 50 minutes" })
    expect(f.lines()[0]).toBe("tmux kill-session -t =frontdoor")
    expect(f.lines()[1]).toContain("--resume s-1")
  })

  it("types the loop prompt, then Enter, into the session for a kick", async () => {
    const { f, deps } = setup()
    const next = await applyFrontDoor(deps, state(), { kind: "kick", reason: "no wakeup in the 5 minutes since the start" })
    expect(f.lines()).toEqual(["tmux send-keys -t =frontdoor: -l /loop /dev-tasks:front-door", "tmux send-keys -t =frontdoor: Enter"])
    expect(next.kickedAt).toBe(NOW.toISOString())
  })

  it("posts a waiting alert at most once an hour", async () => {
    const { paths, deps } = setup()
    const action = { kind: "wait" as const, until: "2026-09-24T12:30:00.000Z", reason: "the front door exited 3 times in the last hour", alert: true }
    const first = await applyFrontDoor(deps, state(), action)
    await applyFrontDoor(deps, first, action)
    const posts = listNew<{ text: string }>(paths.outbox)
    expect(posts).toHaveLength(1)
    expect(posts[0].payload.text).toBe("front door: the front door exited 3 times in the last hour. Trying again at 12:30 UTC.")
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
