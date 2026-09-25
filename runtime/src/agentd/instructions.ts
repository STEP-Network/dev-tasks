/**
 * A person's Slack reply or mention, turned into action now (STEP-3285): the
 * bridge files it as an `instruction` in the inbox (slack/instruction.ts
 * reads the words), and agentd, every 15 seconds, does what it asks for its
 * issue's PR and says in words what it did, in the same thread. A ✅ comes
 * only beside that reply, never instead of it.
 *
 *   pause   writes the PAUSE file (lifting it stays a person's, on the mini)
 *   revise  a revise job for the PR now, past the round cap too: a person asked
 *   rerun   a full re-run of each failing required check's workflow run
 *   retry   a new job for the issue's last blocked job, on its branch
 *   merge   `gh pr merge --auto --squash` where worker.autoMerge and the
 *           project's policy for the PR's base allow it, else why not
 *   leave   nothing: the PR is left to a person
 * Any of them answers the issue's open question (agentd/decisions.ts).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { ack, listNew } from "../fsq.ts"
import { listJobs, readWatchedPrs, submitJob, updateWatchedPr, type JobRecord, type WatchedPr } from "../jobs.ts"
import { appendLedger, type Logger } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import type { Action, InstructionEntry } from "../slack/instruction.ts"
import type { Exec } from "../worker/git.ts"
import { mergeMode, readAutoMergePolicy } from "../worker/run.ts"
import { closeDecision, openDecisions } from "./decisions.ts"
import { requiredChecks } from "./health.ts"
import { failingRequired, MAX_REVISE_ROUNDS, type OwnPrView } from "./revise.ts"

export type { InstructionEntry }

export interface InstructionDeps {
  exec: Exec
  paths: AgentPaths
  config: AgentConfig
  now: () => Date
  log: Logger
}

const GH_TIMEOUT_MS = 2 * 60_000
/** The order a reply's actions run in: a pause first, a merge last, after the revision it waits for. */
const ORDER: Action[] = ["pause", "leave", "revise", "rerun", "retry", "merge"]

/** Every instruction in the inbox: act, reply in its thread, and mark it handled. */
export async function actOnInstructions(deps: InstructionDeps): Promise<void> {
  for (const { key, payload } of listNew<InstructionEntry>(deps.paths.inbox)) {
    if (payload.type !== "instruction") continue
    let lines: string[]
    try {
      lines = await act(deps, payload)
    } catch (error) {
      lines = [`I could not do that: ${error instanceof Error ? error.message : String(error)}.`]
      deps.log.warn("instruction failed", { key, error: String(error) })
    }
    const now = deps.now()
    enqueueSlack(deps.paths, { kind: "reply", channelId: payload.channel, threadTs: payload.threadTs, text: lines.join("\n") }, now)
    // A ✅ beside the words, never instead of them.
    enqueueSlack(deps.paths, { kind: "react", channelId: payload.channel, ts: payload.ts, name: "white_check_mark" }, now)
    ack(deps.paths.inbox, key)
    const issue = payload.issue ?? payload.target.issue
    appendLedger(deps.paths, { type: "instruction", ...(issue ? { issue } : {}), actions: payload.actions, by: payload.userName }, now)
  }
}

/** The watched PR the instruction means: the thread's issue, a named issue, or a named PR of this mini's. */
function findPr(paths: AgentPaths, entry: InstructionEntry): { issue: string | null; pr: WatchedPr | null } {
  const watched = readWatchedPrs(paths)
  const byNumber = (n: number) => watched.find((p) => Number(p.url.split("/").pop()) === n) ?? null
  const issue = entry.issue ?? entry.target.issue ?? null
  if (issue) return { issue, pr: watched.find((p) => p.issue === issue) ?? null }
  if (entry.target.url) {
    const pr = watched.find((p) => p.url === entry.target.url) ?? null
    return { issue: pr?.issue ?? null, pr }
  }
  if (entry.target.pr) {
    const pr = byNumber(entry.target.pr)
    return { issue: pr?.issue ?? null, pr }
  }
  return { issue: null, pr: null }
}

async function viewPr(deps: InstructionDeps, url: string): Promise<OwnPrView & { baseRefName?: string }> {
  const r = await deps.exec("gh", ["pr", "view", url, "--json", "url,number,state,headRefName,headRefOid,baseRefName,statusCheckRollup"], { timeoutMs: GH_TIMEOUT_MS })
  if (r.code !== 0) throw new Error(`gh could not read ${url} (${r.stderr.trim() || `exit ${r.code}`})`)
  return JSON.parse(r.stdout)
}

const busyJob = (paths: AgentPaths, issue: string): JobRecord | null =>
  [...listJobs(paths, "running"), ...listJobs(paths, "pending")].find((j) => j.issue === issue) ?? null

