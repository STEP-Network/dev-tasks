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
 * MAX_REVISE_ROUNDS rounds per PR. Past them (STEP-3366), another round
 * goes only while something still blocks (the Claude review's BLOCKERs, or
 * another required check the code failed; never IMPROVEMENT or POLISH alone,
 * nor the review check red with no verdict) and no earlier round had those
 * blockers, up to MAX_TOTAL_REVISE_ROUNDS in all, and not while usage holds
 * new work back. Otherwise it asks in #polads-questions, once per head,
 * saying which stopped it. Nothing here, and nothing the worker may run,
 * dismisses a person's or a bot's review.
 *
 * A PR git cannot merge into its base (STEP-3340) comes back too, once per
 * head: its worker merges the base in (never a rebase, never forced) and
 * resolves each conflict. Feedback at the same head rides along in its round.
 * A round with only the conflict counts against MAX_CONFLICT_ROUNDS, its own
 * cap, so a base that keeps moving never uses up the review rounds. At that
 * cap it asks, once per head.
 *
 * Neither the re-run that failed again nor the round cap is a "person needs
 * to look" (STEP-3285): each is one question with options and a default
 * (agentd/decisions.ts). A re-run's default is another re-run, which agentd
 * takes after an hour without an answer. The cap's is leaving the PR to a person.
 */

import type { AgentConfig, AgentPaths } from "../config.ts"
import { conflictReason, isConflictOnly, isConflictReason, listJobs, submitJob, updateWatchedPr, type WatchedPr } from "../jobs.ts"
import { appendLedger, type Logger } from "../log.ts"
import { askDecision } from "./decisions.ts"
import { enqueueSlack } from "../outbox.ts"
import { feedbackFor, NOTHING_NEEDED, prLink } from "../plain.ts"
import { approvalLabel, approvalPatch, classOfLabels, classRank, type ApprovalClass, type Tracker } from "../tracker.ts"
import type { Exec } from "../worker/git.ts"
import { developBlockedByUsage, readUsage } from "../usage.ts"
import { BROWSER_TEST_REASON, readUserTestState, type UserTestState } from "../usertest/state.ts"

export const MAX_REVISE_ROUNDS = 3
export const MAX_CONFLICT_ROUNDS = 3
/** Past MAX_REVISE_ROUNDS, rounds go on only while the blockers change, and never past this many in all. */
export const MAX_TOTAL_REVISE_ROUNDS = 10

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
  baseRefName?: string
  /** MERGEABLE, CONFLICTING, or UNKNOWN while GitHub works it out: it does so lazily, after a read asks. */
  mergeable?: string
  /** DIRTY when the merge commit cannot be made: a conflict, as mergeable says. */
  mergeStateStatus?: string
}

export const PR_FIELDS = "url,number,state,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,author,reviews,comments,statusCheckRollup,autoMergeRequest,labels"

/**
 * Why the PR is back when git cannot merge it into the mini's base, or null.
 * UNKNOWN is no conflict yet: the next watch reads it again. A PR against
 * another base is a person's to merge: the worker has only the mini's base.
 */
export function conflictWith(view: Pick<OwnPrView, "baseRefName" | "mergeable" | "mergeStateStatus">, base: string): string | null {
  if (view.mergeable !== "CONFLICTING" && view.mergeStateStatus !== "DIRTY") return null
  if (view.baseRefName && view.baseRefName !== base) return null
  return conflictReason(base)
}

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

/** The check the Claude review runs as. Its verdict is a PR comment, whose BLOCKERs say more than the check's red. */
export const REVIEW_CHECK = "Claude review"
/** Two blockers in one file within this many lines are one: the fix moves the code a little (a blocker at :70 comes back at :69). */
const LINE_DRIFT = 15

