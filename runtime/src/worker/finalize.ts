/**
 * What happens after a worker's session, per outcome (decision 2: rules in
 * code, not in the model):
 *   done         push, open or reuse the PR, arm auto-merge when the policy
 *                and the mini allow it, link it, In Review, #polads-agents,
 *                remove the worktree
 *   needs_input  push what is committed, On hold + awaiting-answer, the
 *                question in the issue's Slack thread, #polads-agents
 *   blocked      push what is committed, On hold, a report comment, the reason
 *                in the issue's thread (spec 12: a person sees it there)
 *   limited      push what is committed, back to Ready still held by this mini,
 *                a comment, no Slack: the limit resets on its own
 * Local records (the watched PR, the ledger, the outbox) are written before
 * Linear is asked: when Linear is down, the Slack messages still go out and
 * the PR is still watched, and the runner reports the failed write
 * (Review Focus 5) with the branch it pushed and the PR it opened
 * (FinalizeFailed). Linear's GitHub integration would move the issue to In
 * Review on its own; setting it here as well means the 6-hour sweeper never
 * mistakes a finished job for a dead claim. Nothing here writes an issue's
 * description, so the answers the bridge appended to it stay as they are.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { recordPr } from "../jobs.ts"
import { appendLedger } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import { askWithRecommendation, NOTHING_NEEDED, plainReason, prLink } from "../plain.ts"
import { truncateChars } from "../slack/text.ts"
import type { Tracker, TrackerIssue } from "../tracker.ts"
import { commitsAhead, conflictMarkers, isDirty, leftoverMarkers, must, pushBranch, removeWorktree, type Exec } from "./git.ts"
import { CHECKLIST, checklistGaps, clause, type Outcome, type WorkerReport } from "./outcome.ts"
import { blockedPing, ping } from "../notify.ts"

/**
 * Who merges the PR. auto: auto-merge is armed, as the project's policy
 * allows. person: the policy leaves it to a person. mini-off: the policy
 * allows it, but this mini's worker.autoMerge is false (a supervised phase).
 * deferred: the policy and the mini allow auto-merge, and the browser test
 * arms it once it passes (worker/usertest-step.ts).
 */
export type MergeMode = "auto" | "person" | "mini-off" | "deferred"

export const MINI_OFF = "auto-merge off on this mini: a person merges"

export interface FinalizeContext {
  exec: Exec
  tracker: Tracker
  paths: AgentPaths
  config: AgentConfig
  issue: TrackerIssue
  branch: string
  /** null when the worktree was never prepared. */
  worktree: string | null
  merge: MergeMode
  model: string
  minutes: number
  now: () => Date
  /** The job: its blocked ending calls the people, once (spec 6). */
  jobId?: string
}

export interface FinalizeResult {
  status: "done" | "needs_input" | "blocked" | "limited"
  reason: string
  prUrl: string | null
  pushed: boolean
}

export function prTitle(issueId: string, report: WorkerReport, fallback: string): string {
  const subject = (report.prTitle || fallback).replace(/\s+/g, " ").trim()
  return truncateChars(`${issueId}: ${subject}`, 120)
}

/**
 * The worker's self-check, as the PR and a revise reply show it (STEP-3284):
 * the one-hop sweep's answers, what it left unanswered, and each mutation check.
 */
export function selfCheckSections(report: WorkerReport): string[] {
  const gaps = checklistGaps(report)
  const answers = CHECKLIST.filter((item) => report.checklist?.[item.key]).map((item) => `- ${item.label}: ${report.checklist![item.key]}`)
  const mutations = report.mutations?.length
    ? report.mutations.map((m) => `- \`${m.test}\`: ${m.mutation}. It failed: ${clause(m.result)}. Reverted.`)
    : ["- None listed."]
  return [
    "## Sweep checklist",
    ...answers,
    ...(gaps.length ? [`Not answered by the worker: ${gaps.join(", ")}. A reviewer should check these.`] : []),
    "",
    "## Mutation checks",
    ...mutations,
  ]
}

