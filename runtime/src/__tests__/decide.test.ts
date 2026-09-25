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
import { listNew, putOnce } from "../fsq.ts"
import { listJobs, recordPr } from "../jobs.ts"
import { saveThread } from "../threads.ts"
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
      expect.objectContaining({ kind: "reply", text: "Thanks. I added your decision to STEP-7: Nate agreed with the recommendation: use the publication date. It goes back to Ready. Nothing needed from you." }),
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

describe("a question back", () => {
  it("is answered in the thread and acked, and the issue keeps waiting", async () => {
    const { fake, go, outbox } = ctl()
    const key = reply("1700.9", "what do you recommend?")
    await go(["slack", "reply", "--channel", "CQ1", "--thread", "1700.1", "--text", "The publication date: it is what the notice already shows. Reply yes to go with it."])
    await go(["ack", key])
    expect(fake.called("updateIssue")).toEqual([])
    expect(fake.issues.get("STEP-7")).toMatchObject({ state: "On hold", labels: ["polads", "agent-ready", "awaiting-answer"] })
    expect(listNew(paths.inbox)).toEqual([])
    expect(outbox()).toEqual([expect.objectContaining({ kind: "reply", threadTs: "1700.1" })])
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
    await expect(go(["instruct", "--key", "msg:CAG:1900.1", "--actions", "merge"])).rejects.toThrow(/names no issue or PR/)
    expect(await go(["instruct", "--key", "msg:CAG:1900.1", "--actions", "merge", "--target", "#1679"])).toBe(0)
  })
})
