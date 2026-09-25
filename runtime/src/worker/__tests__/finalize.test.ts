import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew } from "../../fsq.ts"
import { readWatchedPrs } from "../../jobs.ts"
import { fakeExec, fakeTracker, issue } from "../../__tests__/fakes.ts"
import { finalize, FinalizeFailed, prBody, prTitle, selfCheckSections, type FinalizeContext } from "../finalize.ts"
import type { Outcome } from "../outcome.ts"

const PR = "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1700"
const REPO = "/Users/eve/polads"
const WT = "/Users/eve/.agentd/worktrees/STEP-7-fix-the-date"
const GIT = "git --no-replace-objects -c core.hooksPath=/dev/null -c core.fsmonitor=false"
const PUSH = `${GIT} -C ${WT} push -u origin HEAD:refs/heads/STEP-7-fix-the-date`
const done: Outcome = {
  status: "done", reason: "done", costUsd: 3.1, turns: 42, sessionId: "s",
  report: { status: "done", prTitle: "fix: the notice date", summary: "Uses the publication date.", verification: ["pnpm typecheck: pass"] },
}

function setup(outcomeAhead = "2\n", responses: Array<[RegExp, { code?: number; stdout?: string; stderr?: string }]> = [], failOn: string[] = []) {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-fin-")))
  const fake = fakeTracker([issue({ id: "STEP-7", title: "Fix the date", state: "In Progress" })], undefined, failOn)
  const f = fakeExec([...responses, [/rev-list --count/, { stdout: outcomeAhead }], [/gh pr create/, { stdout: `Creating pull request\n${PR}\n` }]])
  const ctx: FinalizeContext = {
    exec: f.exec, tracker: fake.tracker, paths,
    config: ConfigSchema.parse({ mini: "eve", repo: { path: REPO }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] } }),
    issue: fake.issues.get("STEP-7")!, branch: "STEP-7-fix-the-date", worktree: WT, merge: "auto", model: "sonnet", minutes: 37,
    now: () => new Date("2026-09-24T09:00:00.000Z"),
  }
  const outbox = () => listNew<{ kind: string; text: string; question?: boolean }>(paths.outbox).map((e) => e.payload)
  return { ctx, fake, f, paths, outbox }
}

/** The FinalizeFailed a finish threw, or a test failure when it did not throw one. */
async function failure(run: Promise<unknown>): Promise<FinalizeFailed> {
  const error = await run.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(FinalizeFailed)
  return error as FinalizeFailed
}

