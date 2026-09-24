/**
 * What happens after a worker's session, per outcome (decision 2: rules in
 * code, not in the model):
 *   done         push, open or reuse the PR, arm auto-merge when the policy
 *                allows, link it, In Review, #polads-agents, remove the worktree
 *   needs_input  push what is committed, On hold + awaiting-answer, the
 *                question in the issue's Slack thread, #polads-agents
 *   blocked      push what is committed, On hold, a report comment, the reason
 *                in the issue's thread (spec 12: a person sees it there)
 *   limited      push what is committed, back to Ready still held by this mini,
 *                a comment, no Slack: the limit resets on its own
 * Local records (the watched PR, the ledger, the outbox) are written before
 * Linear is asked: when Linear is down, the Slack messages still go out and
 * the PR is still watched, and the runner reports the failed write
 * (Review Focus 5). Linear's GitHub integration would move the issue to In
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
import { truncateChars } from "../slack/text.ts"
import type { Tracker, TrackerIssue } from "../tracker.ts"
import { commitsAhead, isDirty, must, pushBranch, removeWorktree, type Exec } from "./git.ts"
import type { Outcome, WorkerReport } from "./outcome.ts"

export interface FinalizeContext {
  exec: Exec
  tracker: Tracker
  paths: AgentPaths
  config: AgentConfig
  issue: TrackerIssue
  branch: string
  /** null when the worktree was never prepared. */
  worktree: string | null
  autoMerge: boolean
  model: string
  minutes: number
  now: () => Date
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

export function prBody(
  issueId: string,
  report: WorkerReport,
  meta: { mini: string; model: string; turns: number | null; costUsd: number | null; minutes: number; dirty: boolean },
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
    "## Notes",
    notes,
    "",
    `Worker: ${meta.mini}, model ${meta.model}, ${meta.turns ?? "?"} turns, estimated ${cost}, ${meta.minutes} min.`,
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n")
}

export function blockedReport(reason: string, report: WorkerReport | null, meta: { branch: string; pushed: boolean }): string {
  return [
    `Worker stopped: ${reason}.`,
    report?.summary ? `\n${report.summary}` : "",
    meta.pushed ? `\nWork so far is on branch \`${meta.branch}\`.` : "\nNothing was committed.",
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
  writeFileSync(bodyFile, prBody(ctx.issue.id, report, { mini: config.mini, model: ctx.model, turns: outcome.turns, costUsd: outcome.costUsd, minutes: ctx.minutes, dirty }))
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

export async function finalize(ctx: FinalizeContext, outcome: Outcome): Promise<FinalizeResult> {
  const { issue, config } = ctx
  const ahead = ctx.worktree ? await commitsAhead(ctx.exec, ctx.worktree, config.repo.base) : 0
  const dirty = ctx.worktree ? await isDirty(ctx.exec, ctx.worktree) : false
  let status = outcome.status
  let reason = outcome.reason
  if (status === "done" && ahead === 0) {
    status = "blocked"
    reason = "the worker reported done but made no commits"
  }
  const pushed = ahead > 0 && ctx.worktree !== null
  if (pushed) await pushBranch(ctx.exec, ctx.worktree!, ctx.branch, issue.id)
  const post = (text: string) => enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text }, ctx.now())
  const inThread = (text: string) => enqueueSlack(ctx.paths, { kind: "issue", issue: issue.id, text, question: true }, ctx.now())

  if (status === "done") {
    const url = await openOrReusePr(ctx, outcome, dirty)
    recordPr(ctx.paths, { issue: issue.id, url, openedAt: ctx.now().toISOString() })
    appendLedger(ctx.paths, { type: "pr.opened", issue: issue.id, url }, ctx.now())
    if (ctx.autoMerge) await must(ctx.exec, "gh", ["pr", "merge", url, "--auto", "--squash", "--delete-branch"], { cwd: config.repo.path })
    post(`${issue.id} PR opened: ${url}${ctx.autoMerge ? " (auto-merge armed)" : " (a person merges this one)"}`)
    await ctx.tracker.attachLink(issue.id, url, `PR ${url.split("/").pop()}`)
    await ctx.tracker.updateIssue(issue.id, { state: "In Review" })
    if (!dirty) await removeWorktree(ctx.exec, config.repo.path, ctx.worktree!)
    return { status, reason, prUrl: url, pushed }
  }

  if (status === "needs_input") {
    inThread(outcome.report!.question!)
    post(`${issue.id} parked: waiting for an answer in its Slack thread`)
    await ctx.tracker.updateIssue(issue.id, { state: "On hold", addLabels: ["awaiting-answer"] })
    return { status, reason, prUrl: null, pushed }
  }

  if (status === "limited") {
    await ctx.tracker.updateIssue(issue.id, { state: "Ready" })
    const where = pushed ? ` Work so far is on \`${ctx.branch}\`.` : ""
    await ctx.tracker.comment(issue.id, `Paused by the subscription usage limit.${where} It stays with ${config.mini} and resumes after the limit resets.`)
    return { status, reason, prUrl: null, pushed }
  }

  inThread(`blocked: ${reason}. ${outcome.report?.summary ? `${outcome.report.summary} ` : ""}Reply here when it can continue.`)
  post(`${issue.id} blocked: ${reason}`)
  await ctx.tracker.updateIssue(issue.id, { state: "On hold" })
  await ctx.tracker.comment(issue.id, blockedReport(reason, outcome.report, { branch: ctx.branch, pushed }))
  return { status: "blocked", reason, prUrl: null, pushed }
}
