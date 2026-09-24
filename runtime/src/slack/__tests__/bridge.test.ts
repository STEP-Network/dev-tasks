import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { countIn, listNew, putOnce } from "../../fsq.ts"
import type { Logger } from "../../log.ts"
import { threadFor } from "../../threads.ts"
import { fakeTracker, issue } from "../../__tests__/fakes.ts"
import { checkLocal, exitCodeFor, handleEnvelope, fileIntake, resolveChannels, retryPending, wireSocket, type BridgeDeps, type BridgeWeb, type SocketHooks } from "../bridge.ts"
import type { SlackEnvelope } from "../classify.ts"
import { SlackAccessRefused } from "../send.ts"

const quiet: Logger = { info() {}, warn() {}, error() {} }

const CONFIG = { mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] } }

function setup(seed = [issue({ id: "STEP-7" })], failOn: string[] = []) {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-bridge-")))
  const fake = fakeTracker(seed, undefined, failOn)
  const web: BridgeWeb = {
    async postMessage() {
      return { ts: "1.1" }
    },
    async permalink(channel, ts) {
      return `https://step.slack.com/archives/${channel}/p${ts.replace(".", "")}`
    },
    async react() {},
    async userName(id) {
      return ({ UNATE: "Nate", UKARL: "Karl" } as Record<string, string>)[id] ?? id
    },
  }
  const deps: BridgeDeps = {
    paths,
    config: ConfigSchema.parse(CONFIG),
    tracker: fake.tracker,
    web,
    classifyContext: {
      teamId: "T1",
      botUserId: "UBOT",
      otherAgentBots: ["UOTHER"],
      allowedUsers: ["UNATE"],
      channels: { agents: "CAG", questions: "CQ", intake: "CIN", releases: "CREL" },
      issueForThread: (channel, ts) => (channel === "CQ" && ts === "1700.1" ? "STEP-7" : null),
    },
    log: quiet,
    now: () => new Date("2026-09-24T08:00:00.000Z"),
    busy: new Set(),
  }
  return { deps, fake, paths }
}

const mention = (type: string, text: string, extra: Record<string, unknown> = {}): SlackEnvelope => ({
  team_id: "T1",
  event: { type, user: "UNATE", channel: "CIN", ts: "1800.1", text, ...extra },
})

const outboxTexts = (paths: BridgeDeps["paths"]) => listNew<{ text?: string }>(paths.outbox).map((e) => e.payload.text)