describe("finalize: done", () => {
  it("pushes the issue's branch, opens the PR to staging, arms auto-merge, links it and says so", async () => {
    const { ctx, fake, f, paths, outbox } = setup()
    expect(await finalize(ctx, done)).toEqual({ status: "done", reason: "done", prUrl: PR, pushed: true })
    const lines = f.lines()
    expect(lines).toContain(PUSH)
    const create = lines.find((l) => l.startsWith("gh pr create"))!
    expect(create).toContain("--base staging --head STEP-7-fix-the-date --title STEP-7: fix: the notice date --body-file")
    expect(lines).toContain(`gh pr merge ${PR} --auto --squash --delete-branch`)
    expect(lines.some((l) => l.includes("--admin"))).toBe(false)
    const body = readFileSync(join(paths.state, "pr-body-STEP-7.md"), "utf8")
    expect(body.split("\n")[0]).toBe("STEP-7")
    expect(body).toContain("Worker: eve, model sonnet, 42 turns, estimated USD 3.10, 37 min.")
    expect(body.trimEnd().endsWith("🤖 Generated with [Claude Code](https://claude.com/claude-code)")).toBe(true)
    expect(body).not.toMatch(/auto-merge/i)
    expect(fake.called("attachLink")[0]).toEqual(["STEP-7", PR, "PR 1700"])
    expect(fake.issues.get("STEP-7")!.state).toBe("In Review")
    expect(outbox()).toEqual([expect.objectContaining({ kind: "post", text: `STEP-7: I opened <${PR}|PR #1700> for "Fix the date". It goes in by itself once the checks and the review pass. Nothing needed from you.` })])
    expect(readWatchedPrs(paths)).toEqual([{ issue: "STEP-7", url: PR, openedAt: "2026-09-24T09:00:00.000Z" }])
    expect(lines).toContain(`${GIT} -C ${REPO} worktree remove --force ${WT}`)
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
    await finalize({ ...ctx, merge: "person" }, done)
    expect(f.lines().some((l) => l.startsWith("gh pr merge"))).toBe(false)
    expect(outbox()[0].text).toBe(`STEP-7: I opened <${PR}|PR #1700> for "Fix the date". A person needs to merge it once the checks pass.`)
  })

  it("leaves auto-merge to the browser test when it is deferred, and says it goes in once tried in a browser (WS5)", async () => {
    const { ctx, f, outbox } = setup()
    expect(await finalize({ ...ctx, merge: "deferred" }, done)).toMatchObject({ status: "done", prUrl: PR })
    expect(f.lines().some((l) => l.startsWith("gh pr merge"))).toBe(false)
    expect(outbox()[0].text).toBe(`STEP-7: I opened <${PR}|PR #1700> for "Fix the date". It goes in by itself once I have tried it in a browser and the checks and the review pass. Nothing needed from you.`)
  })

  it("opens the PR but leaves the merge to a person when auto-merge is off on this mini, and says so in the PR and in Slack", async () => {
    const { ctx, f, paths, outbox } = setup()
    expect(await finalize({ ...ctx, merge: "mini-off" }, done)).toMatchObject({ status: "done", prUrl: PR })
    expect(f.lines().some((l) => l.startsWith("gh pr create"))).toBe(true)
    expect(f.lines().some((l) => l.startsWith("gh pr merge"))).toBe(false)
    expect(readFileSync(join(paths.state, "pr-body-STEP-7.md"), "utf8")).toContain("37 min.\nAuto-merge off on this mini: a person merges.\n")
    expect(outbox()[0].text).toBe(`STEP-7: I opened <${PR}|PR #1700> for "Fix the date". Auto-merge is off on this mini, so a person needs to merge it once the checks pass.`)
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
    expect(fake.called("comment")[0][1]).toContain("Nothing new was pushed.")
    expect(outbox().map((m) => m.kind)).toEqual(["issue", "post"])
  })

  it("is blocked, with no push and no PR, when the commits leave a conflict marker (STEP-3340)", async () => {
    const diff = "diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n@@ -1 +1,5 @@\n+<<<<<<< HEAD\n+ours\n+=======\n+theirs\n+>>>>>>> origin/staging\n"
    const { ctx, fake, f, outbox } = setup("2\n", [[/ diff --no-color --no-ext-diff --no-textconv -U0 origin\/staging HEAD$/, { stdout: diff }]])
    expect(await finalize(ctx, done)).toMatchObject({ status: "blocked", reason: "leftover conflict marker in docs/a.md", pushed: false })
    expect(f.lines().some((l) => l.includes(" push "))).toBe(false)
    expect(f.lines().some((l) => l.startsWith("gh pr"))).toBe(false)
    expect(fake.issues.get("STEP-7")!.state).toBe("On hold")
    expect(outbox().find((m) => m.kind === "issue")?.text).toContain("leftover conflict marker in docs/a.md")
  })

  it("keeps the PR it opened, recorded and announced, when Linear fails after it (Review Focus 5)", async () => {
    const { ctx, paths, outbox } = setup("2\n", [], ["attachLink"])
    const error = await failure(finalize(ctx, done))
    expect(error).toMatchObject({ message: "Linear: attachLink failed (fake)", pushed: true, prUrl: PR })
    expect(readWatchedPrs(paths).map((p) => p.url)).toEqual([PR])
    expect(outbox().map((m) => m.text)).toEqual([`STEP-7: I opened <${PR}|PR #1700> for "Fix the date". It goes in by itself once the checks and the review pass. Nothing needed from you.`])
  })

  it("says nothing and claims nothing was pushed when the push itself fails", async () => {
    const { ctx, fake, f, outbox } = setup("2\n", [[/ push /, { code: 1, stderr: "remote: Repository not found." }]])
    const error = await failure(finalize(ctx, done))
    expect(error).toMatchObject({ pushed: false, prUrl: null })
    expect(error.message).toBe(`git -C ${WT} push -u origin HEAD:refs/heads/STEP-7-fix-the-date failed (1): remote: Repository not found.`)
    expect(f.lines().some((l) => l.startsWith("gh pr"))).toBe(false)
    expect(outbox()).toEqual([])
    expect(fake.called("updateIssue")).toEqual([])
  })
})

