/**
 * The mini revises its own PRs (STEP-3274): agentd's PR watcher reads each
 * open PR it opened, and review feedback brings a `revise` job for its issue,
 * ahead of new work, whose worker continues the PR's branch.
 *
 * Feedback is:
 *   - a review with CHANGES_REQUESTED, by anyone but the PR's author
 *   - a failing required check whose failure is the code's (Claude review's
 *     blockers, Test, Lint, TypeScript, i18n)
 *   - a PR comment addressed to the agent: starting "@<mini>", or carrying
 *     "Review fixes requested" (the orchestrator's marker)
 * Each counts once, by its id (a check by its head commit and name).
 *
 * A failure that is not the code's (a Neon 404, ECONNRESET, a runner that
 * lost its connection, a cancelled or skipped shard) gets a full re-run of
 * its workflow run, never `--failed`: Test shards share a database branch the
 * first run tore down. Once per run and head commit. Failing again there, it
 * goes to a person, as every red check did before.
 *
 * At most MAX_REVISE_ROUNDS rounds per PR. After that it asks in
 * #polads-questions, once, and stops. Nothing here, and nothing the worker
 * may run, dismisses a person's or a bot's review.
 *
 * Neither the re-run that failed again nor the round cap is a "person needs
 * to look" (STEP-3285): each is one question with options and a default
 * (agentd/decisions.ts). A re-run's default is another re-run, which agentd
 * takes after an hour without an answer. The cap's is leaving the PR to a person.
 */

import type { AgentConfig, AgentPaths } from "../config.ts"
import { listJobs, submitJob, updateWatchedPr, type WatchedPr } from "../jobs.ts"
import { appendLedger, type Logger } from "../log.ts"
import { askDecision } from "./decisions.ts"
import { enqueueSlack } from "../outbox.ts"
import type { Exec } from "../worker/git.ts"

export const MAX_REVISE_ROUNDS = 3

export interface PrActor {
  login?: string
}

export interface PrRollupEntry {
  __typename?: string
  name?: string
  context?: string
  conclusion?: string | null
  state?: string | null
  status?: string | null
  detailsUrl?: string
  targetUrl?: string
}

/** `gh pr view --json` of the fields the watcher asks for (PR_FIELDS). */
export interface OwnPrView {
  url: string
  number: number
  state: string
  headRefName: string
  headRefOid: string
  author?: PrActor
  reviews?: Array<{ id: string; author?: PrActor; state: string; body?: string; submittedAt?: string }>
  comments?: Array<{ id: string; author?: PrActor; body?: string; createdAt?: string }>
  statusCheckRollup: PrRollupEntry[]
  autoMergeRequest?: unknown
}

export const PR_FIELDS = "url,number,state,headRefName,headRefOid,author,reviews,comments,statusCheckRollup,autoMergeRequest"

const RED = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"])
/** Conclusions that say nothing about the code. */
const NOT_THE_CODE = new Set(["CANCELLED", "TIMED_OUT", "STARTUP_FAILURE"])
/** What a failed job's log shows when the infrastructure failed, not the code. */
export const INFRA_RE =
  /\bNeon\b[^\n]{0,200}\b404\b|\b404\b[^\n]{0,200}\bNeon\b|\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|socket hang up|getaddrinfo ENOTFOUND|503 Service Unavailable|502 Bad Gateway|The runner has received a shutdown signal|lost communication with the server|The operation was canceled/i
const SHARD_RE = /\(\s*\d+\s*\/\s*\d+\s*\)|\bshard\b/i

const checkName = (c: PrRollupEntry) => c.name ?? c.context ?? ""
/** A required check's shard: "Test (3/4)" is Test's. */
const requiredBase = (name: string, required: readonly string[]) => required.find((r) => name === r || (name.startsWith(`${r} `) && SHARD_RE.test(name)))

/** The Actions run and job a check ran as, from its details URL. null for a status context or another app. */
export function actionsJob(c: PrRollupEntry): { runId: string; jobId: string } | null {
  const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(c.detailsUrl ?? c.targetUrl ?? "")
  return m ? { runId: m[1], jobId: m[2] } : null
}

export interface FailingCheck {
  name: string
  conclusion: string
  job: { runId: string; jobId: string } | null
  /** A skipped shard of a required check: CI did not run, so a re-run, not a fix. */
  skippedShard: boolean
}

