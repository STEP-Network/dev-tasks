/**
 * The browser test as a worker's job (WS5): at the end of develop and revise
 * jobs (userTestStep), and as a job of its own on staging for agent
 * UAT (runUserTestJob, which review-uat queues with agentctl usertest).
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadUserTestSecrets } from "../secrets.ts"
import { updateJob, type JobRecord, type JobResult, type ReviseRequest } from "../jobs.ts"
import { appendLedger } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import { prLink } from "../plain.ts"
import { classOfLabels, type TrackerIssue } from "../tracker.ts"
import { reportMarkdown } from "../usertest/result.ts"
import { runUserTest, userTestDeps } from "../usertest/run.ts"
import { BROWSER_TEST_REASON, readUserTestState } from "../usertest/state.ts"
import type { MergeMode } from "./finalize.ts"
import type { RunDeps } from "./run.ts"

export async function runUserTestJob(deps: RunDeps, job: JobRecord, finish: (r: JobResult) => JobResult): Promise<JobResult> {
  const { config, exec, paths } = deps
  const minutes = () => Math.round((deps.now().getTime() - Date.parse(job.startedAt ?? deps.now().toISOString())) / 60_000)
  const nothing = { prUrl: null, branch: null, costUsd: null, turns: null }
  // A test that did not run says so on the issue: review-uat waits for a report there.
  const didNotRun = async (reason: string) => {
    const text = reportMarkdown({ mini: config.mini, result: null, verdict: "skipped", reason, site: null, personaNote: "", images: [], gifUrl: null, keptLocal: 0 })
    await deps.tracker.comment(job.issue, text).catch((error: unknown) => deps.log.warn("browser test note not posted on the issue", { issue: job.issue, error: String(error) }))
  }
  const skipped = async (reason: string) => {
    await didNotRun(reason)
    return finish({ ...nothing, minutes: minutes(), status: "skipped", reason })
  }
  if (!job.usertest) return skipped("a usertest job without its PR")
  let pr: { url: string; headRefOid: string; labels?: Array<{ name: string }>; state?: string; headRefName?: string; title?: string }
  let changedPaths: string[]
  let issue: TrackerIssue
  let secrets: { testLoginSecret: string | null; bypassSecret: string | null }
  try {
    const view = await exec("gh", ["pr", "view", String(job.usertest.pr), "--repo", config.repo.slug, "--json", "url,headRefOid,labels,state,headRefName,title"], { cwd: config.repo.path })
    const diff = await exec("gh", ["pr", "diff", String(job.usertest.pr), "--repo", config.repo.slug, "--name-only"], { cwd: config.repo.path })
    if (view.code !== 0 || diff.code !== 0) return skipped("gh could not read the PR")
    pr = JSON.parse(view.stdout) as typeof pr
    // Staging has only what is merged, and the report goes on this PR and this issue.
    if (pr.state !== "MERGED") return skipped("the PR is not merged yet, so staging does not have it")
    const ours = new RegExp(`\\b${job.issue}\\b`, "i")
    if (!ours.test(pr.headRefName ?? "") && !ours.test(pr.title ?? "")) return skipped(`the PR is not ${job.issue}'s`)
    changedPaths = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    issue = await deps.tracker.readIssue(job.issue)
    // A secrets file other users can read throws here, and ends the job the ordinary way.
    secrets = config.usertest.enabled ? loadUserTestSecrets(paths.home) : { testLoginSecret: null, bypassSecret: null }
  } catch (error) {
    // Ended the ordinary way, never a crash: a crash here would count as a worker lost early (agentd, heldBackIssues).
    return skipped(`the browser test could not start: ${error instanceof Error ? error.message : String(error)}`)
  }
  updateJob(paths, "running", job.id, { userTestStartedAt: deps.now().toISOString() })
  const outcome = await runUserTest(
    userTestDeps({ paths, config, exec, tracker: deps.tracker, now: deps.now, log: deps.log, fetchImpl: fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), secrets }, deps.query, deps.claudeToken),
    {
      issue,
      target: { kind: job.usertest.target, prUrl: pr.url, prNumber: job.usertest.pr, headSha: pr.headRefOid },
      changedPaths,
      approvalClass: classOfLabels((pr.labels ?? []).map((l) => l.name)),
    },
  )
  if (!outcome.reported) await didNotRun(outcome.reason)
  return finish({ ...nothing, minutes: minutes(), status: "done", reason: `browser test: ${outcome.verdict}, ${outcome.reason}`, prUrl: outcome.commentUrl ?? pr.url, costUsd: outcome.costUsd })
}

const GH = 120_000

/**
 * After the PR is open (develop) or pushed (revise): the browser test on the
 * PR's preview. It arms auto-merge when the mini may auto-merge and the test
 * passed, did not apply, or could not run (the checks and the review still
 * decide, and a test that cannot run never strands work). Findings leave
 * auto-merge off: agentd's PR watcher sends them back to a revise job.
 */
