import { spawn, spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { countIn, listNew, putOnce } from "../../fsq.ts"
import type { Logger } from "../../log.ts"
import { saveThread, threadFor } from "../../threads.ts"
import { writeChannelState } from "../../channel/state.ts"
import { tickPath } from "../../tick.ts"
import { usagePath } from "../../usage.ts"
import { createLinearTracker } from "../../tracker.ts"
import { fakeTracker, issue } from "../../__tests__/fakes.ts"
import {
  AWAY_NOTE,
  bridgeStatus,
  checkLocal,
  exitCodeFor,
  fileIntake,
  handleEnvelope,
  isIssueGone,
  channelPages,
  resolveChannels,
  retryPending,
  wireSocket,
  type BridgeDeps,
  type BridgeWeb,
  type SocketHooks,
} from "../bridge.ts"
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
    expect(outboxTexts(paths)).toEqual(["filed STEP-901 https://linear.app/step/issue/STEP-901. A person decides when I work on it."])
  })

  it("promises to refine an intake only when this mini will: open mode, or the new id on the allowlist", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ mode: "open" }, "I will refine it and answer here."],
      [{ mode: "allowlist", allow: ["STEP-901"] }, "I will refine it and answer here."],
      [{ mode: "allowlist", allow: ["STEP-7"] }, "A person decides when I work on it."],
    ]
    for (const [queue, next] of cases) {
      const { deps, paths } = setup()
      deps.config = ConfigSchema.parse({ ...CONFIG, queue })
      await handleEnvelope(deps, mention("app_mention", "<@UBOT> The date is wrong on notices"))
      expect(outboxTexts(paths)).toEqual([`filed STEP-901 https://linear.app/step/issue/STEP-901. ${next}`])
    }
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
      text: "<@UBOT> The date is wrong", receivedAt: "2026-09-23T06:00:00.000Z", failingSince: "2026-09-23T07:00:00.000Z",
      linearId: "11111111-2222-4333-8444-555555555555", issue: null, toldUnfiled: true,
    })
    await retryPending(deps)
    await retryPending(deps)
    expect(listNew(paths.inbox)).toEqual([])
    expect(countIn(paths.inbox, "failed")).toBe(1)
    expect(outboxTexts(paths)).toEqual(["Linear refused this for a whole day, so I have stopped trying to file it. Please ask again."])
  })

  it("counts the day from Linear's first refusal, not from the delivery: a bridge that was down does not count", async () => {
    // Delivered two days ago, but first refused only now: it waits another day.
    const { deps, paths } = setup([], ["createIssue"])
    putOnce(paths.inbox, "msg:CIN:1800.1", {
      type: "intake", key: "msg:CIN:1800.1", channel: "CIN", ts: "1800.1", user: "UNATE", userName: "Nate",
      text: "<@UBOT> The date is wrong", receivedAt: "2026-09-22T08:00:00.000Z",
      linearId: "11111111-2222-4333-8444-555555555555", issue: null,
    })
    await retryPending(deps)
    expect(countIn(paths.inbox, "failed")).toBe(0)
    expect(listNew<{ failingSince: string }>(paths.inbox)[0].payload.failingSince).toBe("2026-09-24T08:00:00.000Z")
  })

  it("files a request that names this agent and then another under a title without the other's name", async () => {
    const { deps, fake, paths } = setup()
    await handleEnvelope(deps, mention("app_mention", "<@UBOT> <@UOTHER> The date is wrong on notices"))
    expect(fake.called("createIssue")[0][0]).toMatchObject({ title: "The date is wrong on notices", description: expect.stringMatching(/^@UOTHER The date/) })
    await handleEnvelope(deps, mention("app_mention", "<@UBOT> <@UOTHER>", { ts: "1800.2" }))
    expect(fake.called("createIssue")).toHaveLength(1)
    expect(outboxTexts(paths).at(-1)).toMatch(/^Tell me what you need/)
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
    expect(outboxTexts(paths)).toEqual(["filed STEP-901 https://linear.app/step/issue/STEP-901. A person decides when I work on it."])
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

/** The front door woke up at `at` (its digest's heartbeat): up within frontDoor.staleTickMinutes, 75 by default. */
const wokeAt = (paths: BridgeDeps["paths"], at: string) => {
  mkdirSync(paths.state, { recursive: true })
  writeFileSync(tickPath(paths), JSON.stringify({ at }))
}
const up = (paths: BridgeDeps["paths"]) => wokeAt(paths, "2026-09-24T07:59:00.000Z")
const down = (paths: BridgeDeps["paths"]) => wokeAt(paths, "2026-09-24T06:30:00.000Z")

describe("replies in a thread the mini owns (STEP-3293)", () => {
  const reply = (ts: string, text: string, extra: Record<string, unknown> = {}): SlackEnvelope => ({
    team_id: "T1",
    event: { type: "message", user: "UNATE", channel: "CQ", ts, thread_ts: "1700.1", text, ...extra },
  })
  const PARKED = issue({ id: "STEP-7", state: "On hold", labels: ["polads", "agent-ready", "awaiting-answer"], description: "## Goal\n\nFix it." })
  const replies = (paths: BridgeDeps["paths"]) => listNew<{ type: string; key: string; acted?: string[] }>(paths.inbox).map((e) => e.payload).filter((p) => p.type === "reply")
  const instructions = (paths: BridgeDeps["paths"]) =>
    listNew<{ type: string; key: string; actions?: string[] }>(paths.inbox).map((e) => e.payload).filter((p) => p.type === "instruction").map((p) => [p.key, p.actions]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))

  it("go to the front door as they are, and the bridge records nothing: Nate's 'what do you recommend?' on STEP-3225", async () => {
    const { deps, fake, paths } = setup([PARKED])
    up(paths)
    await handleEnvelope(deps, reply("1700.5", "what do you recommend?"))
    await handleEnvelope(deps, reply("1700.5", "what do you recommend?"))
    await retryPending(deps)
    expect(fake.called("readIssue")).toEqual([])
    expect(fake.called("updateIssue")).toEqual([])
    expect(fake.issues.get("STEP-7")).toMatchObject({ state: "On hold", labels: ["polads", "agent-ready", "awaiting-answer"] })
    expect(listNew(paths.inbox).map((e) => e.payload)).toEqual([
      expect.objectContaining({
        type: "reply", key: "msg:CQ:1700.5", issue: "STEP-7", channel: "CQ", ts: "1700.5", threadTs: "1700.1", user: "UNATE", userName: "Nate",
        text: "what do you recommend?", readableText: "what do you recommend?", permalink: "https://step.slack.com/archives/CQ/p17005",
      }),
    ])
    // Nothing said, nothing ticked: the front door answers.
    expect(listNew(paths.outbox)).toEqual([])
  })

  it("keep the question they answered, as the thread stood when they came (STEP-3293 review)", async () => {
    const { deps, paths } = setup([PARKED])
    up(paths)
    saveThread(paths, { issue: "STEP-7", channelId: "CQ", ts: "1700.1", permalink: null, createdAt: "2026-09-24T07:00:00.000Z", lastQuestionAt: "2026-09-24T07:30:00.000Z", lastQuestion: "Which date?\n\nMy recommendation: the publication date. Reply yes to go with it, or tell me what you want instead." })
    await handleEnvelope(deps, reply("1700.5", "yes"))
    // A later question changes the thread, never the reply already filed.
    saveThread(paths, { ...threadFor(paths, "STEP-7")!, lastQuestionAt: "2026-09-24T08:05:00.000Z", lastQuestion: "And the footer?" })
    expect(replies(paths)[0]).toMatchObject({ lastQuestionAt: "2026-09-24T07:30:00.000Z", lastQuestion: expect.stringContaining("the publication date") })
  })

  it("that name one of the fixed actions go to the front door too, which reads them, while it is up", async () => {
    const { deps, paths } = setup([issue({ id: "STEP-7", state: "In Review", labels: ["polads", "agent-ready"] })])
    up(paths)
    await handleEnvelope(deps, reply("1700.5", "fix it and merge"))
    await handleEnvelope(deps, reply("1700.6", "leave it, I'll take it"))
    expect(listNew<{ type: string }>(paths.inbox).map((e) => e.payload.type)).toEqual(["reply", "reply"])
    expect(listNew(paths.outbox)).toEqual([])
  })

  it("act on pause at once, even with the front door up, and leave the message for it with what they did (STEP-3293 review)", async () => {
    // A pause is safe, and only a person lifts it: it never waits for a front door stuck at its usage limit.
    const { deps, paths } = setup([PARKED])
    up(paths)
    await handleEnvelope(deps, reply("1700.5", "pause, and fix the failing test when you are back"))
    await retryPending(deps)
    expect(instructions(paths)).toEqual([["instr:bridge-pause:CQ:1700.5", ["pause"]]])
    // The rest of the words, "fix the failing test", are the front door's: the message stays open.
    expect(replies(paths)).toEqual([expect.objectContaining({ key: "msg:CQ:1700.5", acted: ["pause"] })])
    expect(listNew(paths.outbox)).toEqual([])
  })

  it("while the front door is down: pause and leave act through agentd, nothing is closed, and each thread hears once (STEP-3293 review)", async () => {
    const { deps, paths } = setup([PARKED])
    down(paths)
    await handleEnvelope(deps, reply("1700.5", "pause for now"))
    await handleEnvelope(deps, reply("1700.6", "leave it, I'll take it"))
    await handleEnvelope(deps, reply("1700.7", "fix it and merge"))
    await handleEnvelope(deps, reply("1700.8", "don't pause, what do you recommend?"))
    await retryPending(deps)
    await retryPending(deps)
    expect(instructions(paths)).toEqual([
      ["instr:bridge-leave:CQ:1700.6", ["leave"]],
      ["instr:bridge-pause:CQ:1700.5", ["pause"]],
    ])
    // Nothing is recorded, revised or closed on the bridge's own reading: all four wait for the front door.
    expect(replies(paths).map((p) => [p.key, p.acted])).toEqual([
      ["msg:CQ:1700.5", ["pause"]],
      ["msg:CQ:1700.6", ["leave"]],
      ["msg:CQ:1700.7", undefined],
      ["msg:CQ:1700.8", undefined],
    ])
    expect(outboxTexts(paths)).toEqual([AWAY_NOTE])
    expect(AWAY_NOTE).toBe("I am not reading messages right now, and I will read this one as soon as I am back. Nothing needed from you.")
    // The front door woke up, then went away again: a new outage, a new note.
    wokeAt(paths, "2026-09-24T06:40:00.000Z")
    await handleEnvelope(deps, reply("1700.9", "and the label?"))
    expect(outboxTexts(paths)).toEqual([AWAY_NOTE, AWAY_NOTE])
  })

  it("judge the front door by its wakeups and its usage limit, never by the channel's heartbeat alone (STEP-3293 review)", async () => {
    const fresh = { pid: 1, at: "2026-09-24T07:59:50.000Z", connectedAt: "2026-09-24T07:00:00.000Z", delivered: {} }
    // The channel process is alive, the front door stopped waking up an hour and a half ago.
    const stuck = setup([PARKED])
    down(stuck.paths)
    writeChannelState(stuck.paths, fresh)
    await handleEnvelope(stuck.deps, reply("1700.5", "what do you recommend?"))
    expect(outboxTexts(stuck.paths)).toEqual([AWAY_NOTE])
    // The channel process died on its own: the front door still wakes up and reads the digest.
    const alone = setup([PARKED])
    up(alone.paths)
    writeChannelState(alone.paths, { ...fresh, at: "2026-09-24T07:20:00.000Z" })
    await handleEnvelope(alone.deps, reply("1700.5", "what do you recommend?"))
    expect(listNew(alone.paths.outbox)).toEqual([])
    // At its usage limit, however recent its last wakeup.
    const limited = setup([PARKED])
    up(limited.paths)
    const resets = Math.round(Date.parse("2026-09-24T10:00:00.000Z") / 1000)
    writeFileSync(usagePath(limited.paths), JSON.stringify({ at: "2026-09-24T07:59:00.000Z", fiveHourPct: 100, fiveHourResetsAt: resets, sevenDayPct: 50, sevenDayResetsAt: resets + 86_400 }))
    await handleEnvelope(limited.deps, reply("1700.5", "pause please"))
    expect(outboxTexts(limited.paths)).toEqual([AWAY_NOTE])
    expect(instructions(limited.paths)).toEqual([["instr:bridge-pause:CQ:1700.5", ["pause"]]])
  })

  it("carry their words readably, for the front door and for the decision a person makes", async () => {
    const { deps, paths } = setup([PARKED])
    up(paths)
    await handleEnvelope(deps, reply("1700.5", "Use <https://x.eu/d|the publication date> &amp; ask <@UKARL>"))
    expect(listNew<{ readableText: string }>(paths.inbox)[0].payload.readableText).toBe("Use [the publication date](https://x.eu/d) & ask @Karl")
  })

  it("come only from the people on the allowlist: another person's, or a bot's, never reaches the front door", async () => {
    const { deps, paths } = setup([PARKED])
    up(paths)
    expect(await handleEnvelope(deps, reply("1700.5", "merge it", { user: "USTRANGER" }))).toBe("ignore")
    expect(await handleEnvelope(deps, reply("1700.6", "merge it", { bot_id: "B1" }))).toBe("ignore")
    expect(listNew(paths.inbox)).toEqual([])
  })

  it("know an issue Linear does not have by the real adapter's own words", async () => {
    // The fake above copies the wording; this asks the real adapter, over a stubbed fetch.
    const inherited = process.env.LINEAR_API_KEY
    process.env.LINEAR_API_KEY = "lin_api_contract_test"
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: { issues: { nodes: [] } } }), { status: 200 }))
    try {
      const error = await createLinearTracker().readIssue("STEP-7").catch((e: unknown) => e)
      expect(isIssueGone(error)).toBe(true)
      expect(isIssueGone(new Error("Linear: gave up after 6 attempts (last status 503)"))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      if (inherited === undefined) delete process.env.LINEAR_API_KEY
      else process.env.LINEAR_API_KEY = inherited
    }
  })
})

