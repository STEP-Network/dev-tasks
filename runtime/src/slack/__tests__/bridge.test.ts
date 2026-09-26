import { spawn, spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { readLessons } from "../../retro/lessons.ts"
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
  classifyContextFor,
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
import { ONE_AT_A_TIME, pendingCommands, TESTDAY_HELP } from "../../testday/commands.ts"
import { saveRun } from "../../testday/store.ts"
import { FAILED_WAITING, run } from "../../testday/__tests__/fixtures.ts"

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
    // Labelled a Slack ask (Wave 2), with the asker from the event, never from their text.
    expect(created[0][0]).toMatchObject({ title: "The date is wrong on notices", state: "Triage", labels: ["polads", "intake/slack"], description: expect.stringMatching(/\n<!-- slack-user:UNATE -->$/) })
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

  it("that say the mini got it wrong are kept as lessons for the weekly retro, whether answer or instruction (STEP-3290)", async () => {
    const parked = setup([issue({ id: "STEP-7", state: "On hold", labels: ["polads", "agent-ready", "awaiting-answer"], description: "## Goal\n\nFix it." })])
    await handleEnvelope(parked.deps, reply("1700.5", "no, use the publication date, not the creation date"))
    await handleEnvelope(parked.deps, reply("1700.6", "Use the publication date"))
    const inReview = setup([issue({ id: "STEP-7", state: "In Review", labels: ["polads", "agent-ready"] })])
    await handleEnvelope(inReview.deps, reply("1700.7", "don't merge it, fix the test first"))
    await handleEnvelope(inReview.deps, reply("1700.8", "fix it and merge"))
    expect(readLessons(parked.paths)).toEqual([
      expect.objectContaining({ category: "correction", source: "slack", issue: "STEP-7", who: "Nate", text: "no, use the publication date, not the creation date", key: "correction:CQ:1700.5" }),
    ])
    expect(readLessons(inReview.paths)).toEqual([
      expect.objectContaining({ category: "correction", source: "slack", issue: "STEP-7", who: "Nate", text: "don't merge it, fix the test first", key: "correction:CQ:1700.7" }),
    ])
    // Once, however often Slack delivers it.
    await handleEnvelope(inReview.deps, reply("1700.7", "don't merge it, fix the test first"))
    expect(readLessons(inReview.paths)).toHaveLength(1)
  })

  it("that name one of the fixed actions go to the front door too, which reads them, while it is up", async () => {
    const { deps, paths } = setup([issue({ id: "STEP-7", state: "In Review", labels: ["polads", "agent-ready"] })])
    up(paths)
    await handleEnvelope(deps, reply("1700.5", "fix it and merge"))
    await handleEnvelope(deps, reply("1700.6", "leave it, I'll take it"))
    expect(listNew<{ type: string }>(paths.inbox).map((e) => e.payload.type)).toEqual(["reply", "reply"])
    expect(listNew(paths.outbox)).toEqual([])
  })

  it("act at once on a message that is only a command to stop, even with the front door up, and leave the message for it (STEP-3293 re-review)", async () => {
    // A pause is safe, and only a person lifts it: a plain "stop" never waits for a front door stuck at its usage limit.
    const { deps, paths } = setup([PARKED])
    up(paths)
    await handleEnvelope(deps, reply("1700.5", "pause"))
    await handleEnvelope(deps, reply("1700.6", "Hold everything."))
    await handleEnvelope(deps, reply("1700.7", "stop everything, please"))
    await retryPending(deps)
    expect(instructions(paths)).toEqual([
      ["instr:bridge-pause:CQ:1700.5", ["pause"]],
      ["instr:bridge-pause:CQ:1700.6", ["pause"]],
      ["instr:bridge-pause:CQ:1700.7", ["pause"]],
    ])
    expect(replies(paths).map((p) => p.acted)).toEqual([["pause"], ["pause"], ["pause"]])
    expect(listNew(paths.outbox)).toEqual([])
  })

  for (const state of ["up", "down"] as const) {
    it(`reads a whole "make it look" in the thread itself and sends it to agentd, with the front door ${state}, a question open or not (Wave 2, D1)`, async () => {
      // Code reads a lowering, never a model: the front door sees it done (acted) and does nothing more.
      const { deps, paths } = setup([PARKED])
      if (state === "up") up(paths)
      else down(paths)
      saveThread(paths, { issue: "STEP-7", channelId: "CQ", ts: "1700.1", permalink: null, createdAt: "2026-09-24T07:00:00.000Z", lastQuestionAt: "2026-09-24T07:30:00.000Z", lastQuestion: "Q?", openQuestions: 1 })
      await handleEnvelope(deps, reply("1700.5", "<@UBOT> make it look"))
      await handleEnvelope(deps, reply("1700.6", "make it look nicer"))
      await retryPending(deps)
      expect(instructions(paths)).toEqual([["instr:bridge-class-look:CQ:1700.5", ["class-look"]]])
      const [filed] = listNew<{ type: string; issue: string; permalink?: string }>(paths.inbox).map((e) => e.payload).filter((p) => p.type === "instruction")
      expect(filed).toMatchObject({ issue: "STEP-7", permalink: "https://step.slack.com/archives/CQ/p17005" })
      expect(replies(paths).map((p) => p.acted)).toEqual([["class-look"], undefined])
    })
  }

  it("never reads a class verb in a mention outside a thread: it names no request", async () => {
    const { deps, paths } = setup()
    up(paths)
    await handleEnvelope(deps, mention("app_mention", "<@UBOT> make it look", { channel: "CQ" }))
    expect(listNew<{ type: string }>(paths.inbox).map((e) => e.payload.type)).not.toContain("instruction")
  })

  for (const state of ["up", "down"] as const) {
    it(`never pause or leave on words that are not a command, with the front door ${state} (STEP-3293 final pass)`, async () => {
      // The reviewer's proofs, turned round: an answer that says pause paused the whole mini while the front door was down,
      // and a one-word "Hold" or "stop" to "ship it now, or hold?" paused it while it was up.
      const { deps, paths } = setup([PARKED])
      if (state === "up") up(paths)
      else down(paths)
      const words = [
        "Yes, pause the countdown during the blackout period",
        "hold off on the banner until legal replies",
        "should we pause the rollout?",
        "pause, and fix the failing test when you are back",
        "Hold",
        "stop",
        "I think you should leave it to Kristoffer, he knows that code",
      ]
      for (const [i, text] of words.entries()) await handleEnvelope(deps, reply(`1700.${10 + i}`, text))
      await retryPending(deps)
      expect(instructions(paths)).toEqual([])
      expect(replies(paths).map((p) => p.acted)).toEqual(words.map(() => undefined))
      // Down, they hear once that the front door reads them when it is back.
      expect(outboxTexts(paths)).toEqual(state === "down" ? [AWAY_NOTE] : [])
    })
  }

  it("never pause on a reply in a thread with a question open: \"pause\" may be its answer (STEP-3293 final pass)", async () => {
    const { deps, paths } = setup([PARKED])
    up(paths)
    saveThread(paths, { issue: "STEP-7", channelId: "CQ", ts: "1700.1", permalink: null, createdAt: "2026-09-24T07:00:00.000Z", lastQuestionAt: "2026-09-24T07:30:00.000Z", lastQuestion: "Ship it now, or pause?", openQuestions: 1 })
    await handleEnvelope(deps, reply("1700.5", "pause"))
    expect(instructions(paths)).toEqual([])
    // Their reply answered it: the next "pause" in the thread is a command again.
    await handleEnvelope(deps, reply("1700.6", "pause"))
    expect(instructions(paths)).toEqual([["instr:bridge-pause:CQ:1700.6", ["pause"]]])
  })

  it("keep how the thread stood: when the front door last wrote there, and how many questions were open, and count afresh after it (STEP-3293 re-review)", async () => {
    const { deps, paths } = setup([PARKED])
    up(paths)
    saveThread(paths, {
      issue: "STEP-7", channelId: "CQ", ts: "1700.1", permalink: null, createdAt: "2026-09-24T07:00:00.000Z",
      lastQuestionAt: "2026-09-24T07:30:00.000Z", lastQuestion: "Q?", lastReplyAt: "2026-09-24T07:40:00.000Z", openQuestions: 2,
    })
    await handleEnvelope(deps, reply("1700.5", "yes"))
    expect(replies(paths)[0]).toMatchObject({ lastReplyAt: "2026-09-24T07:40:00.000Z", openQuestions: 2 })
    expect(threadFor(paths, "STEP-7")?.openQuestions).toBe(0)
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
    // A plain "@eve pause" names no PR, and needs none: a pause is the whole mini's (STEP-3293 re-review).
    await handleEnvelope(upNow.deps, at("1950.5", "<@UBOT> pause"))
    expect(payloads(upNow.paths).filter((p) => p.type === "instruction")).toEqual([
      expect.objectContaining({ type: "instruction", issue: null, threadTs: "1950.5", actions: ["pause"], target: {} }),
    ])
    const downNow = setup()
    down(downNow.paths)
    await handleEnvelope(downNow.deps, at("1950.2", "<@UBOT> pause everything"))
    // Not a command alone: the front door reads them when it is back (STEP-3293 final pass).
    await handleEnvelope(downNow.deps, at("1950.3", "<@UBOT> pause #1679 for a bit"))
    await handleEnvelope(downNow.deps, at("1950.6", "<@UBOT> leave it, I'll take it"))
    expect(payloads(downNow.paths).filter((p) => p.type === "instruction").map((p) => [p.ts, p.actions, p.target])).toEqual([["1950.2", ["pause"], {}]])
    // All stay for the front door, with what the bridge did beside them. A leave that names nothing is the front door's to ask about.
    expect(payloads(downNow.paths).filter((p) => p.type === "mention").map((p) => [p.ts, (p as { acted?: string[] }).acted])).toEqual([
      ["1950.2", ["pause"]],
      ["1950.3", undefined],
      ["1950.6", undefined],
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

describe("test day in Slack (Wave 3, WS7)", () => {
  const TESTDAY = { enabled: true, statusColumn: "col_status", docColumn: "col_doc", subitemBoardId: "77", subitemColumns: { verdict: "col_verdict", note: "col_note", linear: "col_link" }, roles: [{ name: "Public", persona: null }] }
  /** A test-day mini: Ada (made up) on the allowlist, the test day thread 1750.1 and STEP-7's thread 1700.1 in #polads-questions. */
  function testDaySetup(opts: { enabled?: boolean } = {}) {
    const s = setup()
    const enabled = opts.enabled ?? true
    s.deps.config = ConfigSchema.parse({
      ...CONFIG, slack: { allowedUsers: ["UADA"] }, ...(enabled ? { testDay: TESTDAY } : {}),
      bridges: { monday: { people: [{ id: "111", name: "Ada", slackId: "UADA" }], defaultPerson: "111" } },
    })
    s.deps.classifyContext = {
      ...s.deps.classifyContext,
      allowedUsers: ["UADA"],
      testDay: enabled,
      issueForThread: (channel, ts) => (channel !== "CQ" ? null : ts === "1750.1" ? "testday-2026-10-02" : ts === "1700.1" ? "STEP-7" : null),
    }
    s.deps.web = { ...s.deps.web, userName: async (id) => (id === "UADA" ? "Ada" : id) }
    return s
  }
  const say = (ts: string, text: string, extra: Record<string, unknown> = {}): SlackEnvelope => ({ team_id: "T1", event: { type: "message", user: "UADA", channel: "CQ", ts, text, ...extra } })
  const forFrontDoor = (paths: BridgeDeps["paths"]) => listNew<{ type: string }>(paths.inbox).filter((e) => e.payload.type !== "testday")

  it("files begin testday for agentd once, however many copies Slack sends, and nothing for the front door", async () => {
    const { deps, paths } = testDaySetup()
    await handleEnvelope(deps, say("2000.1", "begin testday"))
    await handleEnvelope(deps, say("2000.2", "<@UBOT> begin testday", { type: "app_mention", channel: "CAG" }))
    await handleEnvelope(deps, say("2000.2", "<@UBOT> begin testday", { channel: "CAG" }))
    // Oldest first, by when the person wrote it. The name is config's: nothing waits on Slack before the command is on disk.
    expect(pendingCommands(paths).map((e) => e.payload)).toEqual([
      expect.objectContaining({
        verb: "start", who: "Ada", whoId: "UADA", whoKey: "monday:111", via: "slack", at: "1970-01-01T00:33:20.100Z", door: { kind: "slack", channel: "CQ", threadTs: "2000.1", ts: "2000.1" },
      }),
      expect.objectContaining({ verb: "start", at: "1970-01-01T00:33:20.200Z", door: { kind: "slack", channel: "CAG", threadTs: "2000.2", ts: "2000.2" } }),
    ])
    expect(forFrontDoor(paths)).toEqual([])
    expect(listNew(paths.outbox)).toEqual([])
  })

  it("files a checkpoint verdict from the test day thread, and answers anything else there with the three things it reads, once", async () => {
    const { deps, paths } = testDaySetup()
    await handleEnvelope(deps, say("1750.5", "4 fail the price shows 0", { thread_ts: "1750.1" }))
    expect(pendingCommands(paths)[0].payload).toMatchObject({ verb: "verdict", n: 4, verdict: "fail", note: "the price shows 0", door: { kind: "slack", channel: "CQ", threadTs: "1750.1", ts: "1750.5" } })
    await handleEnvelope(deps, say("1750.6", "<@UBOT> how is it going?", { thread_ts: "1750.1", type: "app_mention" }))
    await handleEnvelope(deps, say("1750.6", "<@UBOT> how is it going?", { thread_ts: "1750.1" }))
    expect(outboxTexts(paths)).toEqual([TESTDAY_HELP])
    expect(listNew<{ threadTs?: string }>(paths.outbox)[0].payload.threadTs).toBe("1750.1")
    expect(forFrontDoor(paths)).toEqual([])
    expect(pendingCommands(paths)).toHaveLength(1)
  })

  it("files fix before release from an issue's thread only while that issue has a failed checkpoint waiting", async () => {
    const { deps, paths } = testDaySetup()
    await handleEnvelope(deps, say("1700.8", "fix before release", { thread_ts: "1700.1" }))
    expect(pendingCommands(paths)).toEqual([])
    // With nothing waiting, it is words in the issue's thread, for the front door as always.
    expect(forFrontDoor(paths).map((e) => e.payload.type)).toEqual(["reply"])
    saveRun(paths, run({ checkpoints: [FAILED_WAITING] }))
    await handleEnvelope(deps, say("1700.9", "next week", { thread_ts: "1700.1" }))
    expect(pendingCommands(paths)[0].payload).toMatchObject({ verb: "decide", issue: "STEP-7", answer: "next-week", door: { kind: "slack", channel: "CQ", threadTs: "1700.1", ts: "1700.9" } })
    expect(forFrontDoor(paths)).toHaveLength(1)
  })

  it("files what someone names in their verdict with secrets redacted", async () => {
    const { deps, paths } = testDaySetup()
    // Built at run time, so no secret scanner mistakes the fixture for a real token.
    const token = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-")
    await handleEnvelope(deps, say("1750.7", `4 fail the page printed ${token}`, { thread_ts: "1750.1" }))
    expect(pendingCommands(paths)[0].payload).toMatchObject({ verb: "verdict", n: 4, note: "the page printed [redacted]" })
  })

  it("keeps at most 4,000 characters of what someone saw, as the Monday board keeps words", async () => {
    const { deps, paths } = testDaySetup()
    await handleEnvelope(deps, say("1750.10", `4 fail ${"x".repeat(5000)}`, { thread_ts: "1750.1" }))
    const note = (pendingCommands(paths)[0].payload as { note: string }).note
    expect(note.length).toBeLessThanOrEqual(4000)
    expect(note.length).toBeGreaterThan(3900)
  })

  it("records no verdict from a message with several, and asks for one per message, once", async () => {
    const { deps, paths } = testDaySetup()
    await handleEnvelope(deps, say("1750.8", "<@UBOT> 5 pass\n6 fail no logo", { thread_ts: "1750.1", type: "app_mention" }))
    await handleEnvelope(deps, say("1750.8", "<@UBOT> 5 pass\n6 fail no logo", { thread_ts: "1750.1" }))
    expect(pendingCommands(paths)).toEqual([])
    expect(outboxTexts(paths)).toEqual([ONE_AT_A_TIME])
  })

  it("reads no decision in the test day thread: that is asked about in the change's own thread", async () => {
    const { deps, paths } = testDaySetup()
    saveRun(paths, run({ checkpoints: [FAILED_WAITING] }))
    await handleEnvelope(deps, say("1750.9", "fix before release", { thread_ts: "1750.1" }))
    expect(pendingCommands(paths)).toEqual([])
    expect(outboxTexts(paths)).toEqual([TESTDAY_HELP])
  })

  it("pauses the whole mini from the test day thread too, and answers no help", async () => {
    const { deps, paths } = testDaySetup()
    await handleEnvelope(deps, say("1751.1", "pause everything", { thread_ts: "1750.1" }))
    expect(listNew<{ type: string; actions?: string[]; issue?: string | null; threadTs?: string }>(paths.inbox).map((e) => e.payload).filter((p) => p.type === "instruction")).toEqual([
      expect.objectContaining({ type: "instruction", key: "instr:bridge-pause:CQ:1751.1", actions: ["pause"], issue: null, threadTs: "1750.1", userName: "Ada" }),
    ])
    expect(outboxTexts(paths)).toEqual([])
    expect(pendingCommands(paths)).toEqual([])
  })

  it("reads a verdict only in the test day thread: in an issue's thread it is the front door's", async () => {
    const { deps, paths } = testDaySetup()
    await handleEnvelope(deps, say("1700.5", "4 pass", { thread_ts: "1700.1" }))
    expect(pendingCommands(paths)).toEqual([])
    expect(forFrontDoor(paths)).toHaveLength(1)
  })

  it("files begin testday said in an issue's thread, answered there", async () => {
    const { deps, paths } = testDaySetup()
    await handleEnvelope(deps, say("1700.6", "begin testday", { thread_ts: "1700.1" }))
    expect(pendingCommands(paths)[0].payload).toMatchObject({ verb: "start", door: { kind: "slack", channel: "CQ", threadTs: "1700.1", ts: "1700.6" } })
    expect(forFrontDoor(paths)).toEqual([])
  })

  it("tells classify this mini runs test day only when its config turns it on", () => {
    const { paths } = setup()
    const slack = { teamId: "T1", botUserId: "UBOT", channelIds: { agents: "CAG", questions: "CQ", intake: "CIN", releases: "CREL" } }
    const on = classifyContextFor(paths, ConfigSchema.parse({ ...CONFIG, testDay: TESTDAY }), slack)
    expect(on).toMatchObject({ teamId: "T1", botUserId: "UBOT", allowedUsers: ["UNATE"], channels: slack.channelIds, testDay: true })
    expect(classifyContextFor(paths, ConfigSchema.parse({ ...CONFIG, testDay: { ...TESTDAY, enabled: false } }), slack).testDay).toBe(false)
    expect(classifyContextFor(paths, ConfigSchema.parse(CONFIG), slack).testDay).toBe(false)
  })

  it("says test day is not set up, once, when this bot is asked on a mini without it, and files nothing", async () => {
    const { deps, paths } = testDaySetup({ enabled: false })
    await handleEnvelope(deps, say("2000.9", "<@UBOT> begin testday", { type: "app_mention" }))
    await handleEnvelope(deps, say("2000.9", "<@UBOT> begin testday"))
    expect(pendingCommands(paths)).toEqual([])
    expect(outboxTexts(paths)).toEqual([expect.stringMatching(/^Test day is not set up on eve yet\. Nothing needed from you\.$/)])
    // Top level in #polads-questions without its name: the test-day mini's to answer, not this one's.
    await handleEnvelope(deps, say("2001.1", "begin testday"))
    expect(outboxTexts(paths)).toHaveLength(1)
  })
})
