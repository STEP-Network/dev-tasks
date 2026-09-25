import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew, putOnce } from "../../fsq.ts"
import { listJobs, moveJob, readWatchedPrs, recordPr, submitJob, updateWatchedPr } from "../../jobs.ts"
import type { Logger } from "../../log.ts"
import { parseInstruction, type InstructionEntry } from "../../slack/instruction.ts"
import type { ExecResult } from "../../worker/git.ts"
import { fakeExec } from "../../__tests__/fakes.ts"
import { askDecision, openDecisions } from "../decisions.ts"
import { actOnInstructions } from "../instructions.ts"

const quiet: Logger = { info() {}, warn() {}, error() {} }
const NOW = new Date("2026-09-25T09:00:00.000Z")
const PR = "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1679"
const SLUG = "STEP-Network/v0-politiske-annoncer"

function setup(opts: { worker?: Record<string, unknown>; policy?: string; state?: string; failing?: boolean; exec?: Array<[RegExp, Partial<ExecResult>]> } = {}) {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-instr-")))
  const repo = mkdtempSync(join(tmpdir(), "repo-"))
  mkdirSync(join(repo, ".claude"))
  writeFileSync(
    join(repo, ".claude", "project-config.json"),
    JSON.stringify({ git: { autoMergePolicy: { staging: opts.policy ?? "auto-after-checks-and-review" } }, ci: { requiredChecks: ["Test", "Claude review"] } }),
  )
  const config = ConfigSchema.parse({ mini: "eve", repo: { path: repo }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] }, worker: opts.worker })
  recordPr(paths, { issue: "STEP-7", url: PR, openedAt: "2026-09-25T07:00:00.000Z" })
  const view = {
    url: PR, number: 1679, state: opts.state ?? "OPEN", headRefName: "STEP-7-fix-the-date", headRefOid: "abc1234def", baseRefName: "staging",
    statusCheckRollup: opts.failing === false ? [] : [{ name: "Test", conclusion: "FAILURE", detailsUrl: "https://github.com/x/actions/runs/111/job/222" }],
  }
  const f = fakeExec([...(opts.exec ?? []), [/^gh pr view /, { stdout: JSON.stringify(view) }]])
  const deps = { exec: f.exec, paths, config, now: () => NOW, log: quiet }
  const say = (text: string, over: Partial<InstructionEntry> = {}) => {
    const key = `instr:CQ:${Math.random().toString().slice(2, 8)}.1`
    const ts = key.split(":")[2]
    putOnce(paths.inbox, key, {
      type: "instruction", key, issue: "STEP-7", channel: "CQ", ts, threadTs: "1700.1", user: "UNATE", userName: "Nate", text,
      ...parseInstruction(text), receivedAt: NOW.toISOString(), ...over,
    } satisfies InstructionEntry)
    return ts
  }
  const outbox = () => listNew<{ kind: string; text?: string; name?: string; ts?: string; threadTs?: string }>(paths.outbox).map((e) => e.payload)
  return { paths, config, f, deps, say, outbox }
}

