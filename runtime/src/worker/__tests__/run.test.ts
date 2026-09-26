import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { planTransition } from "../../answer.ts"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew } from "../../fsq.ts"
import { listJobs, moveJob, submitJob } from "../../jobs.ts"
import type { Logger } from "../../log.ts"
import { fakeExec, fakeTracker, issue, SWEEP } from "../../__tests__/fakes.ts"
import { JARGON } from "../../plain.ts"
import { readLessons } from "../../retro/lessons.ts"
import type { ExecResult } from "../git.ts"
import { acceptWithGaps, checkBilling, checkPlugins, correctionMinutes, correctionPrompt, mergeMode, requireMutations, modelFor, runJob, runSession, sdkOptions, type QueryFn, type RunDeps, type SdkMessage } from "../run.ts"

const quiet: Logger = { info() {}, warn() {}, error() {} }
const PR = "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1701"
const INIT: SdkMessage = { type: "system", subtype: "init", apiKeySource: "none", plugins: [{ name: "dev-tasks", path: "/Users/eve/dev-tasks/plugin" }] }
const DONE: SdkMessage = {
  type: "result", subtype: "success", total_cost_usd: 2.4, num_turns: 31, session_id: "s-1",
  structured_output: { status: "done", prTitle: "fix: the notice date", summary: "Uses the publication date.", verification: ["pnpm typecheck: pass"], checklist: SWEEP },
}

/** Each call gets the next session's messages (the last one repeats), and `thrown` ends the first. */
function queryOf(sessions: SdkMessage[][], thrown?: string): { query: QueryFn; seen: Array<{ prompt: string; options: Options }> } {
  const seen: Array<{ prompt: string; options: Options }> = []
  const query: QueryFn = (args) => {
    seen.push(args)
    const call = seen.length - 1
    const messages = sessions[Math.min(call, sessions.length - 1)]
    return (async function* () {
      for (const m of messages) yield m
      if (thrown && call === 0) throw new Error(thrown)
    })()
  }
  return { query, seen }
}

function setup(
  opts: {
    issueOver?: Record<string, unknown>
    messages?: SdkMessage[]
    thrown?: string
    gh?: string
    failOn?: string[]
    exec?: Array<[RegExp, Partial<ExecResult>]>
    worker?: Record<string, unknown>
    usertest?: Record<string, unknown>
    /** One message list per SDK session, for a runner that asks again. */
    sessions?: SdkMessage[][]
    job?: Parameters<typeof submitJob>[4]
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "agentd-run-"))
  const repo = join(home, "polads")
  mkdirSync(join(repo, ".claude"), { recursive: true })
  writeFileSync(join(repo, ".claude", "project-config.json"), JSON.stringify({ git: { autoMergePolicy: { staging: "auto-after-checks-and-review" } } }))
  const paths = agentPaths(home)
  const config = ConfigSchema.parse({ mini: "eve", repo: { path: repo }, pluginRoot: "/Users/eve/dev-tasks/plugin", slack: { allowedUsers: ["UNATE"] }, worker: opts.worker, usertest: opts.usertest })
  const fake = fakeTracker([issue({ id: "STEP-7", title: "Fix the date", labels: ["polads", "agent-ready"], ...opts.issueOver })], undefined, opts.failOn)
  const f = fakeExec([
    ...(opts.exec ?? []),
    [/gh pr list/, { stdout: opts.gh ?? "" }],
    // A new branch: not on origin, and no local one.
    [/ls-remote/, { code: 2 }],
    [/rev-parse --verify/, { code: 1 }],
    [/rev-list --count/, { stdout: "2\n" }],
    [/gh pr create/, { stdout: `${PR}\n` }],
  ])
  const q = queryOf(opts.sessions ?? [opts.messages ?? [INIT, DONE]], opts.thrown)
  const job = submitJob(paths, "STEP-7", null, new Date("2026-09-24T09:00:00.000Z"), opts.job)
  moveJob(paths, job.id, "pending", "running", { startedAt: "2026-09-24T09:00:05.000Z", pid: 4242 })
  const deps: RunDeps = {
    paths, config, tracker: fake.tracker, exec: f.exec, query: q.query, now: () => new Date("2026-09-24T09:40:00.000Z"), log: quiet,
    pnpmStore: "/Users/eve/Library/pnpm/store/v10", claudeToken: "oauth-test",
  }
  const outbox = () => listNew<{ text: string }>(paths.outbox).map((e) => e.payload.text)
  return { deps, job, fake, f, q, paths, outbox }
}

describe("mergeMode", () => {
  const config = (worker?: Record<string, unknown>) =>
    ConfigSchema.parse({ mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] }, worker })

  it("arms auto-merge only when the project's policy allows it and this mini has not turned it off", () => {
    expect(mergeMode("auto-after-checks-and-review", config())).toBe("auto")
    expect(mergeMode("auto-after-checks-and-review", config({ autoMerge: true }))).toBe("auto")
    expect(mergeMode("auto-after-checks-and-review", config({ autoMerge: false }))).toBe("mini-off")
    for (const policy of [null, "manual", "auto-after-checks"]) {
      expect(mergeMode(policy, config())).toBe("person")
      expect(mergeMode(policy, config({ autoMerge: false }))).toBe("person")
    }
  })

  it("refuses a worker.autoMerge that is not a boolean", () => {
    expect(() => config({ autoMerge: "false" })).toThrow()
  })
})