const REVIEWER_RE = /^claude(\[bot\])?$/i
const REVIEW_RE = /^\s*##\s*Claude review\b/
/** Where a BLOCKER section starts: a heading, or a line that is only the bold word. "**No BLOCKERs found.**" is neither. */
const BLOCKER_START_RE = /^(#{1,6}\s*[^\w\s]*\s*BLOCKERS?\b|\*\*BLOCKERS?\*\*:?\s*$)/
/**
 * Where it ends: the next heading, or IMPROVEMENT, POLISH or NIT opening a
 * line, bold or not, or a list item. A finding may be a whole bold line, so
 * bold alone ends nothing.
 */
const SECTION_END_RE = /^(#{1,6}\s|([-*]\s|\d+\.\s)?(\*\*)?(IMPROVEMENTS?|POLISH|NITS?)\b)/
/** A finding: a top-level list item, or a paragraph that opens in bold. */
const FINDING_RE = /^([-*]\s|\d+\.\s|\*\*)/
/** A bold label inside a finding ("**Suggested fix**:", "**Why:**"), not a finding of its own. */
const LABEL_RE = /^\*\*[^*]{1,40}(:\*\*|\*\*:)/
/** A backticked file, and the first line of its range: `lib/x.ts:146-163`. */
const FILE_RE = /`([^`\s:]+\.[A-Za-z0-9]{1,5})(?::(\d+)(?:[-–]\d+)?)?`/

/**
 * The BLOCKER findings of the Claude review's latest verdict posted after
 * `since` (the last round's start: a verdict before it is the previous
 * head's), each by its file and first line, or, one that names no file, by
 * its first words. [] for a verdict without BLOCKERs, null when there is none
 * since. Pure.
 */
export function reviewBlockers(view: Pick<OwnPrView, "comments">, since: string | null): string[] | null {
  const after = since ? Date.parse(since) : Number.NEGATIVE_INFINITY
  const verdict = (view.comments ?? [])
    .filter((c) => REVIEWER_RE.test(c.author?.login ?? "") && REVIEW_RE.test(c.body ?? "") && Date.parse(c.createdAt ?? "") > after)
    .sort((a, b) => Date.parse(a.createdAt ?? "") - Date.parse(b.createdAt ?? ""))
    .at(-1)
  if (!verdict) return null
  const found: string[] = []
  let inBlockers = false
  let inCode = false
  for (const line of (verdict.body ?? "").split("\n")) {
    // A code block's lines are code, whatever they look like.
    const fence = /^\s*```/.test(line)
    if (fence) inCode = !inCode
    if (inCode || fence) continue
    const start = BLOCKER_START_RE.test(line)
    if (start) inBlockers = true
    else if (SECTION_END_RE.test(line)) inBlockers = false
    if (!inBlockers || !(start || FINDING_RE.test(line))) continue
    const file = FILE_RE.exec(line)
    if (file) found.push(file[2] ? `${file[1]}:${file[2]}` : file[1])
    else if (!start && !LABEL_RE.test(line)) found.push(`text:${line.replace(/^([-*]\s|\d+\.\s)/, "").replace(/[*`_]/g, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 60)}`)
  }
  return found
}

/**
 * What still blocks the PR at its head: the review's BLOCKERs since `since`,
 * and `check:<name>` for each other required check the code failed
 * (`failed`, by name, shards as one). Never the review's own check: red
 * without a verdict says nothing about what blocks. Pure.
 */
export function blockerFingerprint(view: Pick<OwnPrView, "comments">, failed: readonly string[], since: string | null): string[] {
  const checks = [...new Set(failed.map((name) => name.replace(/\s*\(\s*\d+\s*\/\s*\d+\s*\)\s*$/, "")))]
  return [...(reviewBlockers(view, since) ?? []), ...checks.filter((name) => name !== REVIEW_CHECK).map((name) => `check:${name}`)]
}

/** Checks and file-less findings, to match exactly, and each file's lines, in order. */
function byFile(list: readonly string[]): { exact: string[]; lines: Map<string, number[]> } {
  const exact: string[] = []
  const lines = new Map<string, number[]>()
  for (const b of list) {
    const at = /^(check|text):/.test(b) ? null : /^(.+):(\d+)$/.exec(b)
    if (at) lines.set(at[1], [...(lines.get(at[1]) ?? []), Number(at[2])])
    else exact.push(b)
  }
  for (const ns of lines.values()) ns.sort((x, y) => x - y)
  return { exact: exact.sort(), lines }
}

/**
 * The same blockers: as many, the same checks and file-less findings, and in
 * each file as many lines, paired in order, each within LINE_DRIFT. None is
 * never the same: nothing blocks. Pure.
 */
export function sameBlockers(a: readonly string[], b: readonly string[]): boolean {
  if (!a.length || a.length !== b.length) return false
  const [x, y] = [byFile(a), byFile(b)]
  // As many in all and the same exact ones: files matched line for line leave none over.
  if (x.exact.join("\n") !== y.exact.join("\n")) return false
  for (const [file, xs] of x.lines) {
    const ys = y.lines.get(file)
    if (!ys || ys.length !== xs.length || xs.some((n, i) => Math.abs(n - ys[i]) > LINE_DRIFT)) return false
  }
  return true
}

/**
 * Why a round past the cap is not sent: nothing blocks, the review check is
 * red with no verdict, 10 rounds, usage, or blockers an earlier round had.
 */
export type CapStop = "cap" | "no-verdict" | "runaway" | "usage" | "no-progress"

export type RevisePlan =
  | { kind: "none" }
  | { kind: "rerun"; runs: string[] }
  | { kind: "notify"; failing: string[]; runs: string[] }
  | { kind: "revise"; handled: string[]; reasons: string[]; blockers?: string[] }
  | { kind: "ask"; handled: string[]; reasons: string[]; why?: CapStop }

/**
 * What one open PR needs, from its view, the watcher's record and which
 * failing checks are the infrastructure's (`infra`, by name). Pure.
 */
export function planRevision(
  view: OwnPrView,
  pr: WatchedPr,
  ctx: { mini: string; required: readonly string[]; infra: Record<string, boolean>; usertest?: UserTestState | null; base?: string; usageBlocked?: string | null },
): RevisePlan {
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
  // This mini's own browser test of the PR's head (WS5): its blockers and major findings.
  const ut = ctx.usertest
  if (ut && ut.verdict === "findings" && ut.head === view.headRefOid && !handled.has(`usertest:${ut.head}`)) {
    ids.push(`usertest:${ut.head}`)
    reasons.push(BROWSER_TEST_REASON)
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
  const conflictId = `conflict:${view.headRefOid}`
  const conflict = handled.has(conflictId) ? null : conflictWith(view, ctx.base ?? view.baseRefName ?? "its base")
  // Only the conflict: a round under its own cap. Before any re-run, as a PR that conflicts gets no new CI.
  const conflictPlan = (reason: string): RevisePlan =>
    (pr.revise?.conflictRounds ?? 0) >= MAX_CONFLICT_ROUNDS
      ? { kind: "ask", handled: [conflictId], reasons: [reason] }
      : { kind: "revise", handled: [conflictId], reasons: [reason] }
  if (ids.length) {
    const rounds = pr.revise?.rounds ?? 0
    // Asked once per head: feedback on a head nobody was asked about asks again.
    const askedHere = pr.revise?.asked && (pr.revise.askedHead === undefined || pr.revise.askedHead === view.headRefOid)
    // Each round keeps what blocked it, so a round past the cap can tell whether the rounds get anywhere.
    const since = pr.revise?.lastRoundAt ?? null
    const codeFailed = failing.filter((f) => !ctx.infra[f.name]).map((f) => f.name)
    const blockers = blockerFingerprint(view, codeFailed, since)
    const revise: RevisePlan = {
      kind: "revise",
      ...(conflict ? { handled: [...ids, conflictId], reasons: [...reasons, conflict] } : { handled: ids, reasons }),
      ...(blockers.length ? { blockers } : {}),
    }
    if (rounds < MAX_REVISE_ROUNDS) return revise
    // The feedback waits for a person's answer. The conflict need not.
    if (askedHere) return conflict ? conflictPlan(conflict) : { kind: "none" }
    const noVerdict = codeFailed.includes(REVIEW_CHECK) && reviewBlockers(view, since) === null
    const why = pastCapStop(rounds, blockers, pr.revise?.blockerHistory ?? [], ctx.usageBlocked, noVerdict)
    return why ? { kind: "ask", handled: ids, reasons, why } : revise
  }
  if (conflict) return conflictPlan(conflict)
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

/**
 * Why no round goes past the cap, or null: one goes while something still
 * blocks (IMPROVEMENT and POLISH do not, nor a person's comment alone, nor the
 * review check red with no verdict), under MAX_TOTAL_REVISE_ROUNDS, while
 * usage allows new work, and only for blockers no earlier round had, so rounds
 * going in circles (A, B, A) stop too. A record from before blockers were
 * kept has none to compare, so its first round past the cap goes.
 */
function pastCapStop(rounds: number, blockers: readonly string[], history: readonly string[][], usage: string | null | undefined, noVerdict: boolean): CapStop | null {
  if (!blockers.length) return noVerdict ? "no-verdict" : "cap"
  if (rounds >= MAX_TOTAL_REVISE_ROUNDS) return "runaway"
  if (usage) return "usage"
  if (history.some((earlier) => sameBlockers(blockers, earlier))) return "no-progress"
  return null
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
 * Where this head's label job stands: not there, still running, passed (the
 * PR's class label is this head's), or finished without a class, as when
 * the check could not read Linear and skipped it. Only a pass makes the label
 * this head's: otherwise it may be an older head's, and a person may have
 * lowered the class since.
 */
export function labelJobAt(view: OwnPrView): "none" | "running" | "passed" | "without" {
  const job = view.statusCheckRollup.find((c) => checkName(c) === APPROVAL_LABEL_CHECK)
  if (!job) return "none"
  const conclusion = conclusionOf(job)
  if (UNDECIDED.has(conclusion)) return "running"
  return conclusion === "SUCCESS" ? "passed" : "without"
}

export const labelledAtHead = (view: OwnPrView): boolean => labelJobAt(view) === "passed"

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
 * while this head's label job is not there or still running. Never throws: a
 * failure is logged and tried again at the next watch.
 */
async function raiseClass(deps: ReviseDeps, pr: WatchedPr, view: OwnPrView): Promise<WatchedPr> {
  const head = view.headRefOid
  if (!deps.tracker || pr.classRaised === head) return pr
  const label = labelJobAt(view)
  if (approvalCheckAt(view) !== "red" || label === "none" || label === "running") return pr
  const check = view.statusCheckRollup.find((c) => checkName(c) === APPROVAL_CHECK)
  const runId = check ? (actionsJob(check)?.runId ?? null) : null
  try {
    // Red, and the label job finished without a class (the check could not read Linear): nothing to raise from.
    if (label === "without") return await nothingToRaise(deps, pr, head, runId, "no class")
    const issue = await deps.tracker.readIssue(pr.issue)
    const raise = classRaise(view, issue.labels)
    if (!raise) return await nothingToRaise(deps, pr, head, runId, "already")
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
 * Red, with nothing to raise: the issue's class is already where this head's
 * label puts it, or the check gave no class (it could not read Linear). The
 * check reads Linear when it runs, so it may have run before the class
 * changed, or while Linear was out of reach: start it once more at this head.
 * Still red after that, ask a person once, as a failure the infrastructure
 * keeps causing does.
 */
async function nothingToRaise(deps: ReviseDeps, pr: WatchedPr, head: string, runId: string | null, why: "already" | "no class"): Promise<WatchedPr> {
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
      question: `The approval check on ${prLink(pr.url)} is still red after I started it again, and ${
        why === "already" ? `${pr.issue} already has the approval level the change needs` : "it did not say which approval level the change needs"
      }, so I have nothing to raise. A person needs to see why: the check's summary says what it found.`,
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