describe("intake", () => {
  it("files one Triage issue per message, however many times Slack delivers it", async () => {
    const { deps, fake, paths } = setup()
    await handleEnvelope(deps, mention("app_mention", "<@UBOT> The date is wrong on notices"))
    await handleEnvelope(deps, mention("message", "<@UBOT> The date is wrong on notices"))
    await handleEnvelope(deps, mention("app_mention", "<@UBOT> The date is wrong on notices"))
    const created = fake.called("createIssue")
    expect(created).toHaveLength(1)
    expect(created[0][0]).toMatchObject({ title: "The date is wrong on notices", state: "Triage", labels: ["polads"] })
    const [entry] = listNew<{ type: string; issue: string }>(paths.inbox)
    expect(entry.payload).toMatchObject({ type: "intake", issue: "STEP-901", userName: "Nate" })
    expect(threadFor(paths, "STEP-901")).toMatchObject({ channelId: "CIN", ts: "1800.1" })
    expect(outboxTexts(paths)).toEqual(["filed STEP-901 https://linear.app/step/issue/STEP-901. I will refine it and answer here."])
  })

  it("puts an acknowledged delivery on disk before it asks Slack who sent it", async () => {
    // Slack will not send an acknowledged event again: while users.info waits, only the inbox holds it.
    const { deps, paths } = setup()
    deps.web.userName = () => new Promise(() => {})
    void handleEnvelope(deps, mention("app_mention", "<@UBOT> The date is wrong on notices"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(listNew(paths.inbox)[0].payload).toMatchObject({ type: "intake", user: "UNATE", userName: "UNATE", issue: null })
  })

  it("files nothing for a bare mention and asks for the request instead, naming this mini's bot", async () => {
    const { deps, fake, paths } = setup()
    await handleEnvelope(deps, mention("app_mention", "<@UBOT>"))
    expect(fake.called("createIssue")).toHaveLength(0)
    expect(listNew(paths.inbox)).toEqual([])
    expect(outboxTexts(paths)[0]).toMatch(/^Tell me what you need.*: @eve the notice page/)
  })

  it("files nothing for a message that mentions another agent's bot (decision 3)", async () => {
    const { deps, fake, paths } = setup()
    expect(await handleEnvelope(deps, mention("message", "<@UOTHER> The date is wrong on notices"))).toBe("ignore")
    expect(await handleEnvelope(deps, mention("app_mention", "<@UOTHER> The date is wrong on notices"))).toBe("ignore")
    expect(fake.called("createIssue")).toHaveLength(0)
    expect(listNew(paths.inbox)).toEqual([])
    expect(outboxTexts(paths)).toEqual([])
  })

  it("leaves a request that names another agent first to that agent, and answers it as a mention", async () => {
    const { deps, fake, paths } = setup()
    expect(await handleEnvelope(deps, mention("app_mention", "<@UOTHER> <@UBOT> The date is wrong on notices"))).toBe("mention")
    expect(fake.called("createIssue")).toHaveLength(0)
    expect(listNew(paths.inbox)[0].payload).toMatchObject({ type: "mention", threadTs: "1800.1" })
    expect(threadFor(paths, "STEP-901")).toBeNull()
  })

  it("files readable text: Slack's markup decoded and the people it mentions named", async () => {
    const { deps, fake } = setup()
    await handleEnvelope(deps, mention("app_mention", "<@UBOT> The <https://test.polads.eu/da|notice page> date &amp; time, as <@UKARL> saw"))
    expect(fake.called("createIssue")[0][0]).toMatchObject({
      title: "The notice page date & time, as @Karl saw",
      description: expect.stringMatching(/^The \[notice page\]\(https:\/\/test\.polads\.eu\/da\) date & time, as @Karl saw\n/),
    })
  })

  it("gives up on an intake Linear has refused for a whole day, and says so once", async () => {
    const { deps, paths } = setup([], ["createIssue"])
    putOnce(paths.inbox, "msg:CIN:1800.1", {
      type: "intake", key: "msg:CIN:1800.1", channel: "CIN", ts: "1800.1", user: "UNATE", userName: "Nate",
      text: "<@UBOT> The date is wrong", receivedAt: "2026-09-23T07:00:00.000Z",
      linearId: "11111111-2222-4333-8444-555555555555", issue: null, toldUnfiled: true,
    })
    await retryPending(deps)
    await retryPending(deps)
    expect(listNew(paths.inbox)).toEqual([])
    expect(countIn(paths.inbox, "failed")).toBe(1)
    expect(outboxTexts(paths)).toEqual(["Linear refused this for a whole day, so I have stopped trying to file it. Please ask again."])
  })

  it("keeps an intake Linear refused, tells the thread once, and files it on a later retry", async () => {
    const { deps, paths } = setup([], ["createIssue"])
    await handleEnvelope(deps, mention("app_mention", "<@UBOT> The date is wrong"))
    await retryPending(deps)
    expect(outboxTexts(paths)).toEqual(["Linear is unreachable right now. I will file this as soon as it is back."])
    deps.tracker = fakeTracker([]).tracker
    await retryPending(deps)
    expect(listNew<{ issue: string | null }>(paths.inbox)[0].payload.issue).toMatch(/^STEP-\d+$/)
  })

  it("tells the thread it filed the issue before it links the thread on Linear", async () => {
    // The reply is a local write; the link is a Linear call a crash can interrupt.
    const { deps, fake, paths } = setup()
    fake.tracker.attachLink = () => new Promise(() => {})
    void handleEnvelope(deps, mention("app_mention", "<@UBOT> The date is wrong on notices"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(outboxTexts(paths)).toEqual(["filed STEP-901 https://linear.app/step/issue/STEP-901. I will refine it and answer here."])
  })

  it("does not file twice after a crash between Linear creating the issue and the bridge recording it", async () => {
    const { deps, fake, paths } = setup([issue({ id: "STEP-50", uuid: "11111111-2222-4333-8444-555555555555" })])
    putOnce(paths.inbox, "msg:CIN:1800.1", {
      type: "intake", key: "msg:CIN:1800.1", channel: "CIN", ts: "1800.1", user: "UNATE", userName: "Nate",
      text: "<@UBOT> The date is wrong", receivedAt: "2026-09-24T07:59:00.000Z",
      linearId: "11111111-2222-4333-8444-555555555555", issue: null,
    })
    await fileIntake(deps, "msg:CIN:1800.1")
    expect(fake.called("createIssue")).toHaveLength(0)
    expect(listNew<{ issue: string }>(paths.inbox)[0].payload.issue).toBe("STEP-50")
  })

  it("does not file or reply twice when the one-minute retry fires while a delivery is still filing", async () => {
    const { deps, fake, paths } = setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const create = fake.tracker.createIssue
    fake.tracker.createIssue = async (input) => {
      await gate
      return create(input)
    }
    const live = handleEnvelope(deps, mention("app_mention", "<@UBOT> The date is wrong"))
    // Let the delivery run until it waits on Linear, then fire the retry, and let both finish.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const retry = retryPending(deps)
    await new Promise((resolve) => setTimeout(resolve, 20))
    release()
    await Promise.all([live, retry])
    expect(fake.called("createIssue")).toHaveLength(1)
    expect(outboxTexts(paths).filter((text) => text?.startsWith("filed"))).toHaveLength(1)
  })
})

describe("answers", () => {
  const reply = (ts: string, text: string): SlackEnvelope => ({
    team_id: "T1",
    event: { type: "message", user: "UNATE", channel: "CQ", ts, thread_ts: "1700.1", text },
  })

  it("apply to a parked issue once, put it back in Ready, and tick the reply", async () => {
    const { deps, fake, paths } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["polads", "agent-ready", "awaiting-answer"], description: "## Goal\n\nFix it." })])
    await handleEnvelope(deps, reply("1700.5", "Use the publication date"))
    await handleEnvelope(deps, reply("1700.5", "Use the publication date"))
    const updates = fake.called("updateIssue")
    expect(updates).toHaveLength(1)
    expect(updates[0][1]).toMatchObject({ state: "Ready", removeLabels: ["awaiting-answer"] })
    expect(fake.issues.get("STEP-7")!.description).toContain("**Nate** ([Slack](https://step.slack.com/archives/CQ/p17005)): Use the publication date")
    expect(listNew(paths.inbox)).toEqual([])
    expect(listNew<{ kind: string; name?: string }>(paths.outbox)[0].payload).toMatchObject({ kind: "react", name: "white_check_mark" })
  })

  it("keep both of two replies that arrive together, applying one at a time", async () => {
    // Each apply reads the description and writes it back: two at once would
    // both read the same text, and the second write would drop the first answer.
    const { deps, fake, paths } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["agent-ready", "awaiting-answer"], description: "## Goal\n\nFix it." })])
    const permalink = deps.web.permalink
    deps.web.permalink = (channel, ts) => new Promise((resolve) => setTimeout(() => resolve(permalink(channel, ts)), 20))
    await Promise.all([handleEnvelope(deps, reply("1700.5", "Use the publication date")), handleEnvelope(deps, reply("1700.6", "And the Danish label"))])
    await retryPending(deps)
    const description = fake.issues.get("STEP-7")!.description
    expect(description).toContain("Use the publication date")
    expect(description).toContain("And the Danish label")
    expect(listNew(paths.inbox)).toEqual([])
  })

  it("are written into the issue readably", async () => {
    const { deps, fake } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["agent-ready", "awaiting-answer"] })])
    await handleEnvelope(deps, reply("1700.5", "Use <https://x.eu/d|the publication date> &amp; ask <@UKARL>"))
    expect(fake.issues.get("STEP-7")!.description).toContain("): Use [the publication date](https://x.eu/d) & ask @Karl")
  })

  it("to an issue Linear no longer has go to failed, with one reply saying so", async () => {
    const { deps, paths } = setup([])
    await handleEnvelope(deps, reply("1700.5", "Use the publication date"))
    await retryPending(deps)
    expect(listNew(paths.inbox)).toEqual([])
    expect(countIn(paths.inbox, "failed")).toBe(1)
    expect(outboxTexts(paths)).toEqual(["I could not add this answer to STEP-7, because STEP-7 is no longer in Linear."])
  })

  it("that Linear has refused for a whole day go to failed, with one reply saying so", async () => {
    const { deps, paths } = setup([issue({ id: "STEP-7", state: "On hold" })], ["updateIssue"])
    putOnce(paths.inbox, "msg:CQ:1700.5", {
      type: "answer", key: "msg:CQ:1700.5", issue: "STEP-7", channel: "CQ", ts: "1700.5", threadTs: "1700.1",
      user: "UNATE", userName: "Nate", text: "Yes", receivedAt: "2026-09-23T07:00:00.000Z",
    })
    await retryPending(deps)
    expect(countIn(paths.inbox, "failed")).toBe(1)
    expect(outboxTexts(paths)).toEqual(["Linear refused this answer for a whole day, so I have stopped trying to add it to STEP-7. Please post it again."])
  })

  it("stay in the inbox when Linear is down and apply on a later retry", async () => {
    const { deps, paths } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["agent-ready", "awaiting-answer"] })], ["updateIssue"])
    await handleEnvelope(deps, reply("1700.5", "Yes"))
    expect(listNew(paths.inbox)).toHaveLength(1)
    const working = fakeTracker([issue({ id: "STEP-7", state: "On hold", labels: ["agent-ready", "awaiting-answer"] })])
    deps.tracker = working.tracker
    await retryPending(deps)
    expect(working.issues.get("STEP-7")!.state).toBe("Ready")
    expect(listNew(paths.inbox)).toEqual([])
  })
})