describe("runJob", () => {
  it("never works on a request with tasks: skips it, takes its agent-ready away, and claims nothing (Wave 2)", async () => {
    const { deps, job, fake, q } = setup()
    const result = await runJob({ ...deps, subIssues: async () => ["STEP-8", "STEP-9"] }, job.id)
    expect(result).toMatchObject({ status: "skipped", reason: "STEP-7 has sub-issues (STEP-8, STEP-9): it is a request, and its tasks are the work" })
    expect(fake.issues.get("STEP-7")!.labels).not.toContain("agent-ready")
    expect(fake.calls.filter((c) => c.method === "claimIssue")).toEqual([])
    expect(q.seen).toHaveLength(0)
  })

  it("claims, prepares the worktree, runs the session and opens the PR", async () => {
    const { deps, job, fake, f, q, paths, outbox } = setup()
    expect(await runJob(deps, job.id)).toMatchObject({ status: "done", prUrl: PR, branch: "STEP-7-fix-the-date", costUsd: 2.4, turns: 31 })
    expect(fake.called("claimIssue")).toEqual([["STEP-7", "eve"]])
    expect(q.seen[0].options.cwd).toMatch(/worktrees\/STEP-7-fix-the-date$/)
    expect(q.seen[0].prompt).toContain("# STEP-7: Fix the date")
    expect(q.seen[0].options.env).toMatchObject({ DEV_TASKS_PROFILE: "agent", CLAUDE_CODE_OAUTH_TOKEN: "oauth-test" })
    expect(f.lines()).toContain(`gh pr merge ${PR} --auto --squash --delete-branch`)
    expect(listJobs(paths, "running")).toEqual([])
    expect(listJobs(paths, "done")[0].result).toMatchObject({ status: "done", prUrl: PR })
    expect(outbox()).toEqual(["STEP-7: I started on \"Fix the date\". Nothing needed from you.", `STEP-7: I opened <${PR}|PR #1701> for "Fix the date". It goes in by itself once the checks and the review pass. Nothing needed from you.`])
  })

  it("opens the PR without arming auto-merge when worker.autoMerge is off on this mini, though the policy allows it", async () => {
    const { deps, job, f, outbox } = setup({ worker: { autoMerge: false } })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "done", prUrl: PR })
    expect(f.lines().some((l) => l.startsWith("gh pr create"))).toBe(true)
    expect(f.lines().some((l) => l.startsWith("gh pr merge"))).toBe(false)
    expect(outbox()).toEqual(["STEP-7: I started on \"Fix the date\". Nothing needed from you.", `STEP-7: I opened <${PR}|PR #1701> for "Fix the date". Auto-merge is off on this mini, so a person needs to merge it once the checks pass.`])
  })

  it("marks when the session starts, after the worktree, for agentd's wall-clock backstop", async () => {
    const { deps, job, paths } = setup()
    let marked: string | undefined
    const query = deps.query
    await runJob({ ...deps, query: (args) => ((marked = listJobs(paths, "running")[0]?.sessionStartedAt), query(args)) }, job.id)
    expect(marked).toBe("2026-09-24T09:40:00.000Z")
  })

  it("never hands the session an API key, whatever the runner's own environment holds", async () => {
    const saved = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "sk-ant-not-a-real-key"
    try {
      const { deps, job, q } = setup()
      await runJob(deps, job.id)
      expect(q.seen[0].options.env).not.toHaveProperty("ANTHROPIC_API_KEY")
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = saved
    }
  })

  it("ends as skipped, not crashed, when Linear fails before the claim, so a short outage never holds an issue back", async () => {
    const cases: Array<{ failOn: string[]; gh?: string; reason: string }> = [
      { failOn: ["readIssue"], reason: "Linear failed before the claim: Linear: readIssue failed (fake)" },
      { failOn: ["whoami"], reason: "Linear failed before the claim: Linear: whoami failed (fake)" },
      // A PR is already open, and moving the issue to In Review fails.
      { failOn: ["updateIssue"], gh: `${PR}\n`, reason: "Linear failed before the claim: Linear: updateIssue failed (fake)" },
    ]
    for (const c of cases) {
      const { deps, job, paths, q, outbox } = setup({ failOn: c.failOn, gh: c.gh })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "skipped", reason: c.reason })
      expect(listJobs(paths, "running")).toEqual([])
      // Marked for the digest's wait, and not a loss agentd would count.
      expect(listJobs(paths, "done")[0]).toMatchObject({ result: { status: "skipped" }, linearFailed: true })
      expect(listJobs(paths, "done")[0].lostEarly).toBeUndefined()
      expect(q.seen).toEqual([])
      expect(outbox()).toEqual([])
    }
  })

  it("says the claim may have gone through when Linear fails while claiming", async () => {
    const { deps, job, paths, q, outbox } = setup({ failOn: ["claimIssue"] })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "skipped", reason: "Linear failed while claiming: Linear: claimIssue failed (fake)" })
    expect(listJobs(paths, "done")[0].linearFailed).toBe(true)
    expect(outbox()).toEqual(["STEP-7: Linear did not answer when I tried to take this issue, so I did not start it. If Linear took it for me anyway, I let it go after 6 hours unless someone takes it first. Nothing needed from you."])
    expect(q.seen).toEqual([])
  })

  it("keeps a pause a person set when it finds a graft", async () => {
    const { deps, job, paths } = setup()
    mkdirSync(join(deps.config.repo.path, ".git", "info"), { recursive: true })
    writeFileSync(join(deps.config.repo.path, ".git", "info", "grafts"), "")
    writeFileSync(paths.pauseFile, JSON.stringify({ at: "2026-09-24T09:00:00.000Z", reason: "Nate is updating the mini" }))
    expect(await runJob(deps, job.id)).toMatchObject({ status: "skipped" })
    expect(JSON.parse(readFileSync(paths.pauseFile, "utf8"))).toEqual({ at: "2026-09-24T09:00:00.000Z", reason: "Nate is updating the mini" })
  })

  it("pauses the mini, before any claim, when the main checkout has a graft or a shallow list", async () => {
    for (const file of [["info", "grafts"], ["shallow"]]) {
      const { deps, job, paths, fake, q, outbox } = setup()
      mkdirSync(join(deps.config.repo.path, ".git", "info"), { recursive: true })
      writeFileSync(join(deps.config.repo.path, ".git", ...file), "")
      const why = `the main checkout has .git/${file.join("/")}, which can hide what a branch changes`
      expect(await runJob(deps, job.id)).toMatchObject({ status: "skipped", reason: why })
      expect(JSON.parse(readFileSync(paths.pauseFile, "utf8"))).toEqual({ at: "2026-09-24T09:40:00.000Z", reason: why })
      // Counted in the ledger, as agentd's own pause is.
      expect(readFileSync(join(paths.logs, "ledger.jsonl"), "utf8")).toContain(JSON.stringify({ at: "2026-09-24T09:40:00.000Z", type: "paused", reason: why }))
      expect(outbox()).toEqual([
        `I paused myself and did not start STEP-7: my copy of the code has a file that can hide changes (.git/${file.join("/")}). A person needs to look at the mini, remove the file if nothing needs it, then resume me.`,
      ])
      expect(fake.calls).toEqual([])
      expect(q.seen).toEqual([])
    }
  })

  describe("a report whose only fault is its form (STEP-3270)", () => {
    // Eve's STEP-3184 job committed a real fix, then reported without a PR title, and ended blocked.
    const NO_TITLE: SdkMessage = { ...DONE, structured_output: { status: "done", summary: "Rotates the token.", verification: ["pnpm test: pass"] } }
    const NO_REPORT: SdkMessage = { ...DONE, structured_output: { status: "done" } }
    const CORRECTED: SdkMessage = {
      ...DONE, total_cost_usd: 0.05, num_turns: 1,
      structured_output: { status: "done", summary: "Rotates the token.", prTitle: "fix: rotate the DPA signing token", checklist: SWEEP },
    }
    const LOG = "fix: rotate the DPA signing token for a new signer (STEP-7)\x1fDrops status from the enquiry summary too.\n\x1e\nwip: first pass (STEP-7)\x1f\x1e\n"
    const ledger = (paths: RunDeps["paths"]) => readFileSync(join(paths.logs, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).type)

    it("asks the same session once for the report, and opens the PR from the corrected one", async () => {
      const { deps, job, q, f, paths } = setup({ sessions: [[INIT, NO_TITLE], [INIT, CORRECTED]] })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "done", prUrl: PR, costUsd: 2.45, turns: 32 })
      expect(q.seen).toHaveLength(2)
      expect(q.seen[1].prompt).toBe(correctionPrompt("prTitle"))
      expect(q.seen[1].prompt).toMatch(/no prTitle.*change nothing and run no tool.*report only/)
      expect(q.seen[1].options).toMatchObject({ resume: "s-1", maxTurns: 4, cwd: q.seen[0].options.cwd, outputFormat: q.seen[0].options.outputFormat })
      // The same guards and sandbox as the first session.
      const shape = (o: Options) => o.hooks?.PreToolUse?.map((g) => [g.matcher ?? null, g.hooks.length])
      expect(shape(q.seen[1].options)).toEqual(shape(q.seen[0].options))
      expect(shape(q.seen[1].options)?.length).toBeGreaterThan(0)
      expect(q.seen[1].options.sandbox).toEqual(q.seen[0].options.sandbox)
      expect(f.lines().find((l) => l.startsWith("gh pr create"))).toContain("--title STEP-7: fix: rotate the DPA signing token --body-file")
      expect(ledger(paths)).toContain("report.corrected")
    })

    it("asks the same way when there was no valid report at all", async () => {
      const { deps, job, q } = setup({ sessions: [[INIT, NO_REPORT], [INIT, CORRECTED]] })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "done", prUrl: PR })
      expect(q.seen[1].prompt).toBe(correctionPrompt("report"))
      expect(q.seen[1].prompt).toMatch(/without a valid final report/)
    })

    it("titles the PR from the newest commit when the corrected report is still malformed, and says why in the PR", async () => {
      const { deps, job, q, f, paths, fake } = setup({ sessions: [[INIT, NO_TITLE], [INIT, NO_TITLE]], exec: [[/ log --format=/, { stdout: LOG }]] })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "done", prUrl: PR, reason: "done, titled from the commits: the report has no PR title" })
      expect(q.seen).toHaveLength(2)
      // The issue id is in the PR title already, so the commit's own is dropped.
      expect(f.lines().find((l) => l.startsWith("gh pr create"))).toContain("--title STEP-7: fix: rotate the DPA signing token for a new signer --body-file")
      expect(f.lines()).toContain(`gh pr merge ${PR} --auto --squash --delete-branch`)
      const body = readFileSync(join(paths.state, "pr-body-STEP-7.md"), "utf8")
      expect(body).toContain("fix: rotate the DPA signing token for a new signer (STEP-7)\n\nDrops status from the enquiry summary too.\n\nwip: first pass (STEP-7)")
      expect(body).toContain("The worker's final report was malformed (the report has no PR title), so the runner took this PR's title and description from its commits.")
      expect(body).toContain("- pnpm test: pass")
      expect(fake.issues.get("STEP-7")!.state).toBe("In Review")
      expect(ledger(paths)).toContain("report.fromCommits")
    })

    it("titles the PR from the commits when the correction itself fails, or there is no session to resume", async () => {
      const failing = setup({ exec: [[/ log --format=/, { stdout: LOG }]] })
      let calls = 0
      failing.deps.query = (() =>
        (async function* () {
          calls++
          yield INIT
          if (calls === 1) yield NO_TITLE
          else throw new Error("Claude Code process exited with code 1")
        })()) as QueryFn
      expect(await runJob(failing.deps, failing.job.id)).toMatchObject({ status: "done", prUrl: PR, reason: "done, titled from the commits: the report has no PR title" })
      expect(calls).toBe(2)
      const noSession = setup({ messages: [INIT, { ...NO_TITLE, session_id: undefined }], exec: [[/ log --format=/, { stdout: LOG }]] })
      expect(await runJob(noSession.deps, noSession.job.id)).toMatchObject({ status: "done", reason: "done, titled from the commits: the report has no PR title" })
      expect(noSession.q.seen).toHaveLength(1)
    })

    it("fits the correction inside the finish agentd's backstop allows, and skips it with no time left", async () => {
      // agentd stops a worker at its wall clock plus FINISH_GRACE_MINUTES (15); the push, the PR and Linear keep 5 of those.
      expect(correctionMinutes(90, 20)).toBe(10)
      expect(correctionMinutes(90, 95)).toBe(5)
      expect(correctionMinutes(90, 100)).toBe(0)
      // A session that ran past its clock gets no correction: the PR comes from the commits.
      const { deps, job, q } = setup({ messages: [INIT, NO_TITLE], exec: [[/ log --format=/, { stdout: LOG }]] })
      let t = new Date("2026-09-24T09:40:00.000Z").getTime()
      deps.now = () => new Date(t)
      const query = deps.query
      // The session runs 101 minutes: past the 90-minute clock, and 4 short of agentd's backstop.
      deps.query = (args) => ((t += 101 * 60_000), query(args))
      expect(await runJob(deps, job.id)).toMatchObject({ status: "done", reason: "done, titled from the commits: the report has no PR title" })
      expect(q.seen).toHaveLength(1)
    })

    it("stays blocked, asking nothing, when nothing is committed", async () => {
      const { deps, job, q, f, fake } = setup({ sessions: [[INIT, NO_TITLE], [INIT, CORRECTED]], exec: [[/rev-list --count/, { stdout: "0\n" }]] })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason: "the report has no PR title", prUrl: null })
      expect(q.seen).toHaveLength(1)
      expect(f.lines().some((l) => l.startsWith("gh pr create"))).toBe(false)
      expect(fake.issues.get("STEP-7")!.state).toBe("On hold")
    })

    it("never asks again for a report the worker gave in good form, blocked included", async () => {
      const said: SdkMessage = { ...DONE, structured_output: { status: "blocked", summary: "The migration needs a person." } }
      const { deps, job, q } = setup({ sessions: [[INIT, said], [INIT, CORRECTED]] })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason: "The migration needs a person" })
      expect(q.seen).toHaveLength(1)
    })
  })

  it("takes a retried job's issue On hold, where its block left it, carries the branch on, and says why the earlier job ended", async () => {
    const { deps, job, fake, q, paths } = setup({ issueOver: { state: "On hold", assigneeId: "user-eve" }, job: { retryOf: "STEP-7-20260925071840" }, exec: [[/ls-remote/, { code: 0 }]] })
    mkdirSync(join(paths.jobs, "done"), { recursive: true })
    writeFileSync(
      join(paths.jobs, "done", "STEP-7-20260925071840.json"),
      JSON.stringify({ id: "STEP-7-20260925071840", issue: "STEP-7", kind: "develop", model: null, submittedAt: "2026-09-25T07:18:40.000Z", result: { status: "blocked", reason: "the report has no PR title" } }),
    )
    expect(await runJob(deps, job.id)).toMatchObject({ status: "done", prUrl: PR })
    expect(fake.called("claimIssue")).toEqual([["STEP-7", "eve"]])
    // The branch was on origin: the worker continues it, told why the last job stopped.
    expect((q.seen[0].options.systemPrompt as { append: string }).append).toContain("with earlier work on it")
    expect(q.seen[0].prompt).toContain("An earlier job on this issue ended blocked: the report has no PR title. Its commits are on this branch.")
    // An ordinary job's brief says nothing of the kind.
    const plain = setup()
    await runJob(plain.deps, plain.job.id)
    expect(plain.q.seen[0].prompt).not.toContain("An earlier job")
  })

  it("skips an issue On hold for an ordinary job, and one a retry cannot take", async () => {
    const onHold = setup({ issueOver: { state: "On hold" } })
    expect(await runJob(onHold.deps, onHold.job.id)).toMatchObject({ status: "skipped", reason: "the issue is On hold, not Ready" })
    const done = setup({ issueOver: { state: "Done" }, job: { retryOf: "STEP-7-20260925071840" } })
    expect(await runJob(done.deps, done.job.id)).toMatchObject({ status: "skipped", reason: "the issue is Done, not Ready or On hold" })
    expect(done.fake.called("claimIssue")).toEqual([])
  })

  describe("the self-check (STEP-3284)", () => {
    const NO_SWEEP: SdkMessage = { ...DONE, structured_output: { status: "done", prTitle: "fix: the notice date", summary: "Uses the publication date." } }
    const TESTED = "lib/notice.ts\nlib/__tests__/notice.test.ts\n"
    const MUTATED: SdkMessage = {
      ...DONE, total_cost_usd: 0.3, num_turns: 6,
      structured_output: {
        status: "done", prTitle: "fix: the notice date", summary: "Uses the publication date.", checklist: SWEEP,
        mutations: [{ test: "lib/__tests__/notice.test.ts > keeps the date", mutation: "returned createdAt instead", result: "expected 2026-09-01, got 2026-08-31" }],
      },
    }
    const body = (paths: RunDeps["paths"]) => readFileSync(join(paths.state, "pr-body-STEP-7.md"), "utf8")

    it("asks the same session for the missing sweep, with turns to do it, and opens the PR with its answers", async () => {
      const { deps, job, q, paths } = setup({ sessions: [[INIT, NO_SWEEP], [INIT, DONE]] })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "done", prUrl: PR, costUsd: 4.8 })
      expect(q.seen).toHaveLength(2)
      expect(q.seen[1].options).toMatchObject({ resume: "s-1", maxTurns: 30 })
      expect(q.seen[1].prompt).toBe(correctionPrompt("checklist", "the report's self-check is incomplete: siblings, publicOutputs, caches, coupled, docs, translations"))
      expect(q.seen[1].prompt).toMatch(/^The report's self-check is incomplete: siblings.*Do the one-hop sweep.*every checklist key, siblings and docs with the command you ran/)
      expect(body(paths)).toContain("## Sweep checklist\n- Sibling call sites: rg -n 'createdAt' lib app")
      expect(body(paths)).not.toContain("Not answered by the worker")
    })

    it("opens the PR with the gaps named, and its own title, when the sweep stays unanswered", async () => {
      const { deps, job, f, paths, fake } = setup({ sessions: [[INIT, NO_SWEEP], [INIT, NO_SWEEP]] })
      expect(await runJob(deps, job.id)).toMatchObject({
        status: "done",
        reason: "done, with an incomplete self-check: the report's self-check is incomplete: siblings, publicOutputs, caches, coupled, docs, translations",
      })
      expect(f.lines().find((l) => l.startsWith("gh pr create"))).toContain("--title STEP-7: fix: the notice date --body-file")
      expect(body(paths)).toContain("Not answered by the worker: siblings, publicOutputs, caches, coupled, docs, translations. A reviewer should check these.")
      expect(body(paths)).toContain("The worker's self-check was incomplete (the report's self-check is incomplete: siblings")
      expect(fake.issues.get("STEP-7")!.state).toBe("In Review")
      // What went out unanswered is a lesson for the weekly retro (STEP-3290).
      expect(readLessons(paths)).toEqual([
        expect.objectContaining({ category: "self-check", source: "runner", text: "the report's self-check is incomplete: siblings, publicOutputs, caches, coupled, docs, translations" }),
      ])
    })

    it("asks for mutation checks when the branch changes tests and the report lists none, and shows them in the PR", async () => {
      const { deps, job, q, paths } = setup({ sessions: [[INIT, DONE], [INIT, MUTATED]], exec: [[/diff --name-only origin\/staging\.\.\.HEAD/, { stdout: TESTED }]] })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "done", prUrl: PR })
      expect(q.seen[1].options).toMatchObject({ resume: "s-1", maxTurns: 30 })
      expect(q.seen[1].prompt).toMatch(/^The branch changes tests \(lib\/__tests__\/notice\.test\.ts\) but the report lists no mutation check\. .*one deliberate mutation of the invariant.*git checkout -- <file>\. Commit no mutation\./)
      expect(body(paths)).toContain(
        "## Mutation checks\n- `lib/__tests__/notice.test.ts > keeps the date`: returned createdAt instead. It failed: expected 2026-09-01, got 2026-08-31. Reverted.",
      )
    })

    it("needs no mutation check when no test changed, and says in the PR when none came", async () => {
      const plain = setup({ exec: [[/diff --name-only origin\/staging\.\.\.HEAD/, { stdout: "lib/notice.ts\n" }]] })
      expect(await runJob(plain.deps, plain.job.id)).toMatchObject({ status: "done" })
      expect(plain.q.seen).toHaveLength(1)
      const stubborn = setup({ sessions: [[INIT, DONE], [INIT, DONE]], exec: [[/diff --name-only origin\/staging\.\.\.HEAD/, { stdout: TESTED }]] })
      expect(await runJob(stubborn.deps, stubborn.job.id)).toMatchObject({
        status: "done",
        reason: "done, with an incomplete self-check: the branch changes tests (lib/__tests__/notice.test.ts) but the report lists no mutation check",
      })
      expect(body(stubborn.paths)).toContain("## Mutation checks\n- None listed.")
    })

    it("never stops on the self-check alone: with nothing committed, it asks once, then stops on the missing code, and says so plainly", async () => {
      const { deps, job, q, outbox } = setup({ sessions: [[INIT, NO_SWEEP], [INIT, NO_SWEEP]], exec: [[/rev-list --count/, { stdout: "0\n" }]] })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason: "the worker reported done but made no commits" })
      expect(q.seen).toHaveLength(2)
      expect(outbox().at(-1)).toBe("STEP-7: I had to stop: I finished without changing any code. I asked in the issue's thread what to do.")
      // The people are called to its question, once, right after it (spec 6).
      const texts = outbox()
      const asked = texts.findIndex((t) => t.startsWith("I had to stop work on STEP-7"))
      expect(texts[asked + 1]).toBe("<@UNATE> STEP-7 is blocked. What happened, and what you can reply, is just above.")
      expect(texts.filter((t) => t.startsWith("<@"))).toHaveLength(1)
    })

    it("counts only test files, and leaves a report with its checks, or any other status, as it is", () => {
      const done = { status: "done" as const, reason: "done", report: { status: "done" as const, summary: "x" }, costUsd: null, turns: null, sessionId: null }
      expect(requireMutations(done, ["lib/notice.ts", "docs/testing.md", "lib/latest.ts"])).toBe(done)
      for (const file of ["lib/__tests__/a.ts", "a.test.ts", "b.spec.tsx", "c.test.mjs"]) expect(requireMutations(done, [file]).reportProblem, file).toBe("mutations")
      const checked = { ...done, report: { ...done.report, mutations: [{ test: "a", mutation: "m", result: "r" }] } }
      expect(requireMutations(checked, ["a.test.ts"])).toBe(checked)
      const blocked = { ...done, status: "blocked" as const }
      expect(requireMutations(blocked, ["a.test.ts"])).toBe(blocked)
      // What goes out despite the gaps says so, and is no longer a problem.
      expect(acceptWithGaps({ ...requireMutations(done, ["a.test.ts"]), report: { ...done.report, notes: "Mine." } })).toMatchObject({
        status: "done", reportProblem: undefined, report: { notes: expect.stringMatching(/^The worker's self-check was incomplete .*\nMine\.$/) },
      })
    })
  })

  describe("a revise job (STEP-3274)", () => {
    const PR_URL = "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1674"
    const REVISE = {
      url: PR_URL, number: 1674, branch: "STEP-7-fix-the-date", round: 1, since: "2026-09-24T10:00:00.000Z",
      reasons: ["changes requested by nate", "Test failed"],
    }
    const VIEW = JSON.stringify({
      author: { login: "eve-polads" },
      headRefOid: "abc1234",
      reviews: [
        { id: "R0", author: { login: "nate" }, state: "COMMENTED", body: "An older point.", submittedAt: "2026-09-24T09:00:00.000Z" },
        { id: "R1", author: { login: "nate" }, state: "CHANGES_REQUESTED", body: "Use the publication date.", submittedAt: "2026-09-24T11:00:00.000Z" },
        { id: "R2", author: { login: "eve-polads" }, state: "COMMENTED", body: "Eve's own review note.", submittedAt: "2026-09-24T11:03:00.000Z" },
      ],
      comments: [{ id: "C1", author: { login: "eve-polads" }, body: "Eve's own earlier reply.", createdAt: "2026-09-24T11:05:00.000Z" }],
      statusCheckRollup: [{ name: "Test", conclusion: "FAILURE", detailsUrl: "https://github.com/x/actions/runs/111/job/222" }],
    })
    const INLINE =
      '{"user":"nate","path":"lib/notice.ts","line":12,"body":"This reads the wrong field.","created_at":"2026-09-24T11:01:00Z"}\n' +
      '{"user":"eve-polads","path":"lib/x.ts","line":1,"body":"Eve on her own code.","created_at":"2026-09-24T11:02:00Z"}\n'
    const REVISED: SdkMessage = {
      ...DONE,
      structured_output: { status: "done", summary: "Use the publication date: done, in lib/notice.ts.\nTest: fixed the assertion.", checklist: SWEEP },
    }
    const answers = (over: Array<[RegExp, Partial<ExecResult>]> = []): Array<[RegExp, Partial<ExecResult>]> => [
      ...over,
      [/^gh pr view \S+ --json state$/, { stdout: '{"state":"OPEN"}' }],
      [/^gh pr view \S+ --json author,reviews/, { stdout: VIEW }],
      [/^gh api repos\/STEP-Network\/v0-politiske-annoncer\/pulls\/1674\/comments /, { stdout: INLINE }],
      [/^gh run view --job 222 /, { stdout: "FAIL lib/notice.test.ts\n  expected 2026-09-01, got 2026-08-31\n" }],
      [/ls-remote/, { code: 0 }],
      [/rev-list --count origin\/STEP-7-fix-the-date\.\.HEAD/, { stdout: "1\n" }],
    ]
    const revising = (over: Parameters<typeof setup>[0] = {}) => {
      const s = setup({ issueOver: { state: "In Review", assigneeId: "user-eve" }, job: { kind: "revise", revise: REVISE }, messages: [INIT, REVISED], exec: answers(), ...over })
      writeFileSync(
        join(s.deps.config.repo.path, ".claude", "project-config.json"),
        JSON.stringify({ git: { autoMergePolicy: { staging: "auto-after-checks-and-review" } }, ci: { requiredChecks: ["Test"] } }),
      )
      return s
    }

    it("says in the issue's thread when a round runs out of usage, and how to have it try again", async () => {
      const { deps, job, outbox } = revising({ messages: [INIT], thrown: "Claude usage limit reached" })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "limited" })
      expect(outbox()).toContain(`I ran out of usage while fixing the review comments and the failing checks on <${PR_URL}|PR #1674>. Once the limit resets, reply "fix it" here and I will try again.`)
    })

    it("tests a revise round's push in a browser however the round ended (WS5)", async () => {
      const stopped: SdkMessage = { ...DONE, structured_output: { status: "blocked", summary: "Half done: the rest needs a person." } }
      const usertest = { enabled: true, previewEnvironment: "Preview – example", previewHost: "^app-[a-z0-9-]+\\.vercel\\.app$", stagingOrigin: "https://staging.example.com" }
      const { deps, job, f } = revising({ messages: [INIT, stopped], usertest })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked" })
      expect(f.lines().some((l) => l.startsWith(`gh pr view ${PR_URL} --json number,headRefOid`))).toBe(true)
    })

    it("continues the PR's branch from origin, with the feedback in its brief, pushes to that branch and replies on the PR, claiming nothing", async () => {
      const { deps, job, fake, f, q, paths, outbox } = revising()
      expect(await runJob(deps, job.id)).toMatchObject({ status: "done", reason: "revised (round 1 of 3)", prUrl: PR_URL, branch: "STEP-7-fix-the-date" })
      expect(fake.called("claimIssue")).toEqual([])
      expect(fake.called("updateIssue")).toEqual([])
      const lines = f.lines()
      // As origin has it, a person's commits included.
      expect(lines.some((l) => l.endsWith("checkout -B STEP-7-fix-the-date origin/STEP-7-fix-the-date"))).toBe(true)
      expect(lines.some((l) => l.endsWith(" push -u origin HEAD:refs/heads/STEP-7-fix-the-date"))).toBe(true)
      expect(lines.some((l) => / push .*(--force|\s-f\b|\+HEAD)/.test(l))).toBe(false)
      expect(lines.some((l) => /^gh pr (create|merge|review)|dismiss|\s--failed\b/.test(l))).toBe(false)
      const replyFile = join(paths.state, "pr-reply-STEP-7.md")
      expect(lines).toContain(`gh pr comment ${PR_URL} --repo STEP-Network/v0-politiske-annoncer --body-file ${replyFile}`)
      expect(readFileSync(replyFile, "utf8")).toBe(
        "eve's revision, round 1 of 3:\n\nUse the publication date: done, in lib/notice.ts.\nTest: fixed the assertion.\n\n1 commit pushed to STEP-7-fix-the-date.\n\n" +
          "## Sweep checklist\n" +
          "- Sibling call sites: rg -n 'createdAt' lib app: one other reader, lib/feed.ts, changed too\n" +
          "- Public outputs and exports: the notice page and its PDF, both through the same helper\n" +
          "- Caches and version keys: none: the notice cache keys on the id, and its output keeps its meaning\n" +
          "- Crons, reminders and emails: none: no cron, reminder or email reads the date\n" +
          "- Docs and comments: rg -n 'createdAt' API_DOCUMENTATION.md .claude/reference: one line updated\n" +
          "- Translations: none: no messages changed\n\n" +
          "## Mutation checks\n- None listed.\n",
      )
      const brief = q.seen[0].prompt
      expect(brief).toMatch(/^# STEP-7: Fix the date \(revise, round 1 of 3\)/)
      expect(brief).toContain(`The PR: ${PR_URL}, on branch STEP-7-fix-the-date.`)
      expect(brief).toContain("- changes requested by nate\n- Test failed")
      expect(brief).toContain("### nate, review, changes requested, 2026-09-24T11:00:00.000Z\n\nUse the publication date.")
      expect(brief).toContain("### nate, lib/notice.ts:12, 2026-09-24T11:01:00Z\n\nThis reads the wrong field.")
      expect(brief).toContain("### Test\n\n```\nFAIL lib/notice.test.ts\n  expected 2026-09-01, got 2026-08-31\n```")
      // Older than the round, or the PR author's own: not feedback.
      for (const text of ["An older point.", "Eve's own earlier reply.", "Eve on her own code.", "Eve's own review note."]) expect(brief).not.toContain(text)
      expect(outbox()).toEqual([`STEP-7: I fixed the review comments and the failing checks on <${PR_URL}|PR #1674> and pushed the fixes. Nothing needed from you.`])
    })

    it("keeps what the round's feedback said, its must-fix findings and its failing checks, for the weekly retro (STEP-3290)", async () => {
      const view = JSON.parse(VIEW)
      view.comments.push({ id: "C2", author: { login: "claude" }, body: "Review\n**BLOCKER** lib/notice.ts:12 reads createdAt\nPOLISH naming", createdAt: "2026-09-24T11:06:00.000Z" })
      const { deps, job, paths } = revising({ exec: answers([[/^gh pr view \S+ --json author,reviews/, { stdout: JSON.stringify(view) }]]) })
      await runJob(deps, job.id)
      expect(readLessons(paths).map((l) => [l.category, l.who ?? null, l.text, l.pr, l.source])).toEqual([
        ["review", "nate", "review, changes requested: Use the publication date.", PR_URL, "github"],
        ["review", "nate", "lib/notice.ts:12: This reads the wrong field.", PR_URL, "github"],
        ["review", "claude", "PR comment: Review\n**BLOCKER** lib/notice.ts:12 reads createdAt\nPOLISH naming", PR_URL, "github"],
        ["fix", "claude", "**BLOCKER** lib/notice.ts:12 reads createdAt", PR_URL, "github"],
        ["check", null, "Test failed", PR_URL, "github"],
      ])
    })

    describe("a PR that clashes with its base (STEP-3340)", () => {
      const MERGE_ONLY = { ...REVISE, reasons: ["merge conflict with staging"] }
      const MERGED: SdkMessage = { ...DONE, structured_output: { status: "done", summary: "lib/notice.ts: kept the PR's date and staging's new field.", checklist: SWEEP } }
      const clash: Array<[RegExp, Partial<ExecResult>]> = [
        [/ merge --no-ff --no-edit origin\/staging$/, { code: 1, stderr: "CONFLICT (content): Merge conflict in lib/notice.ts" }],
        [/ diff --name-only --diff-filter=U$/, { stdout: "lib/notice.ts\n" }],
        // What the merge brought: staging's own test among it. Only lib/notice.ts still differs from staging.
        [/ diff --name-only origin\/STEP-7-fix-the-date\.\.\.HEAD$/, { stdout: "lib/notice.ts\nlib/staging-only.test.ts\n" }],
        [/ diff --name-only origin\/staging HEAD$/, { stdout: "lib/notice.ts\n" }],
      ]
      const merging = (over: Array<[RegExp, Partial<ExecResult>]> = [], reasons = MERGE_ONLY.reasons, messages = [INIT, MERGED]) =>
        revising({ job: { kind: "revise", revise: { ...REVISE, reasons } }, messages, exec: answers([...over, ...clash]) })

      it("starts the merge outside the sandbox, briefs the worker on the conflicts alone, and pushes the merge", async () => {
        const { deps, job, f, q, paths, outbox } = merging()
        expect(await runJob(deps, job.id)).toMatchObject({ status: "done", reason: "revised (merge round 1 of 3)", prUrl: PR_URL })
        const lines = f.lines()
        const checkout = lines.findIndex((l) => l.endsWith("checkout -B STEP-7-fix-the-date origin/STEP-7-fix-the-date"))
        const merge = lines.findIndex((l) => / merge --no-ff --no-edit origin\/staging$/.test(l))
        expect(checkout).toBeGreaterThan(-1)
        expect(merge).toBeGreaterThan(checkout)
        // Through the runner's safe git: no hook, no replace ref.
        expect(lines[merge]).toMatch(/^git --no-replace-objects -c core\.hooksPath=\/dev\/null -c core\.fsmonitor=false -C \S+ merge /)
        expect(lines.some((l) => /\brebase\b| push .*(--force|\s-f\b|\+HEAD)/.test(l))).toBe(false)
        // No feedback gathered: a merge round answers none.
        expect(lines.some((l) => l.includes("--json author,reviews"))).toBe(false)
        const brief = q.seen[0].prompt
        expect(brief).toMatch(/^# STEP-7: Fix the date \(revise, merge round 1 of 3\)/)
        expect(brief).toContain("these files conflict:\n\n- lib/notice.ts\n")
        expect(brief).not.toContain("## Review feedback since")
        // The merge commit counts once, not as every commit it brought.
        expect(lines.some((l) => l.endsWith("rev-list --count origin/STEP-7-fix-the-date..HEAD --first-parent"))).toBe(true)
        expect(lines.some((l) => l.endsWith(" push -u origin HEAD:refs/heads/STEP-7-fix-the-date"))).toBe(true)
        expect(readFileSync(join(paths.state, "pr-reply-STEP-7.md"), "utf8")).toMatch(/^eve's revision, merge round 1 of 3:\n\nlib\/notice\.ts: kept the PR's date/)
        expect(outbox()).toEqual([`STEP-7: I fixed the clash with newer changes in staging on <${PR_URL}|PR #1674> and pushed the fixes. Nothing needed from you.`])
      })

      it("asks for no mutation check of the tests the merge brought in, nor of a merge round's own", async () => {
        // No mutations listed. staging's test came in by the merge; a merge round writes no tests of its own.
        const { deps, job, q, paths } = merging([[/ diff --name-only origin\/staging HEAD$/, { stdout: "lib/notice.ts\nlib/notice.test.ts\n" }], [/ diff --name-only origin\/STEP-7-fix-the-date\.\.\.HEAD$/, { stdout: "lib/notice.ts\nlib/notice.test.ts\nlib/staging-only.test.ts\n" }]])
        expect(await runJob(deps, job.id)).toMatchObject({ status: "done", reason: "revised (merge round 1 of 3)" })
        // Not asked again, and nothing left for the reviewer.
        expect(q.seen).toHaveLength(1)
        expect(readFileSync(join(paths.state, "pr-reply-STEP-7.md"), "utf8")).not.toContain("self-check was incomplete")
      })

      it("in a round with feedback too, asks for mutation checks of the round's own tests only", async () => {
        const both = ["changes requested by ada", "merge conflict with staging"]
        const reply = (paths: { state: string }) => readFileSync(join(paths.state, "pr-reply-STEP-7.md"), "utf8")
        const own = merging([], both)
        expect(await runJob(own.deps, own.job.id)).toMatchObject({ status: "done", reason: "revised (round 1 of 3)" })
        expect(reply(own.paths)).not.toContain("self-check was incomplete")
        const tested = merging(
          [
            [/ diff --name-only origin\/staging HEAD$/, { stdout: "lib/notice.ts\nlib/notice.test.ts\n" }],
            [/ diff --name-only origin\/STEP-7-fix-the-date\.\.\.HEAD$/, { stdout: "lib/notice.ts\nlib/notice.test.ts\nlib/staging-only.test.ts\n" }],
          ],
          both,
        )
        expect(await runJob(tested.deps, tested.job.id)).toMatchObject({ status: "done" })
        expect(reply(tested.paths)).toContain("self-check was incomplete (the branch changes tests (lib/notice.test.ts) but the report lists no mutation check)")
      })

      it("never pushes commits that leave a conflict marker the round added, and ends the round stuck, asking what next", async () => {
        const marked = "diff --git a/docs/notice.md b/docs/notice.md\n--- a/docs/notice.md\n+++ b/docs/notice.md\n@@ -3 +3,5 @@\n+<<<<<<< HEAD\n+the PR's\n+=======\n+staging's\n+>>>>>>> origin/staging\n"
        const { deps, job, f, outbox } = merging([[/ diff --no-color --no-ext-diff --no-textconv --text -U0 origin\/(STEP-7-fix-the-date|staging) HEAD$/, { stdout: marked }]])
        expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason: "leftover conflict marker in docs/notice.md" })
        expect(f.lines().some((l) => / push /.test(l))).toBe(false)
        expect(outbox().join("\n")).toContain(`on <${PR_URL}|PR #1674>: leftover conflict marker in docs/notice.md. Nothing new was pushed. Reply "fix it"`)
      })

      it("pushes a merge whose only marker-like line came from the base", async () => {
        const marked = "diff --git a/vendor/x.txt b/vendor/x.txt\n--- a/vendor/x.txt\n+++ b/vendor/x.txt\n@@ -0,0 +1 @@\n+>>>>>>> the base's own line\n"
        const { deps, job, f } = merging([[/ diff --no-color --no-ext-diff --no-textconv --text -U0 origin\/STEP-7-fix-the-date HEAD$/, { stdout: marked }]])
        expect(await runJob(deps, job.id)).toMatchObject({ status: "done" })
        expect(f.lines().some((l) => l.endsWith(" push -u origin HEAD:refs/heads/STEP-7-fix-the-date"))).toBe(true)
      })

      it("ends a merge round that committed nothing as a stuck round, asking what next", async () => {
        const { deps, job, outbox } = merging([[/rev-list --count origin\/STEP-7-fix-the-date\.\.HEAD/, { stdout: "0\n" }]])
        expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason: "the merge of staging was not committed, so the PR still clashes with it" })
        expect(outbox().join("\n")).toContain(`I could not finish the fixes for the clash with newer changes in staging on <${PR_URL}|PR #1674>: the merge of staging was not committed, so the PR still clashes with it. Nothing new was pushed. Reply "fix it"`)
      })

      it("stops before the session when the merge cannot start", async () => {
        const { deps, job, q } = merging([[/ merge --no-ff --no-edit origin\/staging$/, { code: 128, stderr: "fatal: refusing to merge unrelated histories" }], [/ diff --name-only --diff-filter=U$/, { stdout: "" }]])
        const result = await runJob(deps, job.id)
        expect(result).toMatchObject({ status: "blocked" })
        expect(result.reason).toMatch(/^the merge of staging could not start: git -C \S+ merge --no-ff --no-edit origin\/staging failed \(128\): fatal: refusing to merge unrelated histories/)
        expect(q.seen).toEqual([])
      })
    })

    it("skips a revise job whose PR has closed meanwhile", async () => {
      const { deps, job, q, f } = revising({ exec: answers([[/^gh pr view \S+ --json state$/, { stdout: '{"state":"MERGED"}' }]]) })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "skipped", reason: "the PR is merged, so there is nothing to revise", prUrl: PR_URL })
      expect(q.seen).toEqual([])
      expect(f.lines().some((l) => l.includes("worktree add"))).toBe(false)
    })

    it("replies without pushing when no point needed a change", async () => {
      const { deps, job, f, paths, outbox } = revising({ exec: answers([[/rev-list --count origin\/STEP-7-fix-the-date\.\.HEAD/, { stdout: "0\n" }]]) })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "done" })
      expect(f.lines().some((l) => l.includes(" push "))).toBe(false)
      expect(readFileSync(join(paths.state, "pr-reply-STEP-7.md"), "utf8")).toContain("\n\nNo commit pushed.\n")
      expect(outbox()).toEqual([`STEP-7: I went through the review comments and the failing checks on <${PR_URL}|PR #1674> and answered each point on the PR. No code needed changing. Nothing needed from you.`])
    })

    it("says on the PR and in the issue's thread when it could not finish the round", async () => {
      const said: SdkMessage = { ...DONE, structured_output: { status: "blocked", summary: "The migration needs a person." } }
      const { deps, job, f, paths, fake } = revising({ messages: [INIT, said] })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason: "The migration needs a person", prUrl: PR_URL })
      expect(readFileSync(join(paths.state, "pr-reply-STEP-7.md"), "utf8")).toBe("eve could not finish this revision (round 1 of 3): The migration needs a person.\n\n1 commit pushed to STEP-7-fix-the-date.\n")
      expect(f.lines().some((l) => l.endsWith(" push -u origin HEAD:refs/heads/STEP-7-fix-the-date"))).toBe(true)
      const thread = listNew<{ kind: string; text: string; question: boolean }>(paths.outbox).map((e) => e.payload).find((p) => p.kind === "issue")
      expect(thread).toMatchObject({
        question: true,
        text: `I could not finish the fixes for the review comments and the failing checks on <${PR_URL}|PR #1674>: The migration needs a person. I pushed what I had so far. Reply "fix it" and I will try again, or "leave it" and I will leave the PR to a person.`,
      })
      expect(fake.called("updateIssue")).toEqual([])
    })

    const LINK = `<${PR_URL}|PR #1674>`
    const WHAT = "the review comments and the failing checks"
    const ZERO: Array<[RegExp, Partial<ExecResult>]> = [[/rev-list --count origin\/STEP-7-fix-the-date\.\.HEAD/, { stdout: "0\n" }]]
    const sent = (paths: RunDeps["paths"]) => listNew<{ kind: string; text: string; question?: boolean }>(paths.outbox).map((e) => e.payload)
    /** The round before this one on the same PR, as agentd keeps it in jobs/done. */
    const earlierRound = (paths: RunDeps["paths"], reason: string) => {
      mkdirSync(join(paths.jobs, "done"), { recursive: true })
      writeFileSync(
        join(paths.jobs, "done", "STEP-7-20260924080000.json"),
        JSON.stringify({
          id: "STEP-7-20260924080000", issue: "STEP-7", kind: "revise", model: null, submittedAt: "2026-09-24T08:00:00.000Z", endedAt: "2026-09-24T08:30:00.000Z",
          revise: REVISE, result: { status: "blocked", reason, prUrl: PR_URL, branch: REVISE.branch, costUsd: null, turns: null, minutes: 30 },
        }),
      )
    }

    it("never stops a round on the self-check alone: with nothing new to push, it answers on the PR and asks nobody (Eve, PR #1704)", async () => {
      // Her answers: a reason where there was nothing to search, which a round with no code of its own may give.
      const answered: SdkMessage = {
        ...DONE,
        structured_output: { status: "done", summary: "Use the publication date: already done.", checklist: { ...SWEEP, siblings: "none: this round only answers the reviewer", docs: "none: no doc describes the date" } },
      }
      const eve = revising({ messages: [INIT, answered], exec: answers(ZERO) })
      expect(await runJob(eve.deps, eve.job.id)).toMatchObject({ status: "done", reason: "revised (round 1 of 3)" })
      expect(eve.q.seen).toHaveLength(1)
      // No answers at all: asked once, then the reply goes out with the gaps named for the reviewer.
      const bare: SdkMessage = { ...DONE, structured_output: { status: "done", summary: "Use the publication date: already done." } }
      const { deps, job, q, paths, outbox } = revising({ sessions: [[INIT, bare], [INIT, bare]], exec: answers(ZERO) })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "done", reason: "revised (round 1 of 3)" })
      expect(q.seen).toHaveLength(2)
      expect(readFileSync(join(paths.state, "pr-reply-STEP-7.md"), "utf8")).toContain(
        "Not answered by the worker: siblings, publicOutputs, caches, coupled, docs, translations. A reviewer should check these.",
      )
      expect(sent(paths).some((p) => p.question)).toBe(false)
      expect(outbox()).toEqual([
        `STEP-7: I went through ${WHAT} on ${LINK} and answered each point on the PR. No code needed changing. I noted on the PR what the reviewer should double-check. Nothing needed from you.`,
      ])
    })

    it("asks nobody when a round stops for the reason the round before stopped for, and notes on the PR what is left", async () => {
      const said: SdkMessage = { ...DONE, structured_output: { status: "blocked", summary: "The migration needs a person." } }
      const { deps, job, paths } = revising({ messages: [INIT, said] })
      earlierRound(paths, "The migration needs a person")
      expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason: "The migration needs a person" })
      const plain = `I could not finish the fixes for ${WHAT} on ${LINK} again, for the same reason as last time: The migration needs a person. I pushed what I had so far. I noted on the PR what is left for the reviewer, and I will not ask about it again. Nothing needed from you.`
      expect(sent(paths)).toEqual([
        expect.objectContaining({ kind: "issue", question: false, text: plain }),
        expect.objectContaining({ kind: "post", text: `STEP-7: ${plain}` }),
      ])
      expect(readFileSync(join(paths.state, "pr-reply-STEP-7.md"), "utf8")).toContain("Left for the reviewer: The migration needs a person. eve does not ask about it again.")
      expect(readFileSync(join(paths.logs, "ledger.jsonl"), "utf8")).toContain('"type":"pr.reviseRepeated"')
      // A round before that stopped for another reason: this stop is new, and asked about.
      const other = revising({ messages: [INIT, said] })
      earlierRound(other.paths, "the wall-clock limit of 90 minutes")
      await runJob(other.deps, other.job.id)
      expect(sent(other.paths).filter((p) => p.question)).toHaveLength(1)
      // That one calls the people to it (spec 6); the repeat above called nobody.
      expect(sent(other.paths).filter((p) => p.text.startsWith("<@UNATE> STEP-7 is blocked."))).toHaveLength(1)
    })

    it("answers in the issue's thread too when the round before asked there", async () => {
      const { deps, job, paths } = revising()
      earlierRound(paths, "The migration needs a person")
      await runJob(deps, job.id)
      expect(sent(paths).find((p) => p.kind === "issue")).toEqual(
        expect.objectContaining({ question: false, text: `I fixed ${WHAT} on ${LINK} and pushed the fixes. Nothing needed from you.` }),
      )
    })

    it("tells people what happened in plain words, whatever the round's end", async () => {
      const ends: SdkMessage[] = [
        REVISED,
        { ...DONE, structured_output: { status: "done", summary: "x" } },
        { ...DONE, structured_output: { status: "needs_input", summary: "x", question: "Should the notice show the publication date or the signing date?" } },
        { ...DONE, structured_output: { status: "blocked", summary: "The migration needs a person." } },
      ]
      for (const end of ends) {
        const { deps, job, paths } = revising({ sessions: [[INIT, end], [INIT, end]] })
        await runJob(deps, job.id)
        for (const p of sent(paths)) expect(p.text, p.text).not.toMatch(JARGON)
      }
    })

    it("refuses to revise a branch origin no longer has", async () => {
      const { deps, job, q } = revising({ exec: answers([[/ls-remote/, { code: 2 }]]) })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason: "origin has no branch STEP-7-fix-the-date to revise" })
      expect(q.seen).toEqual([])
    })
  })

  it("skips without claiming when the issue is no longer Ready", async () => {
    const { deps, job, fake } = setup({ issueOver: { state: "In Review" } })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "skipped", reason: "the issue is In Review, not Ready" })
    expect(fake.called("claimIssue")).toEqual([])
  })

  it("skips without claiming when someone else holds the issue", async () => {
    const { deps, job, fake } = setup({ issueOver: { assigneeId: "user-nate" } })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "skipped", reason: "someone else holds the issue" })
    expect(fake.called("claimIssue")).toEqual([])
  })

  it("parks Try work without a person's OK on its plan, for /refine to ask, and launches nothing (Wave 2)", async () => {
    const { deps, job, fake, q } = setup({ issueOver: { labels: ["polads", "agent-ready", "approval/try"] } })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "skipped", reason: "STEP-7 is Try work without a person's OK on its plan: parked for /refine to ask for it" })
    expect(fake.issues.get("STEP-7")).toMatchObject({ state: "Refining" })
    expect(fake.issues.get("STEP-7")!.labels).toEqual(expect.arrayContaining(["plan-to-approve", "approval/try"]))
    expect(fake.issues.get("STEP-7")!.labels).not.toContain("agent-ready")
    expect(fake.called("claimIssue")).toEqual([])
    expect(q.seen).toHaveLength(0)
  })

  it("launches Try work once its plan is approved", async () => {
    const { deps, job, fake } = setup({ issueOver: { labels: ["polads", "agent-ready", "approval/try", "plan-approved"] } })
    await runJob(deps, job.id)
    expect(fake.called("claimIssue")).toHaveLength(1)
  })

  it("parks a re-asked Try plan once a person answered it with anything but a yes: the recorder took both plan labels off (review)", async () => {
    const asked = ["polads", "agent-ready", "approval/try", "plan-approved", "plan-to-approve"]
    const { removeLabels = [] } = planTransition({ labels: asked }, { words: "make it two tasks" })
    const { deps, job, fake, q } = setup({ issueOver: { labels: asked.filter((l) => !removeLabels.includes(l)) } })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "skipped", reason: "STEP-7 is Try work without a person's OK on its plan: parked for /refine to ask for it" })
    expect(fake.called("claimIssue")).toEqual([])
    expect(q.seen).toHaveLength(0)
  })

  it("parks Try work re-planned after an OK: the new plan waits for its own, whatever the old one said (review)", async () => {
    // /refine planned again and asks about it (plan-to-approve), and plan-approved from the first plan is still there: only the recorder takes it off.
    const { deps, job, fake, q } = setup({ issueOver: { labels: ["polads", "agent-ready", "approval/try", "plan-approved", "plan-to-approve"] } })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "skipped", reason: "STEP-7 is Try work without a person's OK on its plan: parked for /refine to ask for it" })
    expect(fake.issues.get("STEP-7")!.labels).not.toContain("agent-ready")
    expect(fake.called("claimIssue")).toEqual([])
    expect(q.seen).toHaveLength(0)
  })

  it("lets Try work already in flight go on as before: its PR is open", async () => {
    const { deps, job, fake } = setup({ gh: `${PR}\n`, issueOver: { labels: ["polads", "agent-ready", "approval/try"] } })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "skipped", prUrl: PR })
    expect(fake.issues.get("STEP-7")!.state).toBe("In Review")
    expect(fake.issues.get("STEP-7")!.labels).not.toContain("plan-to-approve")
  })

  it("skips and moves the issue to In Review when a PR for the branch is already open", async () => {
    const { deps, job, fake } = setup({ gh: `${PR}\n` })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "skipped", prUrl: PR })
    expect(fake.called("claimIssue")).toEqual([])
    expect(fake.issues.get("STEP-7")!.state).toBe("In Review")
  })

  it("stops before any tool runs when the plugin did not load exactly once", async () => {
    const twice: SdkMessage = { ...INIT, plugins: [{ name: "dev-tasks", path: "/a" }, { name: "dev-tasks", path: "/b" }] }
    const { deps, job, fake, f } = setup({ messages: [twice, DONE] })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason: expect.stringMatching(/loaded 2 times/) })
    expect(f.lines().some((l) => l.startsWith("gh pr create"))).toBe(false)
    expect(fake.issues.get("STEP-7")!.state).toBe("On hold")
  })

  it("stops before any tool runs when the session would bill an API key", async () => {
    const { deps, job, f } = setup({ messages: [{ ...INIT, apiKeySource: "/login managed key" }, DONE] })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason: "the worker would bill an API key (/login managed key), not the subscription" })
    expect(f.lines().some((l) => l.startsWith("gh pr create"))).toBe(false)
  })

  it("is limited, not blocked, when the session ends at the usage limit", async () => {
    const { deps, job, fake } = setup({ messages: [INIT], thrown: "Claude usage limit reached" })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "limited" })
    expect(fake.issues.get("STEP-7")!.state).toBe("Ready")
  })

  it("is blocked with a reason a person can read when the query throws, pushes what was committed, and opens no PR (Review Focus 2)", async () => {
    const { deps, job, fake, f, outbox } = setup({ messages: [INIT], thrown: "Claude Code process exited with code 1" })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason: "the worker process failed: Claude Code process exited with code 1", prUrl: null })
    expect(f.lines().some((l) => l.includes(" push -u origin HEAD:refs/heads/STEP-7-fix-the-date"))).toBe(true)
    expect(f.lines().some((l) => l.startsWith("gh pr create"))).toBe(false)
    expect(fake.issues.get("STEP-7")!.state).toBe("On hold")
    expect(outbox().at(-1)).toBe("STEP-7: I had to stop: my run stopped unexpectedly. I asked in the issue's thread what to do.")
    // And a lesson for the weekly retro (STEP-3290), once.
    expect(readLessons(deps.paths)).toEqual([
      expect.objectContaining({ category: "blocked", source: "runner", issue: "STEP-7", text: "the worker process failed: Claude Code process exited with code 1", key: `blocked:${job.id}` }),
    ])
  })

  it("refuses to resume a branch that changes the agent configuration, before any session, and says why", async () => {
    const { deps, job, q, fake, outbox } = setup({ exec: [[/ls-remote/, { code: 0 }], [/diff --name-only/, { stdout: ".claude/hooks/e2e-gate-guard.sh\n" }]] })
    const reason = "the branch changes the agent configuration (.claude/hooks/e2e-gate-guard.sh), so a person must review it before a worker continues it"
    expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason })
    expect(q.seen).toEqual([])
    expect(fake.issues.get("STEP-7")!.state).toBe("On hold")
    expect(outbox().at(-1)).toBe(`STEP-7: I had to stop: ${reason}. I asked in the issue's thread what to do.`)
  })

  it("stops before any tool runs when the session never sent its init message, hook events aside", async () => {
    const { deps, job, f } = setup({ messages: [DONE] })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason: "the session sent no init message, so the plugin and billing checks could not run" })
    expect(f.lines().some((l) => l.startsWith("gh pr create"))).toBe(false)
    const hookFirst = setup({ messages: [{ type: "system", subtype: "hook_started", hook_event_name: "SessionStart" }, INIT, DONE] })
    expect(await runJob(hookFirst.deps, hookFirst.job.id)).toMatchObject({ status: "done" })
  })

  it("keeps the reason a session that never started gives", async () => {
    const failed: SdkMessage = { type: "result", subtype: "error_during_execution", errors: ["sandbox dependencies are missing"] }
    const { deps, job } = setup({ messages: [failed] })
    expect(await runJob(deps, job.id)).toMatchObject({
      status: "blocked", reason: "the session sent no init message, so the plugin and billing checks could not run (sandbox dependencies are missing)",
    })
  })

  it("is blocked, with nothing pushed, when the worktree cannot be prepared", async () => {
    const { deps, job, q, f } = setup({ exec: [[/pnpm install/, { code: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE" }]] })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason: expect.stringMatching(/^the worktree could not be prepared: pnpm install .* failed \(1\): ERR_PNPM_OUTDATED_LOCKFILE/) })
    expect(q.seen).toEqual([])
    expect(f.lines().some((l) => l.includes(" push "))).toBe(false)
  })

  it("still records the job as done once, blocked but with its PR, when Linear fails while finishing (Review Focus 5)", async () => {
    const { deps, job, paths, outbox } = setup({ failOn: ["attachLink"] })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", reason: expect.stringMatching(/^finishing the job failed: Linear: attachLink failed/), prUrl: PR })
    expect(listJobs(paths, "done")).toHaveLength(1)
    expect(listJobs(paths, "done")[0].result).toMatchObject({ prUrl: PR })
    expect(listJobs(paths, "running")).toEqual([])
    expect(outbox().at(-1)).toMatch(/^STEP-7: finishing the job failed/)
  })

  it("is blocked with the push's own error, and no PR, when the push fails", async () => {
    const { deps, job, paths, outbox } = setup({ exec: [[/ push /, { code: 1, stderr: "remote: Repository not found." }]] })
    expect(await runJob(deps, job.id)).toMatchObject({
      status: "blocked", prUrl: null, reason: expect.stringMatching(/^finishing the job failed: git -C .* push -u origin HEAD:refs\/heads\/STEP-7-fix-the-date failed \(1\): remote: Repository not found\.$/),
    })
    expect(listJobs(paths, "done")).toHaveLength(1)
    expect(outbox()).toEqual(["STEP-7: I started on \"Fix the date\". Nothing needed from you.", expect.stringMatching(/^STEP-7: finishing the job failed/)])
  })
})

describe("modelFor, checkPlugins and checkBilling", () => {
  const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] } })
  const job = { id: "j", issue: "STEP-7", kind: "develop" as const, model: null, submittedAt: "" }

  it("uses Opus for complexity-high, Sonnet otherwise, and the job's own choice first", () => {
    expect(modelFor(issue({ id: "STEP-7", labels: ["complexity-high"] }), job, config)).toBe("opus")
    expect(modelFor(issue({ id: "STEP-7" }), job, config)).toBe("sonnet")
    expect(modelFor(issue({ id: "STEP-7", labels: ["complexity-high"] }), { ...job, model: "sonnet" }, config)).toBe("sonnet")
  })

  it("accepts the plugin loaded once and names any other count", () => {
    expect(checkPlugins([{ name: "dev-tasks", path: "/p" }, { name: "other", path: "/o" }])).toBeNull()
    expect(checkPlugins([])).toMatch(/loaded 0 times/)
    expect(checkPlugins(undefined)).toMatch(/loaded 0 times/)
  })

  it("accepts the subscription and refuses every source that bills an API key", () => {
    expect(checkBilling("none")).toBeNull()
    expect(checkBilling(undefined)).toBeNull()
    for (const source of ["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]) expect(checkBilling(source), source).toMatch(/would bill an API key/)
  })
})

describe("a develop job and the browser test (WS5)", () => {
  const usertest = { enabled: true, previewEnvironment: "Preview – example", previewHost: "^app-[a-z0-9-]+\\.vercel\\.app$", stagingOrigin: "https://staging.example.com" }
  const changed = (files: string) => [[/diff --name-only origin\/staging\.\.\.HEAD/, { stdout: files }]] as Array<[RegExp, Partial<ExecResult>]>
  const arms = (lines: string[]) => lines.filter((l) => l.startsWith("gh pr merge"))

  // The PR as gh answers the browser test: it lists no files a user sees, so the test ends before any browser.
  const prView: Array<[RegExp, Partial<ExecResult>]> = [
    [/^gh pr view \S+ --json number,headRefOid/, { stdout: JSON.stringify({ number: 1701, headRefOid: "e".repeat(40), labels: [], autoMergeRequest: null, state: "OPEN" }) }],
    [/^gh pr diff /, { stdout: "" }],
  ]

  it("leaves auto-merge to the browser test when a user can see the change, which arms it after its test", async () => {
    const { deps, job, f, outbox } = setup({ usertest, exec: [...prView, ...changed("components/account/Profile.tsx\n")] })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "done", prUrl: PR })
    expect(outbox()[1]).toBe(`STEP-7: I opened <${PR}|PR #1701> for "Fix the date". It goes in by itself once I have tried it in a browser and the checks and the review pass. Nothing needed from you.`)
    const lines = f.lines()
    expect(arms(lines)).toEqual([`gh pr merge ${PR} --auto --squash --delete-branch`])
    expect(lines.indexOf(arms(lines)[0])).toBeGreaterThan(lines.findIndex((l) => l.startsWith(`gh pr diff ${PR} --name-only`)))
  })

  it("counts a change it could not list as one a user can see", async () => {
    const { deps, job, outbox } = setup({ usertest, exec: [...prView, [/diff --name-only origin\/staging\.\.\.HEAD/, { code: 1, stderr: "fatal" }]] })
    await runJob(deps, job.id)
    expect(outbox()[1]).toContain("once I have tried it in a browser")
  })

  it("still runs the browser test, which arms auto-merge, when finishing fails after the PR opened", async () => {
    const { deps, job, f } = setup({ usertest, exec: [...prView, ...changed("components/account/Profile.tsx\n")], failOn: ["attachLink"] })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "blocked", prUrl: PR })
    expect(arms(f.lines())).toEqual([`gh pr merge ${PR} --auto --squash --delete-branch`])
  })

  it("arms at once when no user can see the change, or the browser test is off", async () => {
    for (const o of [{ usertest, exec: changed("docs/a.md\n") }, { usertest: { ...usertest, enabled: false }, exec: changed("components/account/Profile.tsx\n") }]) {
      const { deps, job, f, outbox } = setup(o)
      await runJob(deps, job.id)
      expect(outbox()[1]).toContain("It goes in by itself once the checks and the review pass.")
      expect(arms(f.lines())).toEqual([`gh pr merge ${PR} --auto --squash --delete-branch`])
      expect(f.lines().some((l) => l.startsWith(`gh pr view ${PR} --json number,headRefOid`))).toBe(false)
    }
  })
})

