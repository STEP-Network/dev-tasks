import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew, putOnce } from "../../fsq.ts"
import { listJobs, moveJob, readWatchedPrs, recordPr, submitJob, updateWatchedPr } from "../../jobs.ts"
import type { Logger } from "../../log.ts"
import { mondayOutbox } from "../../monday/store.ts"
import { parseInstruction, type InstructionEntry, type MondayInstructionEntry } from "../../slack/instruction.ts"
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
        text: `Revising ${PR} now: job ${job.id} (round 1).\nAuto-merge armed on ${PR}: it merges into staging after the revision, once the required checks and the review are green.`,
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
    expect(off.outbox()[0].text).toBe(`I cannot merge ${PR}: auto-merge is off on this mini (worker.autoMerge in its config.json), so a person merges it.`)
    const manual = setup({ policy: "manual" })
    manual.say("merge")
    await actOnInstructions(manual.deps)
    expect(manual.f.lines().some((l) => l.startsWith("gh pr merge"))).toBe(false)
    expect(manual.outbox()[0].text).toBe(`I cannot merge ${PR}: the project's policy for staging leaves merging to a person.`)
  })

  it("re-runs each failing required run in full, never --failed", async () => {
    const { deps, f, paths, say, outbox } = setup()
    say("re-run it")
    await actOnInstructions(deps)
    expect(f.lines().filter((l) => l.startsWith("gh run rerun"))).toEqual([`gh run rerun 111 --repo ${SLUG}`])
    expect(f.lines().some((l) => /\s--failed\b/.test(l))).toBe(false)
    expect(outbox()[0].text).toBe(`Re-running CI on ${PR} in full: run 111.`)
    expect(readWatchedPrs(paths)[0].reruns).toEqual(["abc1234def:111"])
  })

  it("retries the issue's last blocked job on its branch, and says when there is none", async () => {
    const { deps, paths, say, outbox } = setup()
    const blocked = submitJob(paths, "STEP-7", "opus", new Date("2026-09-25T07:00:00.000Z"))
    moveJob(paths, blocked.id, "pending", "done", { endedAt: "2026-09-25T07:30:00.000Z", result: { status: "blocked", reason: "the report has no PR title", prUrl: null, branch: null, costUsd: null, turns: null, minutes: 5 } })
    say("retry")
    await actOnInstructions(deps)
    expect(listJobs(paths, "pending")).toEqual([expect.objectContaining({ issue: "STEP-7", model: "opus", retryOf: blocked.id })])
    expect(outbox()[0].text).toMatch(new RegExp(`^Retrying STEP-7 on its branch: job STEP-7-\\d+, after ${blocked.id} ended blocked \\(the report has no PR title\\)\\.$`))
    const none = setup()
    none.say("retry")
    await actOnInstructions(none.deps)
    expect(none.outbox()[0].text).toBe("STEP-7's last job did not end blocked, so there is nothing to retry.")
  })

  it("pauses the mini, and never lifts a pause", async () => {
    const { deps, paths, say, outbox } = setup()
    say("pause for now")
    await actOnInstructions(deps)
    expect(JSON.parse(readFileSync(paths.pauseFile, "utf8"))).toEqual({ at: NOW.toISOString(), reason: "asked by Nate in Slack" })
    expect(outbox()[0].text).toMatch(/^Paused: no new job starts.*agentctl resume\.$/)
    say("pause")
    await actOnInstructions(deps)
    expect(existsSync(paths.pauseFile)).toBe(true)
    expect(outbox().filter((m) => m.kind === "reply").at(-1)?.text).toBe("This mini is paused already. A person lifts it on the mini with agentctl resume.")
  })

  it("revises past the round cap because a person asked, and not twice at once", async () => {
    const { deps, paths, say, outbox } = setup()
    updateWatchedPr(paths, { issue: "STEP-7", url: PR, openedAt: "t", revise: { rounds: 3, handled: [], asked: true } })
    say("fix it")
    await actOnInstructions(deps)
    const [job] = listJobs(paths, "pending")
    expect(job.revise?.round).toBe(4)
    expect(outbox()[0].text).toBe(`Revising ${PR} now: job ${job.id} (round 4, past the 3-round cap since you asked).`)
    say("fix it")
    await actOnInstructions(deps)
    expect(listJobs(paths, "pending")).toHaveLength(1)
    expect(outbox().filter((m) => m.kind === "reply").at(-1)?.text).toBe(`Already on it: job ${job.id} is queued.`)
  })

  it("finds a mentioned PR of this mini's by number, and asks which PR when it cannot tell", async () => {
    const { deps, paths, say, outbox } = setup({ failing: false })
    say("fix #1679", { issue: null, target: { pr: 1679 } })
    say("fix #1234", { issue: null, target: { pr: 1234 } })
    await actOnInstructions(deps)
    expect(listJobs(paths, "pending")).toEqual([expect.objectContaining({ issue: "STEP-7", kind: "revise" })])
    expect(outbox().filter((m) => m.kind === "reply").map((m) => m.text)).toContain(
      "I could not tell which PR you mean. Name it (STEP-<n>, #<number> or its link): I act only on PRs this mini opened.",
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

  it("answers words from the Monday board on the item, with a like beside them, and nothing in Slack (STEP-3289)", async () => {
    const { deps, paths, outbox } = setup()
    const monday = (key: string, text: string, where: MondayInstructionEntry["monday"]) =>
      putOnce(paths.inbox, key, {
        type: "instruction", key, issue: "STEP-7", user: "111", userName: "Nate", text, ...parseInstruction(text),
        receivedAt: NOW.toISOString(), monday: where,
      } satisfies MondayInstructionEntry)
    monday("instr_monday_9001", "fix it", { itemId: "555", updateId: "9002", threadId: "9001" })
    await actOnInstructions(deps)
    const [job] = listJobs(paths, "pending")
    expect(job.revise?.reasons).toEqual(["asked by Nate on the Monday board"])
    expect(outbox()).toEqual([])
    const replies = () => listNew<{ itemId: string; threadId: string | null; text: string; like: string | null }>(mondayOutbox(paths)).map((e) => e.payload)
    expect(replies()).toEqual([expect.objectContaining({ itemId: "555", threadId: "9001", like: "9002", text: `Revising ${PR} now: job ${job.id} (round 1).` })])
    // The Answer column has no update to reply under or to like: a new update on the item.
    monday("instr_monday_log_77", "pause", { itemId: "555", updateId: null, threadId: null })
    await actOnInstructions(deps)
    expect(replies()[1]).toMatchObject({ itemId: "555", threadId: null, like: null, text: expect.stringMatching(/^Paused: no new job starts/) })
    expect(JSON.parse(readFileSync(paths.pauseFile, "utf8")).reason).toBe("asked by Nate on the Monday board")
    expect(outbox()).toEqual([])
  })
})