/** The PR's required checks that are red at its head, and skipped required shards. */
export function failingRequired(view: OwnPrView, required: readonly string[]): FailingCheck[] {
  const out = new Map<string, FailingCheck>()
  for (const c of view.statusCheckRollup) {
    const name = checkName(c)
    const base = requiredBase(name, required)
    if (!base) continue
    const conclusion = String(c.conclusion ?? c.state ?? "").toUpperCase()
    const skippedShard = conclusion === "SKIPPED" && name !== base
    if (!RED.has(conclusion) && !skippedShard) continue
    out.set(name, { name, conclusion, job: actionsJob(c), skippedShard })
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export type RevisePlan =
  | { kind: "none" }
  | { kind: "rerun"; runs: string[] }
  | { kind: "notify"; failing: string[]; runs: string[] }
  | { kind: "revise"; handled: string[]; reasons: string[] }
  | { kind: "ask"; handled: string[]; reasons: string[] }

/**
 * What one open PR needs, from its view, the watcher's record and which
 * failing checks are the infrastructure's (`infra`, by name). Pure.
 */
export function planRevision(view: OwnPrView, pr: WatchedPr, ctx: { mini: string; required: readonly string[]; infra: Record<string, boolean> }): RevisePlan {
  const handled = new Set(pr.revise?.handled ?? [])
  const author = view.author?.login ?? ""
  const others = (who?: PrActor) => Boolean(who?.login) && who!.login !== author
  const addressed = new RegExp(`^\\s*@${ctx.mini}\\b|Review fixes requested`, "i")
  const reasons: string[] = []
  const ids: string[] = []
  for (const r of view.reviews ?? []) {
    if (r.state !== "CHANGES_REQUESTED" || !others(r.author) || handled.has(`review:${r.id}`)) continue
    ids.push(`review:${r.id}`)
    reasons.push(`changes requested by ${r.author!.login}`)
  }
  for (const c of view.comments ?? []) {
    if (!others(c.author) || !addressed.test(c.body ?? "") || handled.has(`comment:${c.id}`)) continue
    ids.push(`comment:${c.id}`)
    reasons.push(`a comment from ${c.author!.login}`)
  }
  const failing = failingRequired(view, ctx.required)
  const infraOnly: FailingCheck[] = []
  for (const f of failing) {
    if (ctx.infra[f.name]) {
      infraOnly.push(f)
      continue
    }
    const id = `check:${view.headRefOid}:${f.name}`
    if (handled.has(id)) continue
    ids.push(id)
    reasons.push(`${f.name} failed`)
  }
  if (ids.length) {
    const rounds = pr.revise?.rounds ?? 0
    if (rounds >= MAX_REVISE_ROUNDS) return pr.revise?.asked ? { kind: "none" } : { kind: "ask", handled: ids, reasons }
    return { kind: "revise", handled: ids, reasons }
  }
  if (infraOnly.length) {
    const done = new Set(pr.reruns ?? [])
    const runs = [...new Set(infraOnly.map((f) => f.job?.runId).filter((r): r is string => Boolean(r)))]
    const fresh = runs.filter((r) => !done.has(`${view.headRefOid}:${r}`))
    if (fresh.length) return { kind: "rerun", runs: fresh }
    // Re-run once at this head and still failing, or not an Actions run at all: a person looks.
    return { kind: "notify", failing: infraOnly.map((f) => f.name), runs }
  }
  return { kind: "none" }
}

export interface ReviseDeps {
  exec: Exec
  paths: AgentPaths
  config: AgentConfig
  now: () => Date
  log: Logger
}

const GH_TIMEOUT_MS = 2 * 60_000

/**
 * Which failing checks at the head failed on the infrastructure, reading each
 * failed job's log once per head (the verdicts are kept on the record).
 */
export async function classifyFailures(deps: ReviseDeps, view: OwnPrView, pr: WatchedPr, required: readonly string[]): Promise<Record<string, boolean>> {
  const kept = pr.infra ?? {}
  const verdicts: Record<string, boolean> = {}
  for (const f of failingRequired(view, required)) {
    const key = `${view.headRefOid}:${f.name}`
    if (key in kept) {
      verdicts[f.name] = kept[key]
      continue
    }
    let infra = f.skippedShard || NOT_THE_CODE.has(f.conclusion)
    if (!infra && f.job) {
      const log = await deps.exec("gh", ["run", "view", "--job", f.job.jobId, "--repo", deps.config.repo.slug, "--log-failed"], { timeoutMs: GH_TIMEOUT_MS })
      // An unreadable log proves nothing either way: the code's, as before this watcher.
      infra = log.code === 0 && INFRA_RE.test(log.stdout)
    }
    verdicts[f.name] = infra
  }
  return verdicts
}

/** One open PR of this mini's: plan, then act, and keep what it did on the record. */
export async function reviseOwnPr(deps: ReviseDeps, pr: WatchedPr, view: OwnPrView, required: readonly string[]): Promise<void> {
  const verdicts = await classifyFailures(deps, view, pr, required)
  const infra = Object.fromEntries(Object.entries(verdicts).map(([name, v]) => [`${view.headRefOid}:${name}`, v]))
  let record: WatchedPr = { ...pr, infra }
  const plan = planRevision(view, pr, { mini: deps.config.mini, required, infra: verdicts })
  const now = deps.now()
  switch (plan.kind) {
    case "none":
      break
    case "rerun": {
      const done: string[] = []
      for (const run of plan.runs) {
        // The whole run, never --failed: Test shards share a database branch the first run tore down.
        const r = await deps.exec("gh", ["run", "rerun", run, "--repo", deps.config.repo.slug], { timeoutMs: GH_TIMEOUT_MS })
        if (r.code === 0) done.push(`${view.headRefOid}:${run}`)
        else deps.log.warn("gh run rerun failed", { url: pr.url, run, stderr: r.stderr.trim() })
      }
      if (done.length) {
        appendLedger(deps.paths, { type: "pr.rerun", issue: pr.issue, url: pr.url, runs: done }, now)
        enqueueSlack(deps.paths, { kind: "post", channel: "agents", text: `${pr.issue}: CI on ${pr.url} failed on its infrastructure, not the code. Re-running it in full.` }, now)
      }
      record = { ...record, reruns: [...(pr.reruns ?? []), ...done] }
      break
    }
    case "notify": {
      const signature = `${view.headRefOid}:${plan.failing.join(",")}`
      if (pr.notified === signature) break
      askDecision(
        deps.paths,
        deps.config,
        {
          id: `infra-${pr.issue}-${view.headRefOid.slice(0, 12)}`,
          issue: pr.issue,
          url: pr.url,
          question: `CI on ${pr.url} failed on its infrastructure again after a full re-run (${plan.failing.join(", ")} on ${view.headRefOid.slice(0, 7)}), not on the code.`,
          options: [
            { reply: "re-run", does: "re-run CI in full once more" },
            { reply: "leave it", does: "leave the PR to a person" },
          ],
          defaultReply: "re-run",
          defaultAction: { kind: "rerun", runs: plan.runs },
        },
        now,
      )
      record = { ...record, notified: signature }
      break
    }
    case "ask": {
      askDecision(
        deps.paths,
        deps.config,
        {
          id: `cap-${pr.issue}-${view.number}`,
          issue: pr.issue,
          url: pr.url,
          question: `PR ${pr.url} still has review feedback after ${MAX_REVISE_ROUNDS} revise rounds (${plan.reasons.join(", ")}).`,
          options: [
            { reply: "fix it", does: "revise it once more" },
            { reply: "leave it", does: "leave it to a person" },
          ],
          defaultReply: "leave it",
          defaultAction: { kind: "leave" },
        },
        now,
      )
      record = { ...record, revise: { ...(pr.revise ?? { rounds: MAX_REVISE_ROUNDS, handled: [] }), handled: [...(pr.revise?.handled ?? []), ...plan.handled], asked: true } }
      appendLedger(deps.paths, { type: "pr.reviseCapped", issue: pr.issue, url: pr.url }, now)
      break
    }
    case "revise": {
      // One job per issue: the next watch picks this feedback up once the running one ends.
      if (["pending", "running"].some((state) => listJobs(deps.paths, state as "pending" | "running").some((j) => j.issue === pr.issue))) break
      const round = (pr.revise?.rounds ?? 0) + 1
      submitJob(deps.paths, pr.issue, null, now, {
        kind: "revise",
        revise: { url: view.url, number: view.number, branch: view.headRefName, round, since: pr.revise?.lastRoundAt ?? pr.openedAt, reasons: plan.reasons },
      })
      record = { ...record, revise: { rounds: round, handled: [...(pr.revise?.handled ?? []), ...plan.handled], lastRoundAt: now.toISOString() } }
      appendLedger(deps.paths, { type: "pr.revise", issue: pr.issue, url: pr.url, round, reasons: plan.reasons }, now)
      enqueueSlack(deps.paths, { kind: "post", channel: "agents", text: `${pr.issue} revising ${pr.url} (round ${round} of ${MAX_REVISE_ROUNDS}): ${plan.reasons.join(", ")}` }, now)
      break
    }
  }
  updateWatchedPr(deps.paths, record)
}
