/**
 * A person's reply, as the front door closes it (STEP-3293): agentctl decide
 * records a decision in words that stand on their own, agentctl instruct
 * files one of the fixed actions for agentd, and agentctl ack closes a
 * question back. Who said it, and their words, are always the bridge's.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { askDecision } from "../agentd/decisions.ts"
import { actOnInstructions } from "../agentd/instructions.ts"
import { run } from "../cli/agentctl.ts"
import { agentPaths, ConfigSchema, type AgentPaths } from "../config.ts"
import { ack, listNew, putOnce } from "../fsq.ts"
import { listJobs, recordPr } from "../jobs.ts"
import { sendOutboxMessage, type SendContext } from "../slack/send.ts"
import { saveThread, threadFor } from "../threads.ts"
import { fakeExec, fakeTracker, issue } from "./fakes.ts"

const NOW = new Date("2026-09-25T10:00:00.000Z")
const PR = "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1679"
const QUESTION = "Should the notice show the publication date or the signing date?\n\nMy recommendation: use the publication date. Reply yes to go with it, or tell me what you want instead."

let paths: AgentPaths
let repo = ""
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "agentd-decide-"))
  process.env.AGENTD_HOME = join(home, ".agentd")
  paths = agentPaths(home)
  mkdirSync(paths.state, { recursive: true })
  repo = mkdtempSync(join(tmpdir(), "repo-"))
  mkdirSync(join(repo, ".claude"))
  writeFileSync(join(repo, ".claude", "project-config.json"), JSON.stringify({ git: { autoMergePolicy: { staging: "auto-after-checks-and-review" } }, ci: { requiredChecks: ["Test"] } }))
  writeFileSync(paths.config, JSON.stringify({ mini: "eve", repo: { path: repo }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] } }))
  saveThread(paths, { issue: "STEP-7", channelId: "CQ", ts: "1700.1", permalink: null, createdAt: NOW.toISOString(), lastQuestionAt: NOW.toISOString(), lastQuestion: QUESTION })
})
afterEach(() => {
  delete process.env.AGENTD_HOME
})

/** A person's reply as the bridge files it. */
function reply(ts: string, text: string, over: Record<string, unknown> = {}): string {
  const key = `msg:CQ:${ts}`
  putOnce(paths.inbox, key, {
    type: "reply", key, issue: "STEP-7", channel: "CQ", ts, threadTs: "1700.1", user: "UNATE", userName: "Nate", text, readableText: text,
    permalink: `https://step.slack.com/archives/CQ/p${ts.replace(".", "")}`, receivedAt: NOW.toISOString(), ...over,
  })
  return key
}

function ctl(state = "On hold", labels = ["polads", "agent-ready", "awaiting-answer"], failOn: string[] = []) {
  const fake = fakeTracker([issue({ id: "STEP-7", state, labels, description: "## Goal\n\nFix it." })], undefined, failOn)
  const printed: string[] = []
  const go = (argv: string[]) => run(argv, (l) => void printed.push(l), { tracker: () => fake.tracker, exec: fakeExec().exec, now: () => NOW, env: {}, isTTY: () => false })
  const outbox = () => listNew<{ kind: string; text?: string; name?: string }>(paths.outbox).map((e) => e.payload)
  return { fake, go, printed, outbox }
}

