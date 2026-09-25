import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew } from "../../fsq.ts"
import { listJobs, moveJob, submitJob, type ReviseRequest } from "../../jobs.ts"
import { fakeExec, fakeTracker, issue } from "../../__tests__/fakes.ts"
import { saveUserTestState } from "../../usertest/state.ts"
import type { ExecResult } from "../git.ts"
import type { MergeMode } from "../finalize.ts"
import { buildReviseBrief } from "../revise.ts"
import type { RunDeps } from "../run.ts"
import { userTestStep } from "../usertest-step.ts"

vi.mock("../../usertest/run.ts", () => ({ runUserTest: vi.fn(), userTestDeps: vi.fn((base: unknown) => base) }))
const { runUserTest } = await import("../../usertest/run.ts")
const mocked = runUserTest as unknown as ReturnType<typeof vi.fn>

const PR = "https://github.com/example/repo/pull/7"
const HEAD = "f".repeat(40)
const ARM = `gh pr merge ${PR} --auto --squash --delete-branch`
const REASON = "the browser test found problems"

function setup(o: { enabled?: boolean; autoMergeRequest?: unknown; exec?: Array<[RegExp, Partial<ExecResult>]> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "agentd-ut-step-"))
  const paths = agentPaths(home)
  const config = ConfigSchema.parse({
    mini: "eve",
    repo: { path: "/repo", slug: "example/repo" },
    pluginRoot: "/plugin",
    slack: { allowedUsers: ["U0EXAMPLE"] },
    usertest: { enabled: o.enabled ?? true, previewEnvironment: "Preview – example", previewHost: "^app-[a-z0-9-]+\\.vercel\\.app$", stagingOrigin: "https://staging.example.com" },
  })
  const f = fakeExec([
    ...(o.exec ?? []),
    [/gh pr view/, { stdout: JSON.stringify({ number: 7, headRefOid: HEAD, labels: [{ name: "approval/look" }], autoMergeRequest: o.autoMergeRequest ?? null }) }],
    [/gh pr diff/, { stdout: "components/account/Profile.tsx\n" }],
  ])
  const job = submitJob(paths, "STEP-7", null, new Date("2026-09-25T10:00:00.000Z"))
  moveJob(paths, job.id, "pending", "running", { startedAt: "2026-09-25T10:00:05.000Z", pid: 4242 })
  const warn = vi.fn()
  const deps: RunDeps = {
    paths,
    config,
    tracker: fakeTracker([issue({ id: "STEP-7" })]).tracker,
    exec: f.exec,
    query: (() => {
      throw new Error("no session in these tests")
    }) as never,
    now: () => new Date("2026-09-25T10:40:00.000Z"),
    log: { info: () => {}, warn, error: () => {} },
    pnpmStore: null,
    claudeToken: null,
  }
  const step = (merge: MergeMode, extra: { pushed?: boolean; revise?: ReviseRequest } = {}) =>
    userTestStep(deps, { job: listJobs(paths, "running")[0], issue: issue({ id: "STEP-7" }), prUrl: PR, merge, pushed: extra.pushed ?? true, revise: extra.revise })
  const note = () => readFileSync(join(paths.state, "pr-note-STEP-7.md"), "utf8").trim()
  const comments = () => f.lines().filter((l) => l.startsWith("gh pr comment"))
  return { paths, config, f, deps, step, note, comments, warn }
}

const outcome = (verdict: string, reason = "") => ({ verdict, reason, findings: verdict === "findings" ? ["major: Save does nothing (/en/account)"] : [], commentUrl: null, costUsd: 0.4 })
const revise = (reasons: string[]): ReviseRequest => ({ url: PR, number: 7, branch: "STEP-7-x", round: 1, since: "2026-09-25T10:00:00.000Z", reasons })

beforeEach(() => {
  mocked.mockReset()
})