describe("a usertest job (WS5)", () => {
  const merged = { url: PR, headRefOid: "e".repeat(40), labels: [{ name: "approval/look" }], state: "MERGED", headRefName: "STEP-7-fix-the-date", title: "fix: the date (STEP-7)" }
  const view = [
    [/gh pr view 12 /, { stdout: JSON.stringify(merged) }],
    [/gh pr diff 12 /, { stdout: "components/account/Profile.tsx\n" }],
  ] as Array<[RegExp, Partial<ExecResult>]>

  it("reads the merged PR, runs the browser test without claiming the issue or a worker session, and ends done with its verdict", async () => {
    // The browser test is off in this config, so the test ends as soon as it starts.
    const { deps, job, fake, f, q, paths } = setup({ job: { kind: "usertest", usertest: { target: "staging", pr: 12 } }, exec: view })
    expect(await runJob(deps, job.id)).toMatchObject({ status: "done", reason: "browser test: skipped, the browser test is off on this mini", prUrl: PR, minutes: 40 })
    expect(fake.called("claimIssue")).toEqual([])
    expect(q.seen).toEqual([])
    expect(f.lines().filter((l) => l.startsWith("gh pr "))).toEqual([
      "gh pr view 12 --repo STEP-Network/v0-politiske-annoncer --json url,headRefOid,labels,state,headRefName,title",
      "gh pr diff 12 --repo STEP-Network/v0-politiske-annoncer --name-only",
    ])
    expect(listJobs(paths, "done")[0]).toMatchObject({ kind: "usertest", userTestStartedAt: "2026-09-24T09:40:00.000Z" })
    // The report's minutes for a PR leave browser tests out by this.
    expect(readFileSync(join(paths.logs, "ledger.jsonl"), "utf8")).toContain('"type":"worker.end","issue":"STEP-7","kind":"usertest"')
  })

  it("says on the issue that the test did not run, so nobody waits for a report", async () => {
    const { deps, job, fake } = setup({ job: { kind: "usertest", usertest: { target: "staging", pr: 12 } }, exec: view })
    await runJob(deps, job.id)
    const said = fake.called("comment") as Array<[string, string]>
    expect(said).toHaveLength(1)
    expect(said[0][0]).toBe("STEP-7")
    expect(said[0][1]).toBe("## Browser test by eve: Did not run\n\nthe browser test is off on this mini\n\nNothing needed from you.")
  })

  it("tests only a merged PR of its own issue", async () => {
    for (const [pr, why] of [
      [{ ...merged, state: "OPEN" }, "the PR is not merged yet, so staging does not have it"],
      [{ ...merged, headRefName: "STEP-8-other", title: "fix: another thing (STEP-8)" }, "the PR is not STEP-7's"],
    ] as const) {
      const { deps, job } = setup({ job: { kind: "usertest", usertest: { target: "staging", pr: 12 } }, exec: [[/gh pr view 12 /, { stdout: JSON.stringify(pr) }], view[1]] })
      expect(await runJob(deps, job.id)).toMatchObject({ status: "skipped", reason: why })
    }
  })

  it("ends skipped, never lost, when the browser test's secrets file is open to others", async () => {
    const { deps, job, paths } = setup({ job: { kind: "usertest", usertest: { target: "staging", pr: 12 } }, exec: view, usertest: { enabled: true, previewEnvironment: "Preview – example", previewHost: "^app-[a-z0-9-]+\\.vercel\\.app$", stagingOrigin: "https://staging.example.com" } })
    mkdirSync(join(paths.home, ".config", "agentd"), { recursive: true })
    writeFileSync(join(paths.home, ".config", "agentd", "usertest.env"), "TEST_LOGIN_SECRET=x\n", { mode: 0o644 })
    const result = await runJob(deps, job.id)
    expect(result.status).toBe("skipped")
    expect(result.reason).toMatch(/^the browser test could not start: .*usertest\.env/)
    expect(listJobs(paths, "done")).toHaveLength(1)
  })

  it("runs, and says so on the issue, even when the main checkout's history is rewritten: a browser test uses no worktree", async () => {
    const { deps, job, paths, fake } = setup({ job: { kind: "usertest", usertest: { target: "staging", pr: 12 } }, exec: view })
    mkdirSync(join(deps.config.repo.path, ".git"), { recursive: true })
    writeFileSync(join(deps.config.repo.path, ".git", "shallow"), "x")
    expect(await runJob(deps, job.id)).toMatchObject({ status: "done", reason: "browser test: skipped, the browser test is off on this mini" })
    expect(existsSync(paths.pauseFile)).toBe(false)
    expect(fake.called("comment")).toHaveLength(1)
  })

  it("ends skipped, never lost, when the job has no PR or gh cannot read it", async () => {
    const none = setup({ job: { kind: "usertest" } })
    expect(await runJob(none.deps, none.job.id)).toMatchObject({ status: "skipped", reason: "a usertest job without its PR" })
    const unreadable = setup({ job: { kind: "usertest", usertest: { target: "staging", pr: 12 } }, exec: [[/gh pr view/, { code: 1 }]] })
    expect(await runJob(unreadable.deps, unreadable.job.id)).toMatchObject({ status: "skipped", reason: "gh could not read the PR" })
  })
})