describe("agentctl decide", () => {
  it("records a yes to the recommendation as the recommendation itself, never a bare yes", async () => {
    const { fake, go, outbox } = ctl()
    const key = reply("1700.5", "yes")
    expect(await go(["decide", "--key", key, "--agree"])).toBe(0)
    const described = fake.issues.get("STEP-7")!.description
    expect(described).toContain("## Answers from Slack")
    expect(described).toContain('**Nate** ([Slack](https://step.slack.com/archives/CQ/p17005)): Nate agreed with the recommendation: use the publication date. (Their words: "yes")')
    expect(described).not.toMatch(/\): yes$/m)
    expect(fake.issues.get("STEP-7")).toMatchObject({ state: "Ready", labels: ["polads", "agent-ready"] })
    expect(listNew(paths.inbox)).toEqual([])
    expect(outbox()).toEqual([
      expect.objectContaining({ kind: "reply", text: "Thanks, Nate. I added your decision to STEP-7: use the publication date. It goes back to Ready. Nothing needed from you." }),
      expect.objectContaining({ kind: "react", name: "white_check_mark" }),
    ])
    expect(readFileSync(join(paths.logs, "ledger.jsonl"), "utf8")).toContain('"type":"answer.applied","issue":"STEP-7","movedTo":"Ready","decided":true')
  })

  it("records a decision in words as the answer always was: on the issue, with their own words, and the issue moves on", async () => {
    const { fake, go } = ctl("On hold", ["polads", "awaiting-answer"])
    const key = reply("1700.6", "no, the signing date, it is what the regulation counts from")
    const file = join(paths.root, "decision.md")
    writeFileSync(file, "use the signing date on notices\n")
    expect(await go(["decide", "--key", key, "--text-file", file])).toBe(0)
    expect(fake.issues.get("STEP-7")!.description).toContain(
      'Nate decided: use the signing date on notices. (Their words: "no, the signing date, it is what the regulation counts from")',
    )
    // Never agent-ready: back to Refining, as a bridge-applied answer went.
    expect(fake.issues.get("STEP-7")!.state).toBe("Refining")
  })

  it("refuses a bare yes as a decision, a yes with no recommendation to agree with, and a message that is not a person's reply", async () => {
    const { fake, go } = ctl()
    const key = reply("1700.7", "yes")
    for (const bare of ["yes", "OK.", "sure!", "go ahead", "👍"]) {
      await expect(go(["decide", "--key", key, "--text", bare]), bare).rejects.toThrow(/must say what was decided, not only yes/)
    }
    await expect(go(["decide", "--key", key, "--agree", "--text", "x"])).rejects.toThrow(/--agree records the recommendation/)
    // Their bare yes is not a decision the front door may write out for them (STEP-3293 review).
    await expect(go(["decide", "--key", key, "--text", "use the signing date"])).rejects.toThrow(/Nate said only "yes", which decides nothing without a recommendation/)
    saveThread(paths, { issue: "STEP-7", channelId: "CQ", ts: "1700.1", permalink: null, createdAt: NOW.toISOString(), lastQuestionAt: null, lastQuestion: "Which date?" })
    await expect(go(["decide", "--key", key, "--agree"])).rejects.toThrow(/no recommendation in STEP-7 thread to agree with/)
    putOnce(paths.inbox, "msg:CIN:1800.1", { type: "intake", key: "msg:CIN:1800.1", channel: "CIN", ts: "1800.1", user: "UNATE", text: "x", receivedAt: NOW.toISOString() })
    await expect(go(["decide", "--key", "msg:CIN:1800.1", "--text", "do it the long way"])).rejects.toThrow(/not a person's reply or mention/)
    await expect(go(["decide", "--key", "msg:CQ:9999.9", "--text", "do it the long way"])).rejects.toThrow(/no message msg:CQ:9999.9 is waiting/)
    expect(fake.called("updateIssue")).toEqual([])
    expect(listNew(paths.inbox).map((e) => e.key)).toEqual(expect.arrayContaining(["msg_CQ_1700.7"]))
  })

  it("leaves the message waiting when Linear refuses, so nothing is lost", async () => {
    const { go, outbox } = ctl("On hold", ["polads", "agent-ready", "awaiting-answer"], ["updateIssue"])
    const key = reply("1700.8", "yes")
    await expect(go(["decide", "--key", key, "--agree"])).rejects.toThrow()
    expect(listNew(paths.inbox)).toHaveLength(1)
    expect(outbox()).toEqual([])
  })
})

