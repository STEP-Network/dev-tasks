import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew } from "../../fsq.ts"
import { readWatchedPrs } from "../../jobs.ts"
import { fakeExec, fakeTracker, issue } from "../../__tests__/fakes.ts"
import { finalize, prBody, prTitle, type FinalizeContext } from "../finalize.ts"
import type { Outcome } from "../outcome.ts"

const PR = "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1700"
const REPO = "/Users/eve/polads"
const WT = "/Users/eve/.agentd/worktrees/STEP-7-fix-the-date"
const done: Outcome = {
  status: "done", reason: "done", costUsd: 3.1, turns: 42, sessionId: "s",
  report: { status: "done", prTitle: "fix: the notice date", summary: "Uses the publication date.", verification: ["pnpm typecheck: pass"] },
}

function setup(outcomeAhead = "2\n", responses: Array<[RegExp, { code?: number; stdout?: string }]> = [], failOn: string[] = []) {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-fin-")))
  const fake = fakeTracker([issue({ id: "STEP-7", title: "Fix the date", state: "In Progress" })], undefined, failOn)
  const f = fakeExec([...responses, [/rev-list --count/, { stdout: outcomeAhead }], [/gh pr create/, { stdout: `Creating pull request\n${PR}\n` }]])
  const ctx: FinalizeContext = {
    exec: f.exec, tracker: fake.tracker, paths,
    config: ConfigSchema.parse({ mini: "eve", repo: { path: REPO }, pluginRoot: "/p", slack: { allowedUsers: ["U"] } }),
    issue: fake.issues.get("STEP-7")!, branch: "STEP-7-fix-the-date", worktree: WT, autoMerge: true, model: "sonnet", minutes: 37,
    now: () => new Date("2026-09-24T09:00:00.000Z"),
  }
  const outbox = () => listNew<{ kind: string; text: string; question?: boolean }>(paths.outbox).map((e) => e.payload)
  return { ctx, fake, f, paths, outbox }
}

describe("finalize: done", () => {
  it("pushes the issue's branch, opens the PR to staging, arms auto-merge, links it and says so", async () => {
    const { ctx, fake, f, paths, outbox } = setup()
    expect(await finalize(ctx, done)).toEqual({ status: "done", reason: "done", prUrl: PR, pushed: true })
    const lines = f.lines()
    expect(lines).toContain(`git -C ${WT} push -u origin HEAD:refs/heads/STEP-7-fix-the-date`)
    const create = lines.find((l) => l.startsWith("gh pr create"))!
    expect(create).toContain("--base staging --head STEP-7-fix-the-date --title STEP-7: fix: the notice date --body-file")
    expect(lines).toContain(`gh pr merge ${PR} --auto --squash --delete-branch`)
    expect(lines.some((l) => l.includes("--admin"))).toBe(false)
    const body = readFileSync(join(paths.state, "pr-body-STEP-7.md"), "utf8")
    expect(body.split("\n")[0]).toBe("STEP-7")
    expect(body).toContain("Worker: eve, model sonnet, 42 turns, estimated USD 3.10, 37 min.")
    expect(body.trimEnd().endsWith("🤖 Generated with [Claude Code](https://claude.com/claude-code)")).toBe(true)
    expect(fake.called("attachLink")[0]).toEqual(["STEP-7", PR, "PR 1700"])
    expect(fake.issues.get("STEP-7")!.state).toBe("In Review")
    expect(outbox()).toEqual([expect.objectContaining({ kind: "post", text: `STEP-7 PR opened: ${PR} (auto-merge armed)` })])
    expect(readWatchedPrs(paths)).toEqual([{ issue: "STEP-7", url: PR, openedAt: "2026-09-24T09:00:00.000Z" }])
    expect(lines).toContain(`git -C ${REPO} worktree remove --force ${WT}`)
  })

  it("uses the mini's own gh login: gh runs in the main checkout, and no command carries a token (decision 5)", async () => {
    const { ctx, f } = setup()
    await finalize(ctx, done)
    const gh = f.calls.filter((c) => c.line.startsWith("gh "))
    expect(gh.length).toBeGreaterThan(1)
    expect(gh.every((c) => c.cwd === REPO)).toBe(true)
    expect(f.lines().some((l) => /--token|GH_TOKEN|GITHUB_TOKEN|gh[pousr]_|github_pat_/.test(l))).toBe(false)
  })

  it("reuses an open PR instead of opening a second", async () => {
    const { ctx, f } = setup("1\n", [[/gh pr list/, { stdout: `${PR}\n` }]])
    expect((await finalize(ctx, done)).prUrl).toBe(PR)
    expect(f.lines().some((l) => l.startsWith("gh pr create"))).toBe(false)
  })

  it("leaves the merge to a person when the policy says so", async () => {
    const { ctx, f, outbox } = setup()
    await finalize({ ...ctx, autoMerge: false }, done)
    expect(f.lines().some((l) => l.startsWith("gh pr merge"))).toBe(false)
    expect(outbox()[0].text).toBe(`STEP-7 PR opened: ${PR} (a person merges this one)`)
  })

  it("keeps a worktree with uncommitted changes for a person, and says so in the PR", async () => {
    const { ctx, f, paths } = setup("2\n", [[/status --porcelain/, { stdout: "?? notes.md\n" }]])
    await finalize(ctx, done)
    expect(readFileSync(join(paths.state, "pr-body-STEP-7.md"), "utf8")).toContain("The worker left uncommitted changes, which are not in this PR.")
    expect(f.lines().some((l) => l.includes("worktree remove"))).toBe(false)
  })

  it("is blocked, with no push and no PR, when the worker made no commits", async () => {
    const { ctx, fake, f, outbox } = setup("0\n")
    expect(await finalize(ctx, done)).toMatchObject({ status: "blocked", reason: "the worker reported done but made no commits", pushed: false })
    expect(f.lines().some((l) => l.includes(" push "))).toBe(false)
    expect(f.lines().some((l) => l.startsWith("gh pr"))).toBe(false)
    expect(fake.issues.get("STEP-7")!.state).toBe("On hold")
    expect(outbox().map((m) => m.kind)).toEqual(["issue", "post"])
  })

  it("has the PR recorded and announced before Linear is asked, so a Linear failure loses neither", async () => {
    const { ctx, paths, outbox } = setup("2\n", [], ["attachLink"])
    await expect(finalize(ctx, done)).rejects.toThrow(/Linear: attachLink failed/)
    expect(readWatchedPrs(paths).map((p) => p.url)).toEqual([PR])
    expect(outbox().map((m) => m.text)).toEqual([`STEP-7 PR opened: ${PR} (auto-merge armed)`])
  })
})