describe("runSession's own init check (WS5)", () => {
  it("stops a session whose init message fails the caller's check, after the plugin and billing checks pass", async () => {
    const { query } = queryOf([[INIT, DONE]])
    const end = await runSession(query, "go", {}, 1, 1, () => "no browser")
    expect(end).toMatchObject({ initProblem: "no browser", result: null })
    const ok = await runSession(queryOf([[INIT, DONE]]).query, "go", {}, 1, 1, () => null)
    expect(ok.initProblem).toBeNull()
    expect(ok.result).toMatchObject({ subtype: "success" })
  })
})

describe("sdkOptions", () => {
  const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/Users/eve/polads" }, pluginRoot: "/Users/eve/dev-tasks/plugin", slack: { allowedUsers: ["UNATE"] } })
  const WT = "/Users/eve/.agentd/worktrees/STEP-7-fix-the-date"
  const options = () =>
    sdkOptions({ config, cwd: WT, model: "sonnet", abortController: new AbortController(), rules: "R", pnpmStore: "/store", env: { PATH: "/bin" }, home: "/Users/eve" }) as any

  it("wires the plugin, the project settings, the guard, the sandbox and the limits", async () => {
    const o = options()
    expect(o).toMatchObject({
      cwd: WT, model: "sonnet", maxTurns: 250, maxBudgetUsd: 15, permissionMode: "acceptEdits",
      settingSources: ["project"],
      plugins: [{ type: "local", path: "/Users/eve/dev-tasks/plugin", skipMcpDiscovery: true }],
      disallowedTools: ["WebFetch", "WebSearch", "Agent", "Task", "Skill"],
      systemPrompt: { type: "preset", preset: "claude_code", append: "R" },
      outputFormat: { type: "json_schema" },
      env: { PATH: "/bin" },
    })
    expect(o.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false })
    expect(o.sandbox.network).toEqual({ allowedDomains: ["registry.npmjs.org"], allowLocalBinding: true, strictAllowlist: true })
    expect(o.sandbox.filesystem.allowWrite).toEqual(["/Users/eve/polads/.git", "/store"])
    expect(o.hooks.PreToolUse[0].matcher).toBe("Bash")
    expect(await o.canUseTool("WebFetch", {})).toMatchObject({ behavior: "deny" })
  })

  it("takes the project's settings, hooks and MCP servers from the main checkout, never from the worker's branch", () => {
    expect(options()).toMatchObject({ projectConfigRoot: "/Users/eve/polads", strictMcpConfig: true })
  })

  it("keeps the worker away from the machine's secrets: no read of ~/.config or a .env file, no token in its commands", async () => {
    const o = options()
    expect(o.sandbox.filesystem.denyRead).toEqual(["/Users/eve/.config", "/Users/eve/**/.env*"])
    expect(o.sandbox.filesystem.allowRead).toEqual(["/Users/eve/**/.env.example"])
    expect(o.sandbox.credentials.envVars).toEqual([{ name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" }])
    expect(o.settings.permissions.deny).toEqual([
      "Read(~/.config/**)",
      "Edit(~/.config/**)",
      `Edit(/${WT}/.claude/hooks/**)`,
      `Edit(/${WT}/.claude/settings*.json)`,
      `Edit(/${WT}/.mcp.json)`,
    ])
    expect(o.settings.permissions.deny[2]).toBe("Edit(//Users/eve/.agentd/worktrees/STEP-7-fix-the-date/.claude/hooks/**)")
    expect(await o.canUseTool("Read", { file_path: "/Users/eve/.config/linear/.env" })).toMatchObject({
      behavior: "deny", message: expect.stringMatching(/^Workers never read or write ~\/\.config or \.env files/),
    })
    const pathHook = o.hooks.PreToolUse[1]
    expect(pathHook.matcher).toBeUndefined()
    expect(await pathHook.hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "~/.config/agentd/slack.env" } })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    })
    expect(await pathHook.hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/Users/eve/polads/lib/x.ts" } })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: `Workers write only inside their worktree, ${WT}.` },
    })
    expect(await pathHook.hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: `${WT}/lib/x.ts` } })).toEqual({})
    expect(await pathHook.hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: `${WT}/.claude/hooks/e2e-gate-guard.sh` } })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(/^Workers never change the project's agent configuration/) },
    })
  })

  it("never lets the worker rewrite git's pointers or the agent configuration, which run outside the sandbox", () => {
    expect(options().sandbox.filesystem.denyWrite).toEqual([
      `${WT}/.git`,
      "/Users/eve/polads/.git/commondir",
      "/Users/eve/polads/.git/info/grafts",
      "/Users/eve/polads/.git/shallow",
      "/Users/eve/polads/.git/worktrees/STEP-7-fix-the-date/commondir",
      "/Users/eve/polads/.git/worktrees/STEP-7-fix-the-date/gitdir",
      "/Users/eve/polads/.git/worktrees/STEP-7-fix-the-date/config.worktree",
      "/Users/eve/polads/.git/worktrees/*/commondir",
      "/Users/eve/polads/.git/worktrees/*/gitdir",
      "/Users/eve/polads/.git/worktrees/*/config.worktree",
      `${WT}/.claude/hooks`,
      `${WT}/.claude/settings.json`,
      `${WT}/.claude/settings.local.json`,
      `${WT}/.mcp.json`,
    ])
  })
})

describe("the worker's process", () => {
  it("starts only as worker/run.ts, never inside another process whose file is also called run.ts (the weekly retro's)", () => {
    // retro/run.ts imports this module: a job started there would exit that process within seconds.
    const runtime = join(import.meta.dirname, "..", "..", "..")
    const home = mkdtempSync(join(tmpdir(), "worker-guard-"))
    const script = join(home, "retro", "run.ts")
    mkdirSync(join(home, "retro"))
    writeFileSync(script, `import ${JSON.stringify(join(runtime, "src", "worker", "run.ts"))}\nsetTimeout(() => console.log("still running"), 500)\n`)
    const run = spawnSync(join(runtime, "node_modules", ".bin", "tsx"), [script, "2026-09-28"], {
      cwd: home,
      env: { PATH: process.env.PATH ?? "", HOME: home, AGENTD_HOME: join(home, ".agentd") },
      encoding: "utf8",
      timeout: 30_000,
    })
    expect(run.stdout.trim()).toBe("still running")
    expect(run.status).toBe(0)
  }, 30_000)
})