describe("the first answer counts, in Slack (Wave 2)", () => {
  // Slack timestamps just after the question, which went out at NOW.
  const NATE_TS = "1790330410.000100"
  const BEN_TS = "1790330440.000100"
  const BEN = { user: "UBEN", userName: "Ben" }

  it("a yes after the question was answered, agreeing to the same recommendation, records nothing new and says so", async () => {
    const { fake, go, outbox } = ctl()
    expect(await go(["decide", "--key", reply(NATE_TS, "yes"), "--agree"])).toBe(0)
    const before = fake.issues.get("STEP-7")!.description
    const key = reply(BEN_TS, "yes", BEN)
    expect(await go(["decide", "--key", key, "--agree"])).toBe(0)
    expect(fake.called("updateIssue")).toHaveLength(1)
    expect(fake.issues.get("STEP-7")!.description).toBe(before)
    expect(outbox().slice(-2)).toEqual([
      expect.objectContaining({ kind: "reply", text: "Thanks, Ben. Nate gave the same answer already, so it stands as it is. Nothing needed from you." }),
      expect.objectContaining({ kind: "react", name: "white_check_mark" }),
    ])
    expect(listNew(paths.inbox)).toEqual([])
    expect(readFileSync(join(paths.logs, "ledger.jsonl"), "utf8")).toContain('"type":"answer.same","issue":"STEP-7"')
  })

  it("a second person's different decision is kept but not applied, and they are asked what they meant as a new question", async () => {
    const { fake, go, outbox } = ctl()
    expect(await go(["decide", "--key", reply(NATE_TS, "yes"), "--agree"])).toBe(0)
    const moved = fake.issues.get("STEP-7")!
    const key = reply(BEN_TS, "no, the signing date", BEN)
    const file = join(paths.root, "ben.md")
    writeFileSync(file, "use the signing date\n")
    expect(await go(["decide", "--key", key, "--text-file", file])).toBe(0)
    const after = fake.issues.get("STEP-7")!
    expect({ state: after.state, labels: after.labels }).toEqual({ state: moved.state, labels: moved.labels })
    expect(after.description).toContain('Ben decided: use the signing date. (Their words: "no, the signing date") (Not applied: Nate answered first.)')
    expect(outbox().at(-1)).toEqual(expect.objectContaining({ kind: "issue", issue: "STEP-7", question: true, text: expect.stringMatching(/^Nate answered this first in Slack: use the publication date\. That answer counts/) }))
    expect(listNew(paths.inbox)).toEqual([])
    expect(readFileSync(join(paths.logs, "ledger.jsonl"), "utf8")).toContain('"type":"answer.second","issue":"STEP-7"')
  })
})

/** The bridge's outbox sender, posting whatever is queued at `at`, as the Slack bridge does. */
async function deliver(at: Date): Promise<void> {
  const web = { postMessage: async () => ({ ts: "1700.99" }), permalink: async () => null, react: async () => {} }
  const ctx: SendContext = { paths, mini: "eve", channelIds: { agents: "CAG", questions: "CQ", intake: "CIN", releases: "CREL" }, web, describeIssue: async () => null, attachThread: async () => {}, now: () => at }
  for (const { key, payload } of listNew<Parameters<typeof sendOutboxMessage>[1]>(paths.outbox)) {
    await sendOutboxMessage(ctx, payload)
    rmOutbox(key)
  }
}
const rmOutbox = (key: string) => ack(paths.outbox, key)

/** A reply as the bridge files it now: with the thread as it stood (slack/bridge.ts), which then counts its questions afresh. */
function filedReply(ts: string, text: string, at: Date): string {
  const thread = threadFor(paths, "STEP-7")
  const key = reply(ts, text, {
    receivedAt: at.toISOString(), lastQuestion: thread?.lastQuestion ?? null, lastQuestionAt: thread?.lastQuestionAt ?? null,
    lastReplyAt: thread?.lastReplyAt ?? null, openQuestions: thread?.openQuestions ?? 0,
  })
  if (thread) saveThread(paths, { ...thread, openQuestions: 0 })
  return key
}

