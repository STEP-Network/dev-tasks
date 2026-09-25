/**
 * The browser test as a worker's job (WS5): at the end of develop and revise
 * jobs (userTestStep, Task 8), and as a job of its own on staging for agent
 * UAT (runUserTestJob, which review-uat queues with agentctl usertest).
 */
import { loadUserTestSecrets } from "../secrets.ts"
import { updateJob, type JobRecord, type JobResult } from "../jobs.ts"
import { classOfLabels, type TrackerIssue } from "../tracker.ts"
import { runUserTest, userTestDeps } from "../usertest/run.ts"
import type { RunDeps } from "./run.ts"

export async function runUserTestJob(deps: RunDeps, job: JobRecord, finish: (r: JobResult) => JobResult): Promise<JobResult> {
  const nothing = { prUrl: null, branch: null, costUsd: null, turns: null, minutes: 0 }
  if (!job.usertest) return finish({ ...nothing, status: "skipped", reason: "a usertest job without its PR" })
  const { config, exec, paths } = deps
  let pr: { url: string; headRefOid: string; labels?: Array<{ name: string }> }
  let changedPaths: string[]
  let issue: TrackerIssue
  try {
    const view = await exec("gh", ["pr", "view", String(job.usertest.pr), "--repo", config.repo.slug, "--json", "url,headRefOid,labels"], { cwd: config.repo.path })
    const diff = await exec("gh", ["pr", "diff", String(job.usertest.pr), "--repo", config.repo.slug, "--name-only"], { cwd: config.repo.path })
    if (view.code !== 0 || diff.code !== 0) return finish({ ...nothing, status: "skipped", reason: "gh could not read the PR" })
    pr = JSON.parse(view.stdout) as typeof pr
    changedPaths = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    issue = await deps.tracker.readIssue(job.issue)
  } catch (error) {
    // Ended the ordinary way, never a crash: a crash here would count as a worker lost early (agentd, heldBackIssues).
    return finish({ ...nothing, status: "skipped", reason: `the browser test could not start: ${error instanceof Error ? error.message : String(error)}` })
  }
  updateJob(paths, "running", job.id, { userTestStartedAt: deps.now().toISOString() })
  const outcome = await runUserTest(
    userTestDeps({ paths, config, exec, tracker: deps.tracker, now: deps.now, log: deps.log, fetchImpl: fetch, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), secrets: loadUserTestSecrets(paths.home) }, deps.query, deps.claudeToken),
    {
      issue,
      target: { kind: job.usertest.target, prUrl: pr.url, prNumber: job.usertest.pr, headSha: pr.headRefOid },
      changedPaths,
      approvalClass: classOfLabels((pr.labels ?? []).map((l) => l.name)),
    },
  )
  return finish({ ...nothing, status: "done", reason: `browser test: ${outcome.verdict}, ${outcome.reason}`, prUrl: outcome.commentUrl ?? pr.url, costUsd: outcome.costUsd })
}
