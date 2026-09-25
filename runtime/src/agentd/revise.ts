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
 *     "Review fixes requested" (the orchestrator's marker), by a member,
 *     owner or collaborator of the repository, and never by a [bot] account
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
import { feedbackFor, NOTHING_NEEDED, prLink } from "../plain.ts"
import { approvalLabel, approvalPatch, classOfLabels, classRank, type ApprovalClass, type Tracker } from "../tracker.ts"
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
  comments?: Array<{ id: string; author?: PrActor; authorAssociation?: string; body?: string; createdAt?: string }>
  statusCheckRollup: PrRollupEntry[]
  autoMergeRequest?: unknown
  /** The PR's labels: the Approval class check puts the diff's class there (approval/<class>). */
  labels?: Array<{ name: string }>
}

export const PR_FIELDS = "url,number,state,headRefName,headRefOid,author,reviews,comments,statusCheckRollup,autoMergeRequest,labels"

/**
 * The PolAds check that sets a PR's approval class from its diff (WS1). Its
 * failure is never the code's: the issue's label is lower than the diff's
 * floor. agentd raises the label and re-runs the check, and no worker is sent.
 */
export const APPROVAL_CHECK = "Approval class"
/** The check's job that puts the diff's class on the PR as a label (approval/<class>). */
export const APPROVAL_LABEL_CHECK = "Approval class label"

const RED = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE"])
/** Conclusions that say nothing about the code. */
const NOT_THE_CODE = new Set(["CANCELLED", "TIMED_OUT", "STARTUP_FAILURE"])
/** What a failed job's log shows when the infrastructure failed, not the code. */
export const INFRA_RE =
  /\bNeon\b[^\n]{0,200}\b404\b|\b404\b[^\n]{0,200}\bNeon\b|\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|socket hang up|getaddrinfo ENOTFOUND|503 Service Unavailable|502 Bad Gateway|The runner has received a shutdown signal|lost communication with the server|The operation was canceled/i
const SHARD_RE = /\(\s*\d+\s*\/\s*\d+\s*\)|\bshard\b/i

const checkName = (c: PrRollupEntry) => c.name ?? c.context ?? ""

/**
 * Who may ask the agent for a change in a PR comment: someone with a hand in
 * the repository (GitHub's author association), never a bot account. A
 * comment is a way in for anyone who can comment, so it must come from someone
 * the org trusts to change the code anyway.
 *
 * gh's `--json comments` gives a bot its bare login ("claude", "vercel") with
 * the association NONE, so the association is what stops them there. The
 * "[bot]" suffix is the REST API's spelling of the same accounts.
 */
const TRUSTED_ASSOCIATIONS = new Set(["MEMBER", "OWNER", "COLLABORATOR"])
function trustedCommenter(c: { author?: PrActor; authorAssociation?: string }): boolean {
  const login = c.author?.login ?? ""
  return TRUSTED_ASSOCIATIONS.has(String(c.authorAssociation ?? "").toUpperCase()) && !/\[bot\]$/i.test(login)
}

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
    if (name === APPROVAL_CHECK) continue
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
    if (!others(c.author) || !trustedCommenter(c) || !addressed.test(c.body ?? "") || handled.has(`comment:${c.id}`)) continue
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
  /** Linear, to raise an issue's approval class the Approval class check found too low. Without it, the class is left as it is. */
  tracker?: Pick<Tracker, "readIssue" | "updateIssue">
}

const GH_TIMEOUT_MS = 2 * 60_000

const conclusionOf = (c: PrRollupEntry) => String(c.conclusion || c.state || "").toUpperCase()
/** No verdict yet: queued or still running. */
const UNDECIDED = new Set(["", "PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"])

/**
 * Where the Approval class check stands at the head. Only red is acted on,
 * and nothing else marks the head done, so a check still running, or not
 * there yet, that goes red later at the same head is still seen.
 */
export function approvalCheckAt(view: OwnPrView): "none" | "running" | "green" | "red" {
  const check = view.statusCheckRollup.find((c) => checkName(c) === APPROVAL_CHECK)
  if (!check) return "none"
  const conclusion = conclusionOf(check)
  if (UNDECIDED.has(conclusion)) return "running"
  return RED.has(conclusion) ? "red" : "green"
}

/**
 * Whether the PR's class label is this head's: the label job passed at this
 * head. Skipped or still running, the label may be an older head's, and a
 * person may have lowered the class since.
 */
export function labelledAtHead(view: OwnPrView): boolean {
  return view.statusCheckRollup.some((c) => checkName(c) === APPROVAL_LABEL_CHECK && conclusionOf(c) === "SUCCESS")
}

/**
 * When the Approval class check is red at the head and this head's label job
 * has labelled the PR with a class above the issue's: the class to raise the
 * issue to, and the Actions run to start again once it is. Pure. null:
 * nothing to raise.
 */
export function classRaise(view: OwnPrView, issueLabels: readonly string[]): { to: ApprovalClass; runId: string | null } | null {
  const check = view.statusCheckRollup.find((c) => checkName(c) === APPROVAL_CHECK)
  if (!check || approvalCheckAt(view) !== "red" || !labelledAtHead(view)) return null
  const floor = classOfLabels((view.labels ?? []).map((l) => l.name))
  if (!floor) return null
  const current = classOfLabels(issueLabels)
  if (current && classRank(current) >= classRank(floor)) return null
  return { to: floor, runId: actionsJob(check)?.runId ?? null }
}