describe("finalize: the other outcomes", () => {
  const question: Outcome = { ...done, status: "needs_input", reason: "a question", report: { status: "needs_input", summary: "Two readings.", question: "Which date?", recommendation: "the publication date" } }
  const ASKED = "Which date?\n\nMy recommendation: the publication date. Reply yes to go with it, or tell me what you want instead."

  it("needs_input parks with awaiting-answer and puts the question in the issue's thread", async () => {
    const { ctx, fake, f, outbox } = setup("1\n")
    expect(await finalize(ctx, question)).toMatchObject({ status: "needs_input", pushed: true, prUrl: null })
    expect(fake.issues.get("STEP-7")).toMatchObject({ state: "On hold", labels: ["awaiting-answer"] })
    expect(outbox()[0]).toEqual(expect.objectContaining({ kind: "issue", text: ASKED, question: true }))
    expect(outbox()[1].text).toBe("STEP-7: I have a question before I can go on. It is in the issue's thread: please answer there.")
    expect(f.lines().some((l) => l.startsWith("gh pr create"))).toBe(false)
  })

  it("asks with the worker's recommendation, and says plainly when it has none, so a yes never agrees to nothing (STEP-3293)", async () => {
    const without = { ...question, report: { ...question.report!, recommendation: undefined } }
    const { ctx, outbox } = setup("1\n")
    await finalize(ctx, without)
    expect(outbox()[0].text).toBe("Which date?\n\nI have no recommendation of my own on this one. Tell me what you want.")
  })

  it("needs_input asks the question even when Linear then fails to park the issue", async () => {
    const { ctx, outbox } = setup("1\n", [], ["updateIssue"])
    expect(await failure(finalize(ctx, question))).toMatchObject({ pushed: true, prUrl: null })
    expect(outbox().map((m) => m.text)).toEqual([ASKED, "STEP-7: I have a question before I can go on. It is in the issue's thread: please answer there."])
  })

  it("limited goes back to Ready, still held, with a comment and no Slack", async () => {
    const { ctx, fake, f, outbox } = setup("0\n")
    await finalize(ctx, { ...done, status: "limited", reason: "the subscription usage limit", report: null })
    expect(fake.issues.get("STEP-7")!.state).toBe("Ready")
    expect(fake.called("comment")[0][1]).toMatch(/Paused by the subscription usage limit/)
    expect(fake.called("comment")[0][1]).toMatch(/It stays with eve/)
    expect(f.lines()).not.toContain(PUSH)
    expect(outbox()).toEqual([])
  })

  it("limited pushes what the worker committed, and says where it is", async () => {
    const { ctx, fake, f } = setup("3\n")
    expect(await finalize(ctx, { ...done, status: "limited", reason: "the subscription usage limit", report: null })).toMatchObject({ status: "limited", pushed: true })
    expect(f.lines()).toContain(PUSH)
    expect(fake.called("comment")[0][1]).toContain("Work so far is on `STEP-7-fix-the-date`.")
  })

  it("blocked pushes what is committed, never opens a PR, goes On hold and says why in the issue's thread", async () => {
    const { ctx, fake, f, outbox } = setup("1\n")
    expect(await finalize(ctx, { ...done, status: "blocked", reason: "the turn limit of 250", report: null })).toEqual({
      status: "blocked", reason: "the turn limit of 250", prUrl: null, pushed: true,
    })
    expect(f.lines()).toContain(PUSH)
    expect(f.lines().some((l) => l.startsWith("gh pr"))).toBe(false)
    expect(fake.issues.get("STEP-7")!.state).toBe("On hold")
    expect(fake.called("comment")[0][1]).toMatch(/^Worker stopped: the turn limit of 250\./)
    expect(fake.called("comment")[0][1]).toContain("Work so far is on branch `STEP-7-fix-the-date`.")
    expect(outbox()[0]).toEqual(expect.objectContaining({ kind: "issue", text: "I had to stop work on STEP-7: I reached the most steps one job may take. Reply \"retry\" when it can go on, and I will pick it up where I left off." }))
  })

  it("blocked by the worker's own report says its reason once, with one full stop", async () => {
    const { ctx, fake, outbox } = setup("1\n")
    const summary = "pnpm install fails offline.\nThe lockfile names a package the store lacks."
    await finalize(ctx, { ...done, status: "blocked", reason: "pnpm install fails offline", report: { status: "blocked", summary } })
    expect(outbox()[0].text).toBe("I had to stop work on STEP-7: pnpm install fails offline. The lockfile names a package the store lacks. Reply \"retry\" when it can go on, and I will pick it up where I left off.")
    expect(outbox()[1].text).toBe("STEP-7: I had to stop: pnpm install fails offline. I asked in the issue's thread what to do.")
    expect(fake.called("comment")[0][1]).toMatch(/^Worker stopped: pnpm install fails offline\.\nThe lockfile names a package the store lacks\.\n/)
  })

  it("blocked still says why in Slack when Linear then fails", async () => {
    const { ctx, outbox } = setup("1\n", [], ["updateIssue"])
    expect(await failure(finalize(ctx, { ...done, status: "blocked", reason: "the turn limit of 250", report: null }))).toMatchObject({ pushed: true })
    expect(outbox().map((m) => m.text)).toEqual([
      "I had to stop work on STEP-7: I reached the most steps one job may take. Reply \"retry\" when it can go on, and I will pick it up where I left off.",
      "STEP-7: I had to stop: I reached the most steps one job may take. I asked in the issue's thread what to do.",
    ])
  })
})