async function act(deps: InstructionDeps, entry: InstructionEntry): Promise<string[]> {
  const { paths, config } = deps
  const now = deps.now()
  const who = entry.userName || entry.user
  const { issue, pr } = findPr(paths, entry)
  if (!issue) {
    return [`I could not tell which PR you mean. Name it (STEP-<n>, #<number> or its link): I act only on PRs this mini opened.`]
  }
  const lines: string[] = []
  const actions = ORDER.filter((a) => entry.actions.includes(a))
  let view: (OwnPrView & { baseRefName?: string }) | null = null
  const open = async () => {
    if (!pr) return null
    view ??= await viewPr(deps, pr.url)
    return view.state === "OPEN" ? view : null
  }
  let revising = false

  for (const action of actions) {
    if (action === "pause") {
      if (existsSync(paths.pauseFile)) {
        lines.push("This mini is paused already. A person lifts it on the mini with agentctl resume.")
      } else {
        const reason = `asked by ${who} in Slack`
        mkdirSync(paths.root, { recursive: true })
        writeFileSync(paths.pauseFile, JSON.stringify({ at: now.toISOString(), reason }))
        appendLedger(paths, { type: "paused", reason }, now)
        lines.push("Paused: no new job starts, and a running one finishes. A person lifts it on the mini with agentctl resume.")
      }
    }
    if (action === "leave") {
      lines.push(pr ? `Leaving ${pr.url} to a person. I will not touch it until someone asks.` : `Leaving ${issue} to a person.`)
    }
    if (action === "revise") {
      const busy = busyJob(paths, issue)
      const v = await open()
      if (busy) {
        lines.push(`Already on it: job ${busy.id} is ${listJobs(paths, "running").some((j) => j.id === busy.id) ? "running" : "queued"}.`)
        revising = busy.kind === "revise"
      } else if (v && pr) {
        const round = (pr.revise?.rounds ?? 0) + 1
        const job = submitJob(paths, issue, null, now, {
          kind: "revise",
          revise: {
            url: v.url, number: v.number, branch: v.headRefName, round, since: pr.revise?.lastRoundAt ?? pr.openedAt,
            reasons: [`asked by ${who} in Slack`], instruction: entry.text,
          },
        })
        updateWatchedPr(paths, { ...pr, revise: { rounds: round, handled: pr.revise?.handled ?? [], lastRoundAt: now.toISOString(), asked: pr.revise?.asked } })
        appendLedger(paths, { type: "pr.revise", issue, url: v.url, round, reasons: [`asked by ${who}`] }, now)
        const past = round > MAX_REVISE_ROUNDS ? `, past the ${MAX_REVISE_ROUNDS}-round cap since you asked` : ""
        lines.push(`Revising ${v.url} now: job ${job.id} (round ${round}${past}).`)
        revising = true
      } else if (lastBlocked(paths, issue)) {
        // No open PR to revise: the work is a blocked job's, so it is retried, once however the reply put it.
        if (!entry.actions.includes("retry")) lines.push(...retry(paths, issue, now))
      } else {
        lines.push(`There is no open PR of mine for ${issue} to fix.`)
      }
    }
    if (action === "rerun") {
      const v = await open()
      if (!v) {
        lines.push(`There is no open PR of mine for ${issue} to re-run.`)
        continue
      }
      const runs = [...new Set(failingRequired(v, requiredChecks(config.repo.path)).map((f) => f.job?.runId).filter((r): r is string => Boolean(r)))]
      if (!runs.length) {
        lines.push(`Nothing required is failing on ${v.url}, so there is nothing to re-run.`)
        continue
      }
      const done: string[] = []
      for (const run of runs) {
        // In full, never --failed: Test shards share a database branch the first run tore down.
        const r = await deps.exec("gh", ["run", "rerun", run, "--repo", config.repo.slug], { timeoutMs: GH_TIMEOUT_MS })
        if (r.code === 0) done.push(run)
      }
      if (pr && done.length) updateWatchedPr(paths, { ...pr, reruns: [...(pr.reruns ?? []), ...done.map((run) => `${v.headRefOid}:${run}`)] })
      lines.push(done.length ? `Re-running CI on ${v.url} in full: run ${done.join(", ")}.` : `GitHub refused to re-run CI on ${v.url}.`)
    }
    if (action === "retry") lines.push(...retry(paths, issue, now))
    if (action === "merge") {
      const v = await open()
      if (!v) {
        lines.push(`There is no open PR of mine for ${issue} to merge.`)
        continue
      }
      const base = v.baseRefName ?? config.repo.base
      const mode = mergeMode(readAutoMergePolicy(config.repo.path, base), config)
      if (mode === "mini-off") {
        lines.push(`I cannot merge ${v.url}: auto-merge is off on this mini (worker.autoMerge in its config.json), so a person merges it.`)
      } else if (mode === "person") {
        lines.push(`I cannot merge ${v.url}: the project's policy for ${base} leaves merging to a person.`)
      } else {
        const r = await deps.exec("gh", ["pr", "merge", v.url, "--auto", "--squash", "--delete-branch"], { cwd: config.repo.path, timeoutMs: GH_TIMEOUT_MS })
        lines.push(
          r.code === 0
            ? `Auto-merge armed on ${v.url}: it merges into ${base}${revising ? " after the revision," : ""} once the required checks and the review are green.`
            : `GitHub refused to arm auto-merge on ${v.url} (${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}).`,
        )
      }
    }
  }
  // Whatever it asked, it answers the issue's open question.
  for (const d of openDecisions(paths, issue)) closeDecision(paths, d.id, `answered by ${who}: ${actions.join(", ")}`, now)
  return lines.length ? lines : [`I read that as an instruction for ${issue}, but found nothing to do.`]
}

function lastBlocked(paths: AgentPaths, issue: string): JobRecord | null {
  const done = listJobs(paths, "done").filter((j) => j.issue === issue && j.endedAt)
  const last = done.sort((a, b) => a.endedAt!.localeCompare(b.endedAt!)).at(-1)
  return last?.result?.status === "blocked" ? last : null
}

function retry(paths: AgentPaths, issue: string, now: Date): string[] {
  const busy = busyJob(paths, issue)
  if (busy) return [`Already on it: job ${busy.id}.`]
  const blocked = lastBlocked(paths, issue)
  if (!blocked) return [`${issue}'s last job did not end blocked, so there is nothing to retry.`]
  const job = submitJob(paths, issue, blocked.model, now, { retryOf: blocked.id })
  return [`Retrying ${issue} on its branch: job ${job.id}, after ${blocked.id} ended blocked (${blocked.result?.reason ?? "no reason recorded"}).`]
}