describe("actOnInstructions (STEP-3285)", () => {
  it("turns 'fix it and merge' into a revise job now, arms auto-merge, and says so in words", async () => {
    const { deps, f, paths, say, outbox } = setup()
    const ts = say("fix it and merge")
    await actOnInstructions(deps)
    const [job] = listJobs(paths, "pending")
    expect(job).toMatchObject({
      issue: "STEP-7", kind: "revise",
      revise: { url: PR, number: 1679, branch: "STEP-7-fix-the-date", round: 1, reasons: ["asked by Nate in Slack"], instruction: "fix it and merge" },
    })
    expect(f.lines()).toContain(`gh pr merge ${PR} --auto --squash --delete-branch`)
    expect(f.lines().some((l) => /--admin/.test(l))).toBe(false)
    expect(outbox()).toEqual([
      expect.objectContaining({
        kind: "reply", channelId: "CQ", threadTs: "1700.1",
        text: `I am fixing <${PR}|PR #1679> now, as you asked.\n<${PR}|PR #1679> will go into staging by itself after my fixes, once the checks and the review pass.\nNothing needed from you.`,
      }),
      expect.objectContaining({ kind: "react", ts, name: "white_check_mark" }),
    ])
    expect(listNew(paths.inbox)).toEqual([])
    expect(readWatchedPrs(paths)[0].revise).toMatchObject({ rounds: 1, lastRoundAt: NOW.toISOString() })
  })

  it("never sends a ✅ without words before it, whatever the reply asked", async () => {
    const { deps, say, outbox } = setup({ failing: false })
    for (const text of ["merge", "re-run", "retry", "pause", "leave it", "fix it"]) say(text)
    say("fix it", { issue: null, target: {} })
    await actOnInstructions(deps)
    const sent = outbox()
    expect(sent.filter((m) => m.kind === "react")).toHaveLength(7)
    sent.forEach((m, i) => {
      if (m.kind !== "react") return
      expect(sent[i - 1], `react ${i}`).toMatchObject({ kind: "reply", text: expect.stringMatching(/\w/) })
    })
  })

  it("explains, and arms nothing, when this mini or the project leaves merging to a person", async () => {
    const off = setup({ worker: { autoMerge: false } })
    off.say("merge")
    await actOnInstructions(off.deps)
    expect(off.f.lines().some((l) => l.startsWith("gh pr merge"))).toBe(false)
    expect(off.outbox()[0].text).toBe(`I cannot merge <${PR}|PR #1679> myself, because merging by myself is turned off on this mini. A person needs to merge it once the checks pass.`)
    const manual = setup({ policy: "manual" })
    manual.say("merge")
    await actOnInstructions(manual.deps)
    expect(manual.f.lines().some((l) => l.startsWith("gh pr merge"))).toBe(false)
    expect(manual.outbox()[0].text).toBe(`I cannot merge <${PR}|PR #1679> myself, because a person merges into staging. A person needs to merge it once the checks pass.`)
  })

  it("re-runs each failing required run in full, never --failed", async () => {
    const { deps, f, paths, say, outbox } = setup()
    say("re-run it")
    await actOnInstructions(deps)
    expect(f.lines().filter((l) => l.startsWith("gh run rerun"))).toEqual([`gh run rerun 111 --repo ${SLUG}`])
    expect(f.lines().some((l) => /\s--failed\b/.test(l))).toBe(false)
    expect(outbox()[0].text).toBe(`I started the automatic checks on <${PR}|PR #1679> again.\nNothing needed from you.`)
    expect(readWatchedPrs(paths)[0].reruns).toEqual(["abc1234def:111"])
  })

  it("retries the issue's last blocked job on its branch, and says when there is none", async () => {
    const { deps, paths, say, outbox } = setup()
    const blocked = submitJob(paths, "STEP-7", "opus", new Date("2026-09-25T07:00:00.000Z"))
    moveJob(paths, blocked.id, "pending", "done", { endedAt: "2026-09-25T07:30:00.000Z", result: { status: "blocked", reason: "the report has no PR title", prUrl: null, branch: null, costUsd: null, turns: null, minutes: 5 } })
    say("retry")
    await actOnInstructions(deps)
    expect(listJobs(paths, "pending")).toEqual([expect.objectContaining({ issue: "STEP-7", model: "opus", retryOf: blocked.id })])
    expect(outbox()[0].text).toBe("I am trying STEP-7 again from where I stopped (last time: I finished without writing down what I did).\nNothing needed from you.")
    const none = setup()
    none.say("retry")
    await actOnInstructions(none.deps)
    expect(none.outbox()[0].text).toBe("My last try at STEP-7 did not stop on a problem, so there is nothing to try again.\nNothing needed from you.")
  })

  it("pauses the mini, and never lifts a pause", async () => {
    const { deps, paths, say, outbox } = setup()
    say("pause for now")
    await actOnInstructions(deps)
    expect(JSON.parse(readFileSync(paths.pauseFile, "utf8"))).toEqual({ at: NOW.toISOString(), reason: "asked by Nate in Slack" })
    expect(outbox()[0].text).toBe("Paused, as you asked. I start nothing new and finish what I am doing now. To carry on, a person lifts the pause on the mini.\nNothing needed from you.")
    say("pause")
    await actOnInstructions(deps)
    expect(existsSync(paths.pauseFile)).toBe(true)
    expect(outbox().filter((m) => m.kind === "reply").at(-1)?.text).toBe("I am paused already, so nothing changed. To carry on, a person lifts the pause on the mini.\nNothing needed from you.")
  })

  it("revises past the round cap because a person asked, and not twice at once", async () => {
    const { deps, paths, say, outbox } = setup()
    updateWatchedPr(paths, { issue: "STEP-7", url: PR, openedAt: "t", revise: { rounds: 3, handled: [], asked: true } })
    say("fix it")
    await actOnInstructions(deps)
    const [job] = listJobs(paths, "pending")
    expect(job.revise?.round).toBe(4)
    expect(outbox()[0].text).toBe(`I am fixing <${PR}|PR #1679> now, as you asked. This is try 4, past my usual 3, because you asked.\nNothing needed from you.`)
    say("fix it")
    await actOnInstructions(deps)
    expect(listJobs(paths, "pending")).toHaveLength(1)
    expect(outbox().filter((m) => m.kind === "reply").at(-1)?.text).toBe(`I am already about to work on it, as it is next in line.\nNothing needed from you.`)
  })

  it("finds a mentioned PR of this mini's by number, and asks which PR when it cannot tell", async () => {
    const { deps, paths, say, outbox } = setup({ failing: false })
    say("fix #1679", { issue: null, target: { pr: 1679 } })
    say("fix #1234", { issue: null, target: { pr: 1234 } })
    await actOnInstructions(deps)
    expect(listJobs(paths, "pending")).toEqual([expect.objectContaining({ issue: "STEP-7", kind: "revise" })])
    expect(outbox().filter((m) => m.kind === "reply").map((m) => m.text)).toContain(
      "I could not tell which PR you mean, so I did nothing. Please name it: STEP-<n>, #<number> or its link. I only act on PRs I opened.",
    )
  })

  it("answers the issue's open question, so its default is never taken", async () => {
    const { deps, paths, config, say } = setup()
    askDecision(paths, config, {
      id: "infra-STEP-7-abc", issue: "STEP-7", url: PR, question: "CI failed on its infrastructure again.",
      options: [{ reply: "re-run", does: "re-run CI in full once more" }, { reply: "leave it", does: "leave the PR to a person" }],
      defaultReply: "re-run", defaultAction: { kind: "rerun", runs: ["111"] },
    }, NOW)
    say("leave it")
    await actOnInstructions(deps)
    expect(openDecisions(paths, "STEP-7")).toEqual([])
  })
})