describe("selfCheckSections (STEP-3284)", () => {
  it("shows the sweep's answers and each mutation check, and names what went unanswered", () => {
    const sections = selfCheckSections({
      status: "done",
      summary: "x",
      checklist: { siblings: "rg -n limiter app: two routes", docs: "rg -n limit docs: none" },
      mutations: [{ test: "lib/__tests__/limit.test.ts > per pair", mutation: "made the limit all-or-nothing", result: "expected 429, got 200." }],
    }).join("\n")
    expect(sections).toBe(
      [
        "## Sweep checklist",
        "- Sibling call sites: rg -n limiter app: two routes",
        "- Docs and comments: rg -n limit docs: none",
        "Not answered by the worker: publicOutputs, caches, coupled, translations. A reviewer should check these.",
        "",
        "## Mutation checks",
        "- `lib/__tests__/limit.test.ts > per pair`: made the limit all-or-nothing. It failed: expected 429, got 200. Reverted.",
      ].join("\n"),
    )
    expect(selfCheckSections({ status: "done", summary: "x" }).at(-1)).toBe("- None listed.")
  })
})

describe("prTitle and prBody", () => {
  it("carry the id Task trace reads, capped titles, and the checks", () => {
    expect(prTitle("STEP-7", { status: "done", summary: "x", prTitle: "fix:   the  date" }, "Fix the date")).toBe("STEP-7: fix: the date")
    expect(prTitle("STEP-7", { status: "done", summary: "x" }, "Fix the date")).toBe("STEP-7: Fix the date")
    expect(prTitle("STEP-7", { status: "done", summary: "x", prTitle: "fix: " + "a".repeat(200) }, "t")).toHaveLength(120)
    const body = prBody("STEP-7", { status: "done", summary: "Did it.", verification: [] }, { mini: "eve", model: "opus", turns: null, costUsd: null, minutes: 5, dirty: true, merge: "person" })
    expect(body).toMatch(/^STEP-7\n/)
    expect(body).toContain("- (the worker listed none)")
    expect(body).toContain("The worker left uncommitted changes, which are not in this PR.")
    expect(body).toContain("Worker: eve, model opus, ? turns, estimated unknown, 5 min.")
    // The self-check sits between the checks and the notes.
    expect(body).toMatch(/Everything else runs in CI\.\n\n## Sweep checklist\nNot answered by the worker: [^\n]+\n\n## Mutation checks\n- None listed\.\n\n## Notes/)
  })
})