describe("finalize: the other outcomes", () => {
  it("needs_input parks with awaiting-answer and puts the question in the issue's thread", async () => {
    const { ctx, fake, f, outbox } = setup("1\n")
    const outcome: Outcome = { ...done, status: "needs_input", reason: "a question", report: { status: "needs_input", summary: "Two readings.", question: "Which date?" } }
    expect(await finalize(ctx, outcome)).toMatchObject({ status: "needs_input", pushed: true, prUrl: null })
    expect(fake.issues.get("STEP-7")).toMatchObject({ state: "On hold", labels: ["awaiting-answer"] })
    expect(outbox()[0]).toEqual(expect.objectContaining({ kind: "issue", text: "Which date?", question: true }))
    expect(outbox()[1].text).toBe("STEP-7 parked: waiting for an answer in its Slack thread")
    expect(f.lines().some((l) => l.startsWith("gh pr create"))).toBe(false)
  })

  it("limited goes back to Ready, still held, with a comment and no Slack", async () => {
    const { ctx, fake, outbox } = setup("0\n")
    await finalize(ctx, { ...done, status: "limited", reason: "the subscription usage limit", report: null })
    expect(fake.issues.get("STEP-7")!.state).toBe("Ready")
    expect(fake.called("comment")[0][1]).toMatch(/Paused by the subscription usage limit/)
    expect(fake.called("comment")[0][1]).toMatch(/It stays with eve/)
    expect(outbox()).toEqual([])
  })

  it("blocked pushes what is committed, never opens a PR, goes On hold and says why in the issue's thread", async () => {
    const { ctx, fake, f, outbox } = setup("1\n")
    expect(await finalize(ctx, { ...done, status: "blocked", reason: "the turn limit of 250", report: null })).toEqual({
      status: "blocked", reason: "the turn limit of 250", prUrl: null, pushed: true,
    })
    expect(f.lines()).toContain(`git -C ${WT} push -u origin HEAD:refs/heads/STEP-7-fix-the-date`)
    expect(f.lines().some((l) => l.startsWith("gh pr"))).toBe(false)
    expect(fake.issues.get("STEP-7")!.state).toBe("On hold")
    expect(fake.called("comment")[0][1]).toMatch(/^Worker stopped: the turn limit of 250\./)
    expect(fake.called("comment")[0][1]).toContain("Work so far is on branch `STEP-7-fix-the-date`.")
    expect(outbox()[0]).toEqual(expect.objectContaining({ kind: "issue", text: "blocked: the turn limit of 250. Reply here when it can continue." }))
  })
})

describe("prTitle and prBody", () => {
  it("carry the id Task trace reads, capped titles, and the checks", () => {
    expect(prTitle("STEP-7", { status: "done", summary: "x", prTitle: "fix:   the  date" }, "Fix the date")).toBe("STEP-7: fix: the date")
    expect(prTitle("STEP-7", { status: "done", summary: "x" }, "Fix the date")).toBe("STEP-7: Fix the date")
    expect(prTitle("STEP-7", { status: "done", summary: "x", prTitle: "fix: " + "a".repeat(200) }, "t")).toHaveLength(120)
    const body = prBody("STEP-7", { status: "done", summary: "Did it.", verification: [] }, { mini: "eve", model: "opus", turns: null, costUsd: null, minutes: 5, dirty: true })
    expect(body).toMatch(/^STEP-7\n/)
    expect(body).toContain("- (the worker listed none)")
    expect(body).toContain("The worker left uncommitted changes, which are not in this PR.")
    expect(body).toContain("Worker: eve, model opus, ? turns, estimated unknown, 5 min.")
  })
})