describe("mentions", () => {
  it("queue for the front door with the sender's name and the thread to answer in", async () => {
    const { deps, paths } = setup()
    await handleEnvelope(deps, { team_id: "T1", event: { type: "app_mention", user: "UNATE", channel: "CAG", ts: "1900.1", text: "<@UBOT> status?" } })
    expect(listNew(paths.inbox)[0].payload).toMatchObject({ type: "mention", userName: "Nate", threadTs: "1900.1" })
  })
})

describe("resolveChannels", () => {
  it("names every channel that is missing or that the bot has not joined", async () => {
    const list = async () => ({
      channels: [
        { id: "CAG", name: "polads-agents", is_member: true },
        { id: "CQ", name: "polads-questions", is_member: false },
      ],
    })
    await expect(
      resolveChannels(list, { agents: "polads-agents", questions: "polads-questions", intake: "polads-intake", releases: "polads-releases" }),
    ).rejects.toThrow(/the bot is not in #polads-questions.*#polads-intake does not exist.*#polads-releases does not exist/)
  })
})

describe("starting", () => {
  const RUNTIME = fileURLToPath(new URL("../../..", import.meta.url))

  function home(profileMini: string | null) {
    const h = mkdtempSync(join(tmpdir(), "bridge-home-"))
    mkdirSync(join(h, ".agentd"), { recursive: true })
    writeFileSync(join(h, ".agentd", "config.json"), JSON.stringify(CONFIG))
    mkdirSync(join(h, ".claude"))
    writeFileSync(join(h, ".claude", "dev-tasks-profile.json"), JSON.stringify({ profile: "agent", devSurface: "preview", mini: profileMini }))
    return h
  }

  it("refuses when config.json and the machine profile name different minis, before it reads a token (decision 2)", () => {
    // No slack.env and no Linear key exist: an error about either would mean the check came too late.
    const paths = agentPaths(home("bob"))
    expect(() => checkLocal(paths, "bob")).toThrow(/mini "eve".*mini "bob"/)
    expect(() => checkLocal(paths, null)).toThrow(/mini "eve".*no mini/)
    // The same config with the profile's agreement gets past the check, to the missing secrets.
    expect(() => checkLocal(paths, "eve")).toThrow(/^secrets: /)
  })

  it("as a process, records the refusal in bridge.json and exits 0 so launchd leaves it stopped", () => {
    // The whole entry point, as launchd runs it: the mini comes from the real
    // hooks/lib/profile.sh, and neither Slack nor Linear is in reach.
    const h = home("bob")
    const run = spawnSync(join(RUNTIME, "node_modules", ".bin", "tsx"), [join(RUNTIME, "src", "slack", "bridge.ts")], {
      cwd: h,
      env: { PATH: process.env.PATH ?? "", HOME: h },
      encoding: "utf8",
    })
    expect(run.status).toBe(0)
    const status = JSON.parse(readFileSync(join(h, ".agentd", "state", "bridge.json"), "utf8"))
    expect(status).toMatchObject({ connected: false, error: expect.stringMatching(/mini "eve".*mini "bob"/) })
  }, 30_000)

  it("as a process, will not run beside another bridge, and leaves that bridge's bridge.json alone", () => {
    // A live process (this test runner) holds the lock, as launchd's bridge would.
    const h = home("eve")
    mkdirSync(join(h, ".agentd", "state"), { recursive: true })
    writeFileSync(join(h, ".agentd", "state", "slack-bridge.pid"), String(process.pid))
    const run = spawnSync(join(RUNTIME, "node_modules", ".bin", "tsx"), [join(RUNTIME, "src", "slack", "bridge.ts")], {
      cwd: h,
      env: { PATH: process.env.PATH ?? "", HOME: h },
      encoding: "utf8",
    })
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(new RegExp(`another bridge is running here, pid ${process.pid}`))
    expect(() => readFileSync(join(h, ".agentd", "state", "bridge.json"), "utf8")).toThrow(/ENOENT/)
  }, 30_000)

  it("exits 1, for launchd to try again, only when Slack could not be reached or had trouble of its own", () => {
    const refusal = (code: string) => Object.assign(new Error(`An API error occurred: ${code}`), { code: "slack_webapi_platform_error", data: { ok: false, error: code } })
    expect(exitCodeFor(Object.assign(new Error("fetch failed"), { code: "slack_webapi_request_error" }))).toBe(1)
    expect(exitCodeFor(Object.assign(new Error("HTTP 503"), { code: "slack_webapi_http_error" }))).toBe(1)
    expect(exitCodeFor(Object.assign(new Error("rate limited"), { code: "slack_webapi_rate_limited_error" }))).toBe(1)
    for (const code of ["internal_error", "fatal_error", "service_unavailable", "request_timeout"]) expect(exitCodeFor(refusal(code))).toBe(1)
    expect(exitCodeFor(refusal("invalid_auth"))).toBe(0)
    expect(exitCodeFor(new Error("slack-bridge: #polads-intake does not exist or is private"))).toBe(0)
    expect(exitCodeFor(new SlackAccessRefused("slack-bridge: Slack refused the app (token_revoked)."))).toBe(0)
  })
})

describe("wireSocket", () => {
  const hooks = (over: Partial<SocketHooks> = {}): SocketHooks => ({ async handle() {}, received() {}, connected() {}, ...over })

  it("acknowledges each delivery first, and handles it even when the acknowledgement fails", async () => {
    // A delivery Slack did not hear acknowledged comes again, and the inbox keeps one of the two.
    const socket = new EventEmitter()
    const order: string[] = []
    wireSocket(socket, hooks({ handle: async (body) => void order.push(`handle ${body.event?.ts}`) }), quiet)
    socket.emit("app_mention", { body: { event: { type: "app_mention", ts: "1" } }, ack: async () => void order.push("ack 1") })
    socket.emit("message", { body: { event: { type: "message", ts: "2" } }, ack: async () => Promise.reject(new Error("socket closed")) })
    socket.emit("reaction_added", { body: { event: { type: "reaction_added", ts: "3" } }, ack: async () => {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(order.indexOf("ack 1")).toBeLessThan(order.indexOf("handle 1"))
    expect(order.filter((step) => step.startsWith("handle")).sort()).toEqual(["handle 1", "handle 2", "handle 3"])
  })

  it("marks the connection down on reconnecting, which is how @slack/socket-mode 3 reports a drop", () => {
    const socket = new EventEmitter()
    const states: boolean[] = []
    wireSocket(socket, hooks({ connected: (value) => void states.push(value) }), quiet)
    for (const state of ["connected", "reconnecting", "connected", "disconnected"]) socket.emit(state)
    expect(states).toEqual([true, false, true, false])
  })

  it("logs a delivery it could not handle instead of letting it end the process", async () => {
    const socket = new EventEmitter()
    const errors: string[] = []
    wireSocket(socket, hooks({ handle: async () => Promise.reject(new Error("disk full")) }), { ...quiet, error: (msg) => void errors.push(msg) })
    socket.emit("message", { body: {}, ack: async () => {} })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(errors).toEqual(["event failed"])
  })
})