describe("userTestStep", () => {
  it("arms auto-merge once a deferred develop PR passes, and marks when the test began", async () => {
    const { f, step, paths } = setup()
    mocked.mockResolvedValue(outcome("pass", "nothing a user would trip on"))
    await step("deferred")
    expect(f.lines().filter((l) => l === ARM)).toHaveLength(1)
    expect(listJobs(paths, "running")[0].userTestStartedAt).toBe("2026-09-25T10:40:00.000Z")
  })

  it("leaves auto-merge off on findings, and tests the PR's own head and changed files", async () => {
    const { f, step } = setup()
    mocked.mockResolvedValue(outcome("findings", "1 problems a user would meet"))
    await step("deferred")
    expect(f.lines().some((l) => l.startsWith("gh pr merge"))).toBe(false)
    const input = mocked.mock.calls[0][1]
    expect(input.target).toEqual({ kind: "preview", prUrl: PR, prNumber: 7, headSha: HEAD })
    expect(input.changedPaths).toEqual(["components/account/Profile.tsx"])
    expect(input.approvalClass).toBe("look")
  })

  it("arms when the test could not run, and says so on the PR", async () => {
    const { f, step, note, comments } = setup()
    mocked.mockResolvedValue(outcome("skipped", "the preview was not ready within 20 minutes"))
    await step("deferred")
    expect(f.lines().filter((l) => l === ARM)).toHaveLength(1)
    expect(comments()).toHaveLength(1)
    expect(note()).toBe("The browser test did not run: the preview was not ready within 20 minutes. The checks and the review still decide.")
  })

  it("arms without a note when nothing in the change shows in a browser", async () => {
    const { f, step, comments } = setup()
    mocked.mockResolvedValue(outcome("skipped", "nothing in this change shows in a browser"))
    await step("deferred")
    expect(f.lines().filter((l) => l === ARM)).toHaveLength(1)
    expect(comments()).toEqual([])
  })

  it("arms after a revise round that answered this head's findings without a change, and runs no new test", async () => {
    const { f, step, note, paths } = setup()
    saveUserTestState(paths, { issue: "STEP-7", url: PR, head: HEAD, verdict: "findings", findings: ["major: X (/en)"], at: "2026-09-25T10:20:00.000Z" })
    await step("auto", { pushed: false, revise: revise([REASON]) })
    expect(mocked).not.toHaveBeenCalled()
    expect(f.lines().filter((l) => l === ARM)).toHaveLength(1)
    expect(note()).toContain("answered without a code change")
  })

  it("leaves a revise round that pushed nothing alone when the findings are not what brought it back", async () => {
    const { f, step, paths } = setup()
    saveUserTestState(paths, { issue: "STEP-7", url: PR, head: HEAD, verdict: "findings", findings: ["major: X (/en)"], at: "2026-09-25T10:20:00.000Z" })
    await step("auto", { pushed: false, revise: revise(["changes requested by someone"]) })
    await step("auto", { pushed: false, revise: revise([REASON]) }).then(() => undefined)
    // Only the second call, whose round the findings brought back, arms.
    expect(f.lines().filter((l) => l === ARM)).toHaveLength(1)
    expect(mocked).not.toHaveBeenCalled()
  })

  it("leaves findings at an older head alone when a revise round pushed nothing", async () => {
    const { f, step, paths } = setup()
    saveUserTestState(paths, { issue: "STEP-7", url: PR, head: "0".repeat(40), verdict: "findings", findings: ["major: X (/en)"], at: "2026-09-25T10:20:00.000Z" })
    await step("auto", { pushed: false, revise: revise([REASON]) })
    expect(f.lines().some((l) => l.startsWith("gh pr merge") || l.startsWith("gh pr comment"))).toBe(false)
  })

  it("switches auto-merge off before testing a revise round's push, and on again after a pass", async () => {
    const { f, step } = setup({ autoMergeRequest: { enabledAt: "2026-09-25T10:10:00Z" } })
    const order: string[] = []
    mocked.mockImplementation(async () => {
      order.push(...f.lines().filter((l) => l.startsWith("gh pr merge")))
      order.push("test")
      return outcome("pass")
    })
    await step("auto", { pushed: true, revise: revise(["changes requested by someone"]) })
    expect(order).toEqual([`gh pr merge ${PR} --disable-auto`, "test"])
    expect(f.lines().filter((l) => l.startsWith("gh pr merge"))).toEqual([`gh pr merge ${PR} --disable-auto`, ARM])
  })

  it("does nothing while the browser test is off", async () => {
    const { f, step } = setup({ enabled: false })
    await step("auto")
    await step("auto", { pushed: true, revise: revise(["Test failed"]) })
    expect(mocked).not.toHaveBeenCalled()
    expect(f.lines()).toEqual([])
  })

  it("does nothing for a develop PR finalize armed: nothing in it shows in a browser", async () => {
    const { f, step } = setup()
    await step("auto")
    expect(mocked).not.toHaveBeenCalled()
    expect(f.lines()).toEqual([])
  })

  it("tests but never arms when a person merges", async () => {
    const { f, step } = setup()
    mocked.mockResolvedValue(outcome("pass"))
    await step("person")
    expect(mocked).toHaveBeenCalledTimes(1)
    expect(f.lines().some((l) => l.startsWith("gh pr merge"))).toBe(false)
  })

  it("never throws: a test that breaks is logged, and arms as one that could not run", async () => {
    const { f, step, warn } = setup()
    mocked.mockRejectedValue(new Error("boom"))
    await expect(step("deferred")).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith("browser test step failed", expect.objectContaining({ error: "boom" }))
    expect(f.lines().filter((l) => l === ARM)).toHaveLength(1)
  })

  it("tells the agents channel when it cannot arm auto-merge", async () => {
    const { step, paths } = setup({ exec: [[/--auto --squash/, { code: 1, stderr: "not allowed" }]] })
    mocked.mockResolvedValue(outcome("pass"))
    await step("deferred")
    const posts = listNew<{ text: string }>(paths.outbox).map((e) => e.payload.text)
    expect(posts).toEqual([`STEP-7: I could not switch on automatic merging for <${PR}|PR #7>. A person needs to merge it once the checks pass.`])
  })
})

describe("buildReviseBrief with the browser test's findings", () => {
  it("lists them as problems a user would meet, to fix or answer", () => {
    const input = { mini: "eve", issue: issue({ id: "STEP-7" }), worktree: "/w", branch: "STEP-7-x", base: "staging", resumed: true } as Parameters<typeof buildReviseBrief>[0]
    const brief = buildReviseBrief(input, { ...revise([REASON]), usertestFindings: ["major: Save does nothing (/en/account)"] }, { points: [], logs: [] })
    expect(brief).toContain("## What the browser test found")
    expect(brief).toContain("- major: Save does nothing (/en/account)")
    expect(buildReviseBrief(input, revise(["Test failed"]), { points: [], logs: [] })).not.toContain("What the browser test found")
  })
})