describe("mentions", () => {
  it("queue for the front door with the sender's name and the thread to answer in", async () => {
    const { deps, paths } = setup()
    await handleEnvelope(deps, { team_id: "T1", event: { type: "app_mention", user: "UNATE", channel: "CAG", ts: "1900.1", text: "<@UBOT> status?" } })
    expect(listNew(paths.inbox)[0].payload).toMatchObject({ type: "mention", userName: "Nate", threadTs: "1900.1" })
  })

  it("come through from a private Slack Connect channel, whoever hosts it", async () => {
    const { deps, paths } = setup()
    const body: SlackEnvelope = {
      team_id: "THOST",
      authorizations: [{ team_id: "T1" }],
      event: { type: "message", channel_type: "group", user: "UNATE", channel: "CAG", ts: "1901.1", text: "<@UBOT> status?" },
    }
    expect(await handleEnvelope(deps, body)).toBe("mention")
    expect(listNew(paths.inbox)[0].payload).toMatchObject({ type: "mention", channel: "CAG" })
  })
})

describe("mentions that name a PR (STEP-3293)", () => {
  it("go to the front door, which reads them: the bridge acts on pause alone while it is up, and on leave too while it is down", async () => {
    const at = (ts: string, text: string): SlackEnvelope => ({ team_id: "T1", event: { type: "app_mention", user: "UNATE", channel: "CAG", ts, text } })
    const payloads = (paths: BridgeDeps["paths"]) => listNew<{ type: string; ts?: string; actions?: string[]; target?: unknown }>(paths.inbox).map((e) => e.payload)
    const upNow = setup()
    up(upNow.paths)
    await handleEnvelope(upNow.deps, at("1950.1", "<@UBOT> fix <https://github.com/STEP-Network/v0-politiske-annoncer/pull/1679|#1679> and merge"))
    await handleEnvelope(upNow.deps, at("1950.4", "<@UBOT> leave #1680 to me, I'll take it"))
    expect(payloads(upNow.paths).map((p) => p.type)).toEqual(["mention", "mention"])
    const downNow = setup()
    down(downNow.paths)
    await handleEnvelope(downNow.deps, at("1950.2", "<@UBOT> pause #1679"))
    await handleEnvelope(downNow.deps, at("1950.3", "<@UBOT> pause for a bit"))
    expect(payloads(downNow.paths).filter((p) => p.type === "instruction")).toEqual([
      expect.objectContaining({ type: "instruction", issue: null, threadTs: "1950.2", actions: ["pause"], target: { pr: 1679 } }),
    ])
    // Both stay for the front door: the first with what the bridge did, the second, naming no issue or PR, as it came.
    expect(payloads(downNow.paths).filter((p) => p.type === "mention").map((p) => [p.ts, (p as { acted?: string[] }).acted])).toEqual([
      ["1950.2", ["pause"]],
      ["1950.3", undefined],
    ])
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
    ).rejects.toThrow(
      /the bot is not in #polads-questions\. the bot cannot see #polads-intake: it does not exist, or it is private and the bot is not in it\. the bot cannot see #polads-releases.*Integrations, Add an App/,
    )
  })
})