const NEEDS: Record<ApprovalClass, string> = {
  auto: "approval by the agents",
  look: "a visual check by a person before release",
  try: "a hands-on test by a person before release",
}

async function rerunCheck(deps: ReviseDeps, pr: WatchedPr, runId: string | null): Promise<void> {
  if (!runId) return
  const r = await deps.exec("gh", ["run", "rerun", runId, "--repo", deps.config.repo.slug], { timeoutMs: GH_TIMEOUT_MS })
  if (r.code !== 0) deps.log.warn("gh run rerun failed", { url: pr.url, run: runId, stderr: r.stderr.trim() })
}

/**
 * Raises the issue's class to what the check found, once per head. It waits,
 * marking nothing, while the check is not there yet or still running, and
 * while this head's label job has not labelled the PR. Never throws: a
 * failure is logged and tried again at the next watch.
 */
async function raiseClass(deps: ReviseDeps, pr: WatchedPr, view: OwnPrView): Promise<WatchedPr> {
  const head = view.headRefOid
  if (!deps.tracker || pr.classRaised === head) return pr
  if (approvalCheckAt(view) !== "red" || !labelledAtHead(view)) return pr
  const check = view.statusCheckRollup.find((c) => checkName(c) === APPROVAL_CHECK)
  const runId = check ? (actionsJob(check)?.runId ?? null) : null
  try {
    const issue = await deps.tracker.readIssue(pr.issue)
    const raise = classRaise(view, issue.labels)
    if (!raise) return await nothingToRaise(deps, pr, head, runId)
    const had = classOfLabels(issue.labels)
    await deps.tracker.updateIssue(pr.issue, approvalPatch(issue.labels, { addLabels: [approvalLabel(raise.to)] }))
    await rerunCheck(deps, pr, raise.runId)
    appendLedger(deps.paths, { type: "class.raised", issue: pr.issue, url: pr.url, to: raise.to }, deps.now())
    enqueueSlack(
      deps.paths,
      { kind: "post", channel: "agents", text: `${pr.issue}: the change in ${prLink(pr.url)} needs ${NEEDS[raise.to]}, so I ${had ? "raised" : "set"} ${pr.issue}'s approval level to match. ${NOTHING_NEEDED}` },
      deps.now(),
    )
    return { ...pr, classRaised: head }
  } catch (error) {
    deps.log.warn("could not raise the approval class", { url: pr.url, error: error instanceof Error ? error.message : String(error) })
    return pr
  }
}

/**
 * Red, and the issue's class is already where this head's label puts it. The
 * check reads Linear when it runs, so it may have run before the class
 * changed: start it once more at this head. Still red after that, ask a
 * person once, as a failure the infrastructure keeps causing does.
 */
async function nothingToRaise(deps: ReviseDeps, pr: WatchedPr, head: string, runId: string | null): Promise<WatchedPr> {
  if (pr.classRerun !== head) {
    await rerunCheck(deps, pr, runId)
    return { ...pr, classRerun: head }
  }
  askDecision(
    deps.paths,
    deps.config,
    {
      id: `class-${pr.issue}-${head.slice(0, 12)}`,
      issue: pr.issue,
      url: pr.url,
      question: `The approval check on ${prLink(pr.url)} is still red after I started it again, and ${pr.issue} already has the approval level the change needs, so I have nothing to raise. A person needs to see why: the check's summary says what it found.`,
      options: [{ reply: "leave it", does: "leave the PR to a person" }],
      defaultReply: "leave it",
      defaultAction: { kind: "leave" },
    },
    deps.now(),
  )
  appendLedger(deps.paths, { type: "class.stuck", issue: pr.issue, url: pr.url }, deps.now())
  return { ...pr, classRaised: head }
}

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
  let record: WatchedPr = { ...(await raiseClass(deps, pr, view)), infra }
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
        enqueueSlack(
          deps.paths,
          { kind: "post", channel: "agents", text: `${pr.issue}: the automatic checks on ${prLink(pr.url)} failed for a reason that has nothing to do with the code, so I started them again. ${NOTHING_NEEDED}` },
          now,
        )
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
          question: `The automatic checks on ${prLink(pr.url)} failed again for a reason that has nothing to do with the code (${plan.failing.join(", ")} on ${view.headRefOid.slice(0, 7)}), even after I started them again.`,
          options: [
            { reply: "re-run", does: "have me start them once more" },
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
          question: `${prLink(pr.url)} still has review feedback after I worked on it ${MAX_REVISE_ROUNDS} times (${plan.reasons.join(", ")}).`,
          options: [
            { reply: "fix it", does: "have me try once more" },
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
      enqueueSlack(
        deps.paths,
        { kind: "post", channel: "agents", text: `${pr.issue}: I am fixing ${feedbackFor(plan.reasons)} on ${prLink(pr.url)} (${plan.reasons.join(", ")}), try ${round} of ${MAX_REVISE_ROUNDS}. ${NOTHING_NEEDED}` },
        now,
      )
      break
    }
  }
  updateWatchedPr(deps.paths, record)
}