describe("a question back (STEP-3293 review)", () => {
  it("is answered with a new question and recommendation, so a later yes agrees to the new one, never the first", async () => {
    // The reviewer's proof, turned round: Eve recommended A, Nate asked what
    // she recommends given the legal rule, she now recommends B, and Nate says
    // yes. A slack reply left the thread's question at A, and the yes recorded A.
    const { fake, go, outbox } = ctl()
    const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)
    const back = filedReply("1700.9", "what do you recommend, given the legal rule?", later(1))
    await expect(
      go(["slack", "reply", "--channel", "CQ", "--thread", "1700.1", "--text", "Given the legal rule, the submission date is safer.\n\nMy recommendation: use the submission date. Reply yes to go with it, or tell me what you want instead."]),
    ).rejects.toThrow(/a reply that recommends something is a question: post it with agentctl ask/)
    expect(outbox()).toEqual([])
    expect(await go(["ask", "--issue", "STEP-7", "--text", "Given the legal rule, the submission date is safer.", "--recommendation", "use the submission date"])).toBe(0)
    expect(await go(["ack", back])).toBe(0)
    await deliver(later(2))
    // The issue keeps waiting.
    expect(fake.called("updateIssue")).toEqual([])
    const yes = filedReply("1700.10", "yes", later(3))
    expect(await go(["decide", "--key", yes, "--agree"])).toBe(0)
    expect(fake.issues.get("STEP-7")!.description).toContain('Nate agreed with the recommendation: use the submission date. (Their words: "yes")')
    expect(fake.issues.get("STEP-7")!.description).not.toContain("use the publication date")
  })

  it("refuses to agree for a reply a newer question came after: their yes never saw it", async () => {
    const { fake, go } = ctl()
    const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)
    const yes = filedReply("1700.11", "yes", later(1))
    // agentd asks a question of its own before the front door gets to the yes.
    expect(await go(["ask", "--issue", "STEP-7", "--text", "Shall I also fix the footer?", "--recommendation", "fix the footer too"])).toBe(0)
    await deliver(later(2))
    await expect(go(["decide", "--key", yes, "--agree"])).rejects.toThrow(/a new question went to the STEP-7 thread after this reply/)
    // A reply filed before this change carries no question: the thread's stands in, unless it came after the reply.
    const old = reply("1700.12", "yes", { receivedAt: later(1).toISOString() })
    await expect(go(["decide", "--key", old, "--agree"])).rejects.toThrow(/a new question went to the STEP-7 thread after this reply/)
    expect(fake.called("updateIssue")).toEqual([])
  })
})

describe("a yes that says nothing certain (STEP-3293 re-review)", () => {
  const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)

  it("refuses to agree when the front door wrote in the thread after the question: a recommendation in other words", async () => {
    // The reviewer's residual, turned round: a paraphrased recommendation in slack reply passes, and a later yes used to record the old one.
    const { fake, go } = ctl()
    const file = join(paths.root, "reply.md")
    writeFileSync(file, "Given the legal rule I would now go with the submission date instead. Say yes and I will use it.\n")
    expect(await go(["slack", "reply", "--channel", "CQ", "--thread", "1700.1", "--text-file", file])).toBe(0)
    await deliver(later(1))
    expect(threadFor(paths, "STEP-7")?.lastReplyAt).toBe(later(1).toISOString())
    const yes = filedReply("1700.30", "yes", later(2))
    await expect(go(["decide", "--key", yes, "--agree"])).rejects.toThrow(/I wrote in the STEP-7 thread after that question, so their yes may answer what I said there/)
    expect(fake.called("updateIssue")).toEqual([])
    // Asked again as a question, the next yes agrees to it.
    expect(await go(["ask", "--issue", "STEP-7", "--text", "Shall I use the submission date?", "--recommendation", "use the submission date"])).toBe(0)
    await deliver(later(3))
    const again = filedReply("1700.31", "yes", later(4))
    expect(await go(["decide", "--key", again, "--agree"])).toBe(0)
    expect(fake.issues.get("STEP-7")!.description).toContain("Nate agreed with the recommendation: use the submission date.")
  })

  it("refuses to agree when more than one question was open: /refine asks in one question", async () => {
    const { fake, go } = ctl()
    expect(await go(["ask", "--issue", "STEP-7", "--text", "Which date?", "--recommendation", "the publication date"])).toBe(0)
    expect(await go(["ask", "--issue", "STEP-7", "--text", "And the footer?", "--recommendation", "leave the footer"])).toBe(0)
    await deliver(later(1))
    expect(threadFor(paths, "STEP-7")?.openQuestions).toBe(2)
    const yes = filedReply("1700.32", "yes", later(2))
    await expect(go(["decide", "--key", yes, "--agree"])).rejects.toThrow(/2 questions were open in the STEP-7 thread when they replied, so a yes does not say which/)
    expect(fake.called("updateIssue")).toEqual([])
    // Their reply counted the questions afresh: one question now, and a yes agrees to it.
    expect(await go(["ask", "--issue", "STEP-7", "--text", "Publication date, footer left as it is?", "--recommendation", "the publication date, and the footer as it is"])).toBe(0)
    await deliver(later(3))
    expect(await go(["decide", "--key", filedReply("1700.33", "yes", later(4)), "--agree"])).toBe(0)
    // An answer leaves no question open.
    expect(threadFor(paths, "STEP-7")?.openQuestions).toBe(0)
  })
})