describe("channelPages", () => {
  it("lists public and private channels, a page at a time", async () => {
    const calls: unknown[] = []
    const pages = channelPages(async (args) => {
      calls.push(args)
      return args.cursor
        ? { channels: [{ id: "C2", name: "polads-intake", is_member: true }] }
        : { channels: [{ id: "C1", name: "polads-agents", is_member: true }], response_metadata: { next_cursor: "next" } }
    })
    expect(await pages()).toEqual({ channels: [{ id: "C1", name: "polads-agents", is_member: true }], next: "next" })
    expect(await pages("next")).toEqual({ channels: [{ id: "C2", name: "polads-intake", is_member: true }], next: undefined })
    expect(calls[0]).toMatchObject({ types: "public_channel,private_channel", exclude_archived: true })
  })

  it("stops the bridge naming the scope Slack says is missing, and leaves it stopped", async () => {
    const refused = Object.assign(new Error("An API error occurred: missing_scope"), {
      code: "slack_webapi_platform_error",
      data: { ok: false, error: "missing_scope", needed: "groups:read", provided: "channels:read,chat:write" },
    })
    const pages = channelPages(async () => {
      throw refused
    })
    const error = await pages().catch((e: unknown) => e)
    expect(String(error)).toMatch(/lacks the scope groups:read, which listing private channels needs\. Update the app from runtime\/slack\/app-manifest\.json/)
    expect(String(error)).not.toMatch(/does not exist/)
    expect(exitCodeFor(error)).toBe(0)
  })

  it("passes any other failure on as it came, so an unreachable Slack still restarts the bridge", async () => {
    const down = Object.assign(new Error("fetch failed"), { code: "slack_webapi_request_error" })
    const error = await channelPages(async () => {
      throw down
    })().catch((e: unknown) => e)
    expect(error).toBe(down)
    expect(exitCodeFor(error)).toBe(1)
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
    // stopped: agentd's health tells this from a paused outbox, whose error comes with a fresh heartbeat too.
    expect(status).toMatchObject({ connected: false, stopped: true, error: expect.stringMatching(/mini "eve".*mini "bob"/) })
  }, 30_000)

  it("as a process, will not run beside another bridge, and leaves that bridge's bridge.json alone", () => {
    // A live process whose command line names the bridge holds the lock, as launchd's would.
    const h = home("eve")
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "src/slack/bridge.ts"], { stdio: "ignore" })
    try {
      mkdirSync(join(h, ".agentd", "state"), { recursive: true })
      writeFileSync(join(h, ".agentd", "state", "slack-bridge.pid"), String(other.pid))
      const run = spawnSync(join(RUNTIME, "node_modules", ".bin", "tsx"), [join(RUNTIME, "src", "slack", "bridge.ts")], {
        cwd: h,
        env: { PATH: process.env.PATH ?? "", HOME: h },
        encoding: "utf8",
      })
      expect(run.status).toBe(1)
      expect(run.stderr).toMatch(new RegExp(`another bridge is running here, pid ${other.pid}`))
      expect(() => readFileSync(join(h, ".agentd", "state", "bridge.json"), "utf8")).toThrow(/ENOENT/)
    } finally {
      other.kill()
    }
  }, 30_000)

  it("reports why the outbox paused in bridge.json's error, for agentctl status and the health check", () => {
    const paths = agentPaths(mkdtempSync(join(tmpdir(), "bridge-status-")))
    const at = new Date("2026-09-24T08:00:00.000Z")
    expect(bridgeStatus(paths, { connected: true, lastEventAt: null, refused: null }, at)).toEqual({
      pid: process.pid, at: "2026-09-24T08:00:00.000Z", connected: true, lastEventAt: null, outboxWaiting: 0, outboxFailed: 0,
    })
    expect(bridgeStatus(paths, { connected: true, lastEventAt: null, refused: "slack-bridge: Slack refused the app: token_revoked." }, at)).toMatchObject({
      error: "slack-bridge: Slack refused the app: token_revoked.",
    })
  })

  it("names the app's own bot user in bridge.json once Slack named it, for the other minis' otherAgentBots", () => {
    const paths = agentPaths(mkdtempSync(join(tmpdir(), "bridge-status-")))
    expect(bridgeStatus(paths, { connected: true, lastEventAt: null, refused: null, botUserId: "UBOB" })).toMatchObject({ botUserId: "UBOB" })
    expect(bridgeStatus(paths, { connected: false, lastEventAt: null, refused: null })).not.toHaveProperty("botUserId")
  })

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