/** The question when no round goes past the cap: why it stopped, in the mini's words. */
function capQuestion(link: string, rounds: number, reasons: string, why: CapStop | undefined, usage: string | null): string {
  switch (why) {
    case "no-progress":
      return `${link} has the same blockers as after an earlier round, and I have worked on it ${rounds} times: my rounds are not making progress (${reasons}).`
    case "no-verdict":
      return `${link} still fails its review check after I worked on it ${rounds} times, and the review posted no verdict, so I cannot tell what still blocks it (${reasons}).`
    case "runaway":
      return `${link} has had ${rounds} rounds and still has blockers: I stop at ${MAX_TOTAL_REVISE_ROUNDS} rounds by myself (${reasons}).`
    case "usage":
      return `${link} still has blockers after I worked on it ${rounds} times (${reasons}), and usage is too high for me to go on by myself: ${usage}.`
    default:
      return `${link} still has review feedback after I worked on it ${rounds} times (${reasons}).`
  }
}

/** One open PR of this mini's: plan, then act, and keep what it did on the record. */
export async function reviseOwnPr(deps: ReviseDeps, pr: WatchedPr, view: OwnPrView, required: readonly string[]): Promise<void> {
  const verdicts = await classifyFailures(deps, view, pr, required)
  const infra = Object.fromEntries(Object.entries(verdicts).map(([name, v]) => [`${view.headRefOid}:${name}`, v]))
  let record: WatchedPr = { ...(await raiseClass(deps, pr, view)), infra }
  const usertest = readUserTestState(deps.paths, pr.url)
  const now = deps.now()
  const usageBlocked = developBlockedByUsage(readUsage(deps.paths), deps.config.queue, now)
  const plan = planRevision(view, pr, { mini: deps.config.mini, required, infra: verdicts, usertest, base: deps.config.repo.base, usageBlocked })
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
      if (isConflictOnly(plan.reasons)) {
        // Once per head, as the id says: a new head that still conflicts asks again.
        askDecision(
          deps.paths,
          deps.config,
          {
            id: `conflict-${pr.issue}-${view.number}-${view.headRefOid.slice(0, 12)}`,
            issue: pr.issue,
            url: pr.url,
            question: `${prLink(pr.url)} still cannot go in: it clashes with changes made to ${deps.config.repo.base} since, and I have already tried to combine them ${MAX_CONFLICT_ROUNDS} times.`,
            options: [
              { reply: "fix it", does: "have me try once more" },
              { reply: "leave it", does: "leave it to a person" },
            ],
            defaultReply: "leave it",
            defaultAction: { kind: "leave" },
          },
          now,
        )
        // The review cap's question is not this one: its record stays as it was.
        record = { ...record, revise: { ...(pr.revise ?? { rounds: 0 }), handled: [...(pr.revise?.handled ?? []), ...plan.handled] } }
        appendLedger(deps.paths, { type: "pr.conflictCapped", issue: pr.issue, url: pr.url }, now)
        break
      }
      askDecision(
        deps.paths,
        deps.config,
        {
          id: `cap-${pr.issue}-${view.number}`,
          issue: pr.issue,
          url: pr.url,
          question: `${capQuestion(prLink(pr.url), pr.revise?.rounds ?? MAX_REVISE_ROUNDS, plan.reasons.join(", "), plan.why, usageBlocked)}${plan.reasons.includes(BROWSER_TEST_REASON) ? " It does not go in by itself until then." : ""}`,
          options: [
            { reply: "fix it", does: "have me try once more" },
            { reply: "leave it", does: "leave it to a person" },
          ],
          defaultReply: "leave it",
          defaultAction: { kind: "leave" },
        },
        now,
      )
      record = { ...record, revise: { ...(pr.revise ?? { rounds: MAX_REVISE_ROUNDS, handled: [] }), handled: [...(pr.revise?.handled ?? []), ...plan.handled], asked: true, askedHead: view.headRefOid } }
      appendLedger(deps.paths, { type: "pr.reviseCapped", issue: pr.issue, url: pr.url, ...(plan.why ? { why: plan.why } : {}) }, now)
      break
    }
    case "revise": {
      // One job per issue: the next watch picks this feedback up once the running one ends.
      if (["pending", "running"].some((state) => listJobs(deps.paths, state as "pending" | "running").some((j) => j.issue === pr.issue))) break
      const handled = [...(pr.revise?.handled ?? []), ...plan.handled]
      if (isConflictOnly(plan.reasons)) {
        // Its own count, and the review rounds' record as it was: their cap, their question, and the feedback window (lastRoundAt).
        const round = (pr.revise?.conflictRounds ?? 0) + 1
        submitJob(deps.paths, pr.issue, null, now, {
          kind: "revise",
          revise: { url: view.url, number: view.number, branch: view.headRefName, round, since: pr.revise?.lastRoundAt ?? pr.openedAt, reasons: plan.reasons },
        })
        record = { ...record, revise: { ...(pr.revise ?? { rounds: 0 }), handled, conflictRounds: round } }
        appendLedger(deps.paths, { type: "pr.revise", issue: pr.issue, url: pr.url, round, reasons: plan.reasons }, now)
        enqueueSlack(
          deps.paths,
          {
            kind: "post",
            channel: "agents",
            text: `${pr.issue}: ${prLink(pr.url)} clashes with changes made to ${deps.config.repo.base} since it was opened, so I am combining the two, try ${round} of ${MAX_CONFLICT_ROUNDS}. ${NOTHING_NEEDED}`,
          },
          now,
        )
        break
      }
      const round = (pr.revise?.rounds ?? 0) + 1
      // Every round's blockers, oldest first: past the cap, blockers any of them had stop the rounds.
      const history = [...(pr.revise?.blockerHistory ?? []), ...(plan.blockers ? [plan.blockers] : [])]
      submitJob(deps.paths, pr.issue, null, now, {
        kind: "revise",
        revise: {
          url: view.url,
          number: view.number,
          branch: view.headRefName,
          round,
          since: pr.revise?.lastRoundAt ?? pr.openedAt,
          reasons: plan.reasons,
          ...(plan.handled.some((id) => id.startsWith("usertest:")) && usertest ? { usertestFindings: usertest.findings } : {}),
        },
      })
      record = {
        ...record,
        revise: {
          rounds: round,
          handled,
          lastRoundAt: now.toISOString(),
          ...(pr.revise?.conflictRounds ? { conflictRounds: pr.revise.conflictRounds } : {}),
          ...(history.length ? { blockerHistory: history } : {}),
        },
      }
      // Only past the cap because the blockers still change: planRevision sends no other round there.
      const left = plan.blockers?.length ?? 0
      const pastCap = round > MAX_REVISE_ROUNDS
      appendLedger(deps.paths, { type: "pr.revise", issue: pr.issue, url: pr.url, round, reasons: plan.reasons, ...(pastCap ? { pastCap: `blockers changed: ${left} left` } : {}) }, now)
      enqueueSlack(
        deps.paths,
        {
          kind: "post",
          channel: "agents",
          // The browser test's reason and the conflict's say nothing feedbackFor has not said already.
          text: `${pr.issue}: I am fixing ${feedbackFor(plan.reasons)} on ${prLink(pr.url)}${((rest) => (rest.length ? ` (${rest.join(", ")})` : ""))(plan.reasons.filter((r) => r !== BROWSER_TEST_REASON && !isConflictReason(r)))}, ${
            pastCap
              ? `try ${round}, past my usual ${MAX_REVISE_ROUNDS}: ${left} ${left === 1 ? "blocker is" : "blockers are"} still open, and the last round changed them.`
              : `try ${round} of ${MAX_REVISE_ROUNDS}.`
          } ${NOTHING_NEEDED}`,
        },
        now,
      )
      break
    }
  }
  updateWatchedPr(deps.paths, record)
}