describe("a hand-off (STEP-3293 review)", () => {
  it("asks for a person's hands with no recommendation, and a yes there records no decision", async () => {
    const { fake, go, outbox } = ctl("On hold", ["polads", "human-todo"])
    expect(await go(["ask", "--issue", "STEP-7", "--text", "Needs a person: rotate the Mapbox key in the Mapbox console.", "--handoff"])).toBe(0)
    expect(outbox()).toEqual([expect.objectContaining({ kind: "issue", issue: "STEP-7", question: true, text: "Needs a person: rotate the Mapbox key in the Mapbox console.\n\nReply done when it is done." })])
    await expect(go(["ask", "--issue", "STEP-7", "--text", "Needs a person: x.", "--handoff", "--recommendation", "do x"])).rejects.toThrow(/carries no recommendation/)
    // An older question in the thread had a recommendation: still no yes on a person's to-do.
    const yes = reply("1700.13", "yes")
    await expect(go(["decide", "--key", yes, "--agree"])).rejects.toThrow(/STEP-7 waits on a person to do something \(human-todo\), so a yes is not a decision/)
    expect(fake.called("updateIssue")).toEqual([])
    const done = reply("1700.14", "done, the new key is in")
    const file = join(paths.root, "done.md")
    writeFileSync(file, "the Mapbox key is rotated\n")
    expect(await go(["decide", "--key", done, "--text-file", file])).toBe(0)
    expect(fake.issues.get("STEP-7")!.description).toContain('Nate decided: the Mapbox key is rotated. (Their words: "done, the new key is in")')
  })
})