export function prBody(
  issueId: string,
  report: WorkerReport,
  meta: { mini: string; model: string; turns: number | null; costUsd: number | null; minutes: number; dirty: boolean; merge: MergeMode },
): string {
  const checks = report.verification?.length ? report.verification.map((v) => `- ${v}`).join("\n") : "- (the worker listed none)"
  const notes = [report.notes || "None.", meta.dirty ? "The worker left uncommitted changes, which are not in this PR." : ""].filter(Boolean).join("\n")
  const cost = meta.costUsd === null ? "unknown" : `USD ${meta.costUsd.toFixed(2)}`
  return [
    issueId, // line one: what the Task trace check reads
    "",
    "## What changed",
    report.summary,
    "",
    "## How it was checked",
    checks,
    "Everything else runs in CI.",
    "",
    ...selfCheckSections(report),
    "",
    "## Notes",
    notes,
    "",
    `Worker: ${meta.mini}, model ${meta.model}, ${meta.turns ?? "?"} turns, estimated ${cost}, ${meta.minutes} min.`,
    ...(meta.merge === "mini-off" ? [`${MINI_OFF[0].toUpperCase()}${MINI_OFF.slice(1)}.`] : []),
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n")
}

/** The worker's summary past the reason: its first line is the reason itself when the worker reported blocked. */
function beyondReason(reason: string, summary: string | undefined): string {
  const lines = (summary ?? "").trim().split("\n")
  if (clause(lines[0]) === clause(reason)) lines.shift()
  return lines.join("\n").trim()
}

export function blockedReport(reason: string, report: WorkerReport | null, meta: { branch: string; pushed: boolean }): string {
  const more = beyondReason(reason, report?.summary)
  return [
    `Worker stopped: ${clause(reason)}.`,
    more ? `\n${more}` : "",
    meta.pushed ? `\nWork so far is on branch \`${meta.branch}\`.` : "\nNothing new was pushed.",
    "\nThe issue is On hold. A reply in its Slack thread puts it back in the queue.",
  ].join("")
}

/** gh runs in the main checkout: with --repo it needs no worktree, and never reads one the worker wrote. */
async function openOrReusePr(ctx: FinalizeContext, outcome: Outcome, dirty: boolean): Promise<string> {
  const { config } = ctx
  const open = await ctx.exec(
    "gh",
    ["pr", "list", "--repo", config.repo.slug, "--head", ctx.branch, "--state", "open", "--json", "url", "--jq", ".[0].url // empty"],
    { cwd: config.repo.path },
  )
  const existing = open.stdout.trim()
  if (open.code === 0 && existing.startsWith("https://")) return existing
  const report = outcome.report!
  mkdirSync(ctx.paths.state, { recursive: true })
  const bodyFile = join(ctx.paths.state, `pr-body-${ctx.issue.id}.md`)
  writeFileSync(bodyFile, prBody(ctx.issue.id, report, { mini: config.mini, model: ctx.model, turns: outcome.turns, costUsd: outcome.costUsd, minutes: ctx.minutes, dirty, merge: ctx.merge }))
  const out = await must(
    ctx.exec,
    "gh",
    ["pr", "create", "--repo", config.repo.slug, "--base", config.repo.base, "--head", ctx.branch, "--title", prTitle(ctx.issue.id, report, ctx.issue.title), "--body-file", bodyFile],
    { cwd: config.repo.path },
  )
  const url = out.split("\n").map((l) => l.trim()).reverse().find((l) => l.startsWith("https://"))
  if (!url) throw new Error(`gh pr create printed no URL: ${out.slice(0, 200)}`)
  return url
}

/** A finish that failed part way. It carries what had already happened, so the job's result still names the pushed branch and the open PR. */
export class FinalizeFailed extends Error {
  constructor(
    message: string,
    readonly pushed: boolean,
    readonly prUrl: string | null,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export async function finalize(ctx: FinalizeContext, outcome: Outcome): Promise<FinalizeResult> {
  const progress: { pushed: boolean; prUrl: string | null } = { pushed: false, prUrl: null }
  try {
    return await settle(ctx, outcome, progress)
  } catch (error) {
    throw new FinalizeFailed(error instanceof Error ? error.message : String(error), progress.pushed, progress.prUrl, { cause: error })
  }
}

async function settle(ctx: FinalizeContext, outcome: Outcome, progress: { pushed: boolean; prUrl: string | null }): Promise<FinalizeResult> {
  const { issue, config } = ctx
  const ahead = ctx.worktree ? await commitsAhead(ctx.exec, ctx.worktree, config.repo.base) : 0
  const dirty = ctx.worktree ? await isDirty(ctx.exec, ctx.worktree) : false
  let status = outcome.status
  let reason = outcome.reason
  if (status === "done" && ahead === 0) {
    status = "blocked"
    reason = "the worker reported done but made no commits"
  }
  // Commits that leave a conflict marker never go out (STEP-3340): a Markdown or YAML file passes CI with one.
  const markers = ahead > 0 && ctx.worktree ? await conflictMarkers(ctx.exec, ctx.worktree, [`origin/${config.repo.base}`]) : []
  if (markers.length) {
    status = "blocked"
    reason = leftoverMarkers(markers)
  }
  const pushed = ahead > 0 && ctx.worktree !== null && !markers.length
  if (pushed) {
    await pushBranch(ctx.exec, ctx.worktree!, ctx.branch, issue.id)
    progress.pushed = true
  }
  const post = (text: string) => enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text }, ctx.now())
  const inThread = (text: string) => enqueueSlack(ctx.paths, { kind: "issue", issue: issue.id, text, question: true }, ctx.now())

  if (status === "done") {
    const url = await openOrReusePr(ctx, outcome, dirty)
    progress.prUrl = url
    recordPr(ctx.paths, { issue: issue.id, url, openedAt: ctx.now().toISOString() })
    appendLedger(ctx.paths, { type: "pr.opened", issue: issue.id, url }, ctx.now())
    if (ctx.merge === "auto") await must(ctx.exec, "gh", ["pr", "merge", url, "--auto", "--squash", "--delete-branch"], { cwd: config.repo.path })
    // In plain words (../plain.ts): what happened, and whether anyone needs to act.
    const who = {
      auto: `It goes in by itself once the checks and the review pass. ${NOTHING_NEEDED}`,
      deferred: `It goes in by itself once I have tried it in a browser and the checks and the review pass. ${NOTHING_NEEDED}`,
      person: "A person needs to merge it once the checks pass.",
      "mini-off": "Auto-merge is off on this mini, so a person needs to merge it once the checks pass.",
    }[ctx.merge]
    post(`${issue.id}: I opened ${prLink(url)} for "${issue.title}". ${who}`)
    await ctx.tracker.attachLink(issue.id, url, `PR ${url.split("/").pop()}`)
    await ctx.tracker.updateIssue(issue.id, { state: "In Review" })
    if (!dirty) await removeWorktree(ctx.exec, config.repo.path, ctx.worktree!)
    return { status, reason, prUrl: url, pushed }
  }

  if (status === "needs_input") {
    // The question first, as a local write. Should the park then fail, the
    // runner reports it, and the answer still reaches the issue: the front
    // door records it (agentctl decide) whatever the state.
    inThread(askWithRecommendation(outcome.report!.question!, outcome.report!.recommendation))
    post(`${issue.id}: I have a question before I can go on. It is in the issue's thread: please answer there.`)
    await ctx.tracker.updateIssue(issue.id, { state: "On hold", addLabels: ["awaiting-answer"] })
    return { status, reason, prUrl: null, pushed }
  }

  if (status === "limited") {
    await ctx.tracker.updateIssue(issue.id, { state: "Ready" })
    const where = pushed ? ` Work so far is on \`${ctx.branch}\`.` : ""
    await ctx.tracker.comment(issue.id, `Paused by the subscription usage limit.${where} It stays with ${config.mini} and resumes after the limit resets.`)
    return { status, reason, prUrl: null, pushed }
  }

  const more = beyondReason(reason, outcome.report?.summary)
  const why = plainReason(reason)
  inThread(`I had to stop work on ${issue.id}: ${why}. ${more ? `${more} ` : ""}Reply "retry" when it can go on, and I will pick it up where I left off.`)
  // The people are called to it, once per job (spec 6). A ping that cannot be written never stops the ending.
  if (ctx.jobId) {
    try {
      ping(ctx.paths, ctx.config, blockedPing(ctx.jobId, issue.id, null), ctx.now())
    } catch {
      // The question stands in the thread without it.
    }
  }
  post(`${issue.id}: I had to stop: ${why}. I asked in the issue's thread what to do.`)
  await ctx.tracker.updateIssue(issue.id, { state: "On hold" })
  await ctx.tracker.comment(issue.id, blockedReport(reason, outcome.report, { branch: ctx.branch, pushed }))
  return { status: "blocked", reason, prUrl: null, pushed }
}