export async function userTestStep(
  deps: RunDeps,
  ctx: { job: JobRecord; issue: TrackerIssue; prUrl: string; merge: MergeMode; pushed: boolean; revise?: ReviseRequest },
): Promise<void> {
  const { config, exec, paths, log } = deps
  if (!config.usertest.enabled) return
  // A develop job that finalize armed: run.ts found nothing a user can see, so there is nothing to test.
  if (!ctx.revise && ctx.merge === "auto") return
  let mayArm = ctx.merge === "auto" || ctx.merge === "deferred"
  const opts = { cwd: config.repo.path, timeoutMs: GH }
  // A note that cannot be posted never stops the step: the arming after it matters more.
  const note = async (text: string) => {
    try {
      mkdirSync(paths.state, { recursive: true })
      const file = join(paths.state, `pr-note-${ctx.issue.id}.md`)
      writeFileSync(file, `${text}\n`)
      await exec("gh", ["pr", "comment", ctx.prUrl, "--repo", config.repo.slug, "--body-file", file], opts)
    } catch (error) {
      log.warn("browser test note not posted on the PR", { url: ctx.prUrl, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const prState = async (url: string): Promise<string | null> => {
    try {
      const r = await exec("gh", ["pr", "view", url, "--json", "state"], opts)
      return r.code === 0 ? ((JSON.parse(r.stdout) as { state?: string }).state ?? null) : null
    } catch {
      return null
    }
  }
  /** Whether auto-merge is on after it. */
  const arm = async (): Promise<boolean> => {
    if (!mayArm) return false
    const r = await exec("gh", ["pr", "merge", ctx.prUrl, "--auto", "--squash", "--delete-branch"], opts)
    if (r.code === 0) return true
    log.warn("could not arm auto-merge after the browser test", { url: ctx.prUrl, stderr: r.stderr.trim() })
    // A PR a person merged or closed meanwhile needs no one.
    const state = await prState(ctx.prUrl)
    if (state === "MERGED" || state === "CLOSED") return false
    enqueueSlack(paths, { kind: "post", channel: "agents", text: `${ctx.issue.id}: I could not switch on automatic merging for ${prLink(ctx.prUrl)}. A person needs to merge it once the checks pass.` }, deps.now())
    return false
  }
  // Every arm without a pass says so on the PR: the checks and the review gate it, as before the browser test.
  const untested = async (reason: string) => {
    const on = await arm()
    await note(`${on ? "Auto-merge is on without a browser test" : "The browser test gave no verdict"}: ${reason}. The checks and the review still decide.`)
  }
  try {
    // First: agentd gives the test its own minutes from here, and names the PR if it has to stop the job.
    updateJob(paths, "running", ctx.job.id, { userTestStartedAt: deps.now().toISOString(), userTestPr: ctx.prUrl })
    const view = await exec("gh", ["pr", "view", ctx.prUrl, "--json", "number,headRefOid,labels,autoMergeRequest,state"], opts)
    if (view.code !== 0) throw new Error("gh could not read the PR")
    const pr = JSON.parse(view.stdout) as { number: number; headRefOid: string; labels?: Array<{ name: string }>; autoMergeRequest?: unknown; state?: string }
    // A person merged or closed it meanwhile: nothing to test, and nothing to switch on.
    if (pr.state && pr.state !== "OPEN") return
    const last = readUserTestState(paths, ctx.prUrl)
    // A revise round switches on only what was on, or what the browser test held off: never what a person switched off.
    if (ctx.revise) mayArm = mayArm && (Boolean(pr.autoMergeRequest) || last?.verdict === "findings")
    if (ctx.revise && !ctx.pushed) {
      // Nothing new to test. Findings at this head that this round answered without a change go out with the answer.
      const answered = ctx.revise.reasons.includes(BROWSER_TEST_REASON) || Boolean(ctx.revise.usertestFindings?.length)
      if (last?.head === pr.headRefOid && last.verdict === "findings" && answered) {
        await untested("this round answered the browser test's findings without a code change, in the reply above")
      }
      return
    }
    const diff = await exec("gh", ["pr", "diff", ctx.prUrl, "--name-only"], opts)
    if (diff.code !== 0) {
      await untested("gh could not list the PR's files")
      return
    }
    const changedPaths = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    let stillOn = false
    if (mayArm && pr.autoMergeRequest) {
      const off = await exec("gh", ["pr", "merge", ctx.prUrl, "--disable-auto"], opts)
      stillOn = off.code !== 0
      if (stillOn) {
        log.warn("could not switch auto-merge off for the browser test", { url: ctx.prUrl, stderr: off.stderr.trim() })
        await note("Automatic merging could not be switched off while the browser test ran, so this head may go in before its test ends.")
      }
    }
    const outcome = await runUserTest(
      userTestDeps({ paths, config, exec, tracker: deps.tracker, now: deps.now, log, fetchImpl: fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), secrets: loadUserTestSecrets(paths.home) }, deps.query, deps.claudeToken),
      {
        issue: ctx.issue,
        target: { kind: "preview", prUrl: ctx.prUrl, prNumber: pr.number, headSha: pr.headRefOid },
        changedPaths,
        approvalClass: classOfLabels((pr.labels ?? []).map((l) => l.name)),
      },
    )
    appendLedger(paths, { type: "usertest.end", issue: ctx.issue.id, url: ctx.prUrl, verdict: outcome.verdict, costUsd: outcome.costUsd }, deps.now())
    if (outcome.verdict === "findings") {
      // Findings hold auto-merge off: when it could not be switched off, a person must, or they go in.
      if (stillOn) {
        enqueueSlack(
          paths,
          { kind: "post", channel: "agents", text: `${ctx.issue.id}: the browser test found problems on ${prLink(ctx.prUrl)}, but I could not switch off automatic merging, so it may go in before they are fixed. A person needs to switch it off on the PR.` },
          deps.now(),
        )
      }
      return
    }
    if (outcome.verdict === "pass") {
      await arm()
      return
    }
    await untested(outcome.reason)
  } catch (error) {
    log.warn("browser test step failed", { url: ctx.prUrl, error: error instanceof Error ? error.message : String(error) })
    await untested("the browser test could not run")
  }
}