describe("agentctl instruct", () => {
  it("files the fixed actions for agentd with the bridge's person and words, and agentd acts as it did (STEP-3285)", async () => {
    const { go } = ctl("In Review", ["polads", "agent-ready"])
    recordPr(paths, { issue: "STEP-7", url: PR, openedAt: NOW.toISOString() })
    const key = reply("1700.10", "sort it out and merge it, please")
    expect(await go(["instruct", "--key", key, "--actions", "revise,merge"])).toBe(0)
    const filed = listNew<Record<string, unknown>>(paths.inbox).map((e) => e.payload)
    expect(filed).toEqual([
      expect.objectContaining({
        type: "instruction", key: "instr:CQ:1700.10", issue: "STEP-7", user: "UNATE", userName: "Nate", text: "sort it out and merge it, please", actions: ["revise", "merge"],
      }),
    ])
    const view = { url: PR, number: 1679, state: "OPEN", headRefName: "STEP-7-fix-the-date", headRefOid: "abc", baseRefName: "staging", statusCheckRollup: [] }
    const f = fakeExec([[/^gh pr view /, { stdout: JSON.stringify(view) }]])
    const config = ConfigSchema.parse(JSON.parse(readFileSync(paths.config, "utf8")))
    await actOnInstructions({ exec: f.exec, paths, config, now: () => NOW, log: { info() {}, warn() {}, error() {} } })
    expect(listJobs(paths, "pending")).toEqual([expect.objectContaining({ issue: "STEP-7", kind: "revise" })])
    expect(f.lines()).toContain(`gh pr merge ${PR} --auto --squash --delete-branch`)
  })

  it("takes the default of agentd's own question for a yes, and refuses an action it does not know or a mention with no target", async () => {
    const { go } = ctl("In Review", ["polads", "agent-ready"])
    const config = ConfigSchema.parse(JSON.parse(readFileSync(paths.config, "utf8")))
    askDecision(paths, config, {
      id: "infra-STEP-7-abc", issue: "STEP-7", url: PR, question: "The checks failed again for no reason of the code's.",
      options: [{ reply: "re-run", does: "have me start them once more" }, { reply: "leave it", does: "leave the PR to a person" }],
      defaultReply: "re-run", defaultAction: { kind: "rerun", runs: ["111"] },
    }, NOW)
    const yes = reply("1700.11", "yes")
    expect(await go(["instruct", "--key", yes, "--actions", "default"])).toBe(0)
    expect(listNew<{ type: string; actions?: string[] }>(paths.inbox).map((e) => e.payload).find((p) => p.type === "instruction")?.actions).toEqual(["rerun"])
    const other = reply("1700.12", "do the thing")
    await expect(go(["instruct", "--key", other, "--actions", "deploy"])).rejects.toThrow(/deploy is not an action agentd takes/)
    putOnce(paths.inbox, "msg:CAG:1900.1", { type: "mention", key: "msg:CAG:1900.1", issue: null, channel: "CAG", ts: "1900.1", threadTs: "1900.1", user: "UNATE", userName: "Nate", text: "<@UBOT> merge it", receivedAt: NOW.toISOString() })
    await expect(go(["instruct", "--key", "msg:CAG:1900.1", "--actions", "merge"])).rejects.toThrow(/Nate's words name no issue or PR for merge: ask them which/)
    // The front door cannot pick the PR for them (STEP-3293 re-review).
    await expect(go(["instruct", "--key", "msg:CAG:1900.1", "--actions", "merge", "--target", "#1679"])).rejects.toThrow(/Nate's words name no issue or PR, so there is no target to give/)
    putOnce(paths.inbox, "msg:CAG:1900.3", { type: "mention", key: "msg:CAG:1900.3", issue: null, channel: "CAG", ts: "1900.3", threadTs: "1900.3", user: "UNATE", userName: "Nate", text: "<@UBOT> merge #1679", receivedAt: NOW.toISOString() })
    expect(await go(["instruct", "--key", "msg:CAG:1900.3", "--actions", "merge"])).toBe(0)
    expect(listNew<{ key: string; target?: unknown }>(paths.inbox).map((e) => e.payload).find((p) => p.key === "instr:CAG:1900.3")?.target).toEqual({ pr: 1679 })
  })

  it("takes the target from the person's words, never from the front door (STEP-3293 re-review)", async () => {
    // The reviewer's proofs, turned round.
    const { go } = ctl("In Review", ["polads", "agent-ready"])
    recordPr(paths, { issue: "STEP-7", url: PR, openedAt: NOW.toISOString() })
    const mention = (ts: string, text: string) => {
      const key = `msg:CAG:${ts}`
      putOnce(paths.inbox, key, { type: "mention", key, issue: null, channel: "CAG", ts, threadTs: ts, user: "UNATE", userName: "Nate", text, receivedAt: NOW.toISOString() })
      return key
    }
    await expect(go(["instruct", "--key", mention("1901.1", "<@UBOT> please merge it"), "--actions", "merge", "--target", "#1704"])).rejects.toThrow(/name no issue or PR/)
    // A different kind of target is compared too.
    await expect(go(["instruct", "--key", mention("1901.2", "<@UBOT> merge STEP-7"), "--actions", "merge", "--target", "#1704"])).rejects.toThrow(/Nate named STEP-7, so the target must be that/)
    await expect(go(["instruct", "--key", mention("1901.3", "<@UBOT> merge https://github.com/STEP-Network/polads/pull/1704"), "--actions", "merge", "--target", "STEP-9"])).rejects.toThrow(/Nate named #1704, so the target must be that/)
    // A reply acts on its thread's issue: other words are a question for them.
    await expect(go(["instruct", "--key", reply("1901.4", "merge STEP-9 instead"), "--actions", "merge"])).rejects.toThrow(/Nate named STEP-9 in the STEP-7 thread: ask them which they mean/)
    await expect(go(["instruct", "--key", reply("1901.5", "merge #1704"), "--actions", "merge"])).rejects.toThrow(/Nate named #1704, which is not STEP-7's PR/)
    await expect(go(["instruct", "--key", reply("1901.6", "merge it"), "--actions", "merge", "--target", "#1704"])).rejects.toThrow(/the target is this thread's, STEP-7/)
    expect(listNew<{ type: string }>(paths.inbox).map((e) => e.payload).filter((p) => p.type === "instruction")).toEqual([])
    // Its own PR, named, is fine.
    expect(await go(["instruct", "--key", reply("1901.7", "merge #1679"), "--actions", "merge"])).toBe(0)
    // And a plain "@eve pause" needs no target at all: a pause is the whole mini's.
    expect(await go(["instruct", "--key", mention("1901.8", "<@UBOT> pause everything"), "--actions", "pause"])).toBe(0)
    const filed = listNew<{ key: string; type: string; actions?: string[]; target?: unknown }>(paths.inbox).map((e) => e.payload).filter((p) => p.type === "instruction")
    expect(Object.fromEntries(filed.map((p) => [p.key, [p.actions, p.target]]))).toEqual({
      "instr:CQ:1901.7": [["merge"], { pr: 1679 }],
      "instr:CAG:1901.8": [["pause"], {}],
    })
  })

  it("takes agentd's default only for a yes to a decision asked before it (STEP-3293 re-review)", async () => {
    const { go } = ctl("In Review", ["polads", "agent-ready"])
    const early = reply("1902.1", "yes", { receivedAt: new Date(NOW.getTime() - 60_000).toISOString() })
    const config = ConfigSchema.parse(JSON.parse(readFileSync(paths.config, "utf8")))
    askDecision(paths, config, {
      id: "infra-STEP-7-late", issue: "STEP-7", url: PR, question: "The checks failed again for no reason of the code's.",
      options: [{ reply: "re-run", does: "have me start them once more" }, { reply: "leave it", does: "leave the PR to a person" }],
      defaultReply: "re-run", defaultAction: { kind: "rerun", runs: ["111"] },
    }, NOW)
    await expect(go(["instruct", "--key", early, "--actions", "default"])).rejects.toThrow(/agentd asked its question in STEP-7 after this reply, so their yes was not to it/)
    expect(await go(["instruct", "--key", reply("1902.2", "yes"), "--actions", "default"])).toBe(0)
  })

  it("files only what the person's own words ask for, never more (STEP-3293 review)", async () => {
    // Any text the front door reads (an issue, a PR, a log) could tell it to
    // file revise, retry or merge for someone: the words decide, not it.
    const { go } = ctl("In Review", ["polads", "agent-ready"])
    const config = ConfigSchema.parse(JSON.parse(readFileSync(paths.config, "utf8")))
    const question = reply("1700.20", "what do you recommend?")
    await expect(go(["instruct", "--key", question, "--actions", "revise"])).rejects.toThrow(/Nate's words do not ask for revise \(they asked for none of the actions\)/)
    const merge = reply("1700.21", "merge it please")
    await expect(go(["instruct", "--key", merge, "--actions", "merge,retry"])).rejects.toThrow(/Nate's words do not ask for retry \(they asked for merge\)/)
    askDecision(paths, config, {
      id: "cap-STEP-7-abc", issue: "STEP-7", url: PR, question: "Three rounds and the checks still fail.",
      options: [{ reply: "fix it", does: "revise once more" }, { reply: "leave it", does: "leave the PR to a person" }],
      defaultReply: "leave it", defaultAction: { kind: "leave" },
    }, NOW)
    const notYes = reply("1700.22", "hmm, not sure yet")
    await expect(go(["instruct", "--key", notYes, "--actions", "default"])).rejects.toThrow(/did not just say yes/)
    putOnce(paths.inbox, "msg:CAG:1900.2", { type: "mention", key: "msg:CAG:1900.2", issue: null, channel: "CAG", ts: "1900.2", threadTs: "1900.2", user: "UNATE", userName: "Nate", text: "<@UBOT> merge #1679", receivedAt: NOW.toISOString() })
    await expect(go(["instruct", "--key", "msg:CAG:1900.2", "--actions", "merge", "--target", "#1700"])).rejects.toThrow(/Nate named #1679, so the target must be that/)
    expect(listNew<{ type: string }>(paths.inbox).map((e) => e.payload).filter((p) => p.type === "instruction")).toEqual([])
  })

  it("skips what the bridge did already, and files the rest", async () => {
    const { go } = ctl("In Review", ["polads", "agent-ready"])
    const both = reply("1700.23", "pause, and fix the failing test when you are back", { acted: ["pause"] })
    expect(await go(["instruct", "--key", both, "--actions", "pause,revise"])).toBe(0)
    expect(listNew<{ type: string; actions?: string[] }>(paths.inbox).map((e) => e.payload)).toEqual([expect.objectContaining({ type: "instruction", actions: ["revise"] })])
    const only = reply("1700.24", "pause please", { acted: ["pause"] })
    const printed: string[] = []
    expect(await run(["instruct", "--key", only, "--actions", "pause"], (l) => void printed.push(l), { tracker: () => fakeTracker([]).tracker, exec: fakeExec().exec, now: () => NOW, env: {}, isTTY: () => false })).toBe(0)
    expect(JSON.parse(printed[0])).toEqual({ filed: null, doneByBridge: ["pause"] })
    expect(listNew(paths.inbox).map((e) => e.key)).not.toContain("msg_CQ_1700.24")
  })
})
