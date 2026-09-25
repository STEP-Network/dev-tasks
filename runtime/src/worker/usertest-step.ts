/**
 * The browser test as a worker's job (WS5): at the end of develop and revise
 * jobs (userTestStep, Task 8), and as a job of its own on staging for agent
 * UAT (runUserTestJob, which review-uat queues with agentctl usertest).
 */
import { loadUserTestSecrets } from "../secrets.ts"
import { updateJob, type JobRecord, type JobResult } from "../jobs.ts"
import { classOfLabels, type TrackerIssue } from "../tracker.ts"
import { reportMarkdown } from "../usertest/result.ts"
import { runUserTest, userTestDeps } from "../usertest/run.ts"
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
