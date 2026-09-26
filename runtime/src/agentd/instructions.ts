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
 *   class-look, class-auto   the request's class (D1): a lowering through the
 *           answer recorder's own Linear account (lower.ts), a raise through
 *           the agent's own tracker
 * Any of them but a class change answers the issue's open question (agentd/decisions.ts).
 *
 * The Monday bridge files the same instructions from a person's words on the
 * board (STEP-3289), and they are answered on the board's item, with a like
 * on the person's update where Slack gets the ✅.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { ack, listNew } from "../fsq.ts"
import { listJobs, readWatchedPrs, retryFields, submitJob, updateWatchedPr, type JobRecord, type WatchedPr } from "../jobs.ts"
import { appendLedger, type Logger } from "../log.ts"
import { changeClass, NeedsRecorder } from "../lower.ts"
import type { LinearRequest, PeopleView } from "../monday/people.ts"
import { say } from "../monday/render.ts"
import { enqueueMonday } from "../monday/store.ts"
import { enqueueSlack } from "../outbox.ts"
import { NOTHING_NEEDED, plainLinks, plainReason, prLink } from "../plain.ts"
import { isClassAction, type Action, type AnyInstructionEntry, type InstructionEntry } from "../slack/instruction.ts"
import { threadFor } from "../threads.ts"
import type { ApprovalClass, Tracker } from "../tracker.ts"
import type { Exec } from "../worker/git.ts"
import { mergeMode, readAutoMergePolicy } from "../worker/run.ts"
import { closeDecision, openDecisions } from "./decisions.ts"
import { requiredChecks } from "./health.ts"
import { conflictWith, failingRequired, MAX_REVISE_ROUNDS, type OwnPrView } from "./revise.ts"
import { readUserTestState } from "../usertest/state.ts"

export type { AnyInstructionEntry, InstructionEntry }

export interface InstructionDeps {
  exec: Exec
  paths: AgentPaths
  config: AgentConfig
  now: () => Date
  log: Logger
  /** A person's class change (D1): the agent's own tracker, the people view, and the answer recorder's transport, read when a lowering comes. */
  lower?: { tracker: Tracker; people: Pick<PeopleView, "byIdentifiers" | "childrenOf">; recorder: () => LinearRequest | null }
}

const GH_TIMEOUT_MS = 2 * 60_000
/** The order a reply's actions run in: a pause first, a merge last, after the revision it waits for. */
const ORDER: Action[] = ["pause", "leave", "revise", "rerun", "retry", "merge"]

/** Every instruction in the inbox: act, reply in its thread, and mark it handled. */
export async function actOnInstructions(deps: InstructionDeps): Promise<void> {
  for (const { key, payload } of listNew<AnyInstructionEntry>(deps.paths.inbox)) {
    if (payload.type !== "instruction") continue
    let lines: string[]
    try {
      lines = await act(deps, payload)
    } catch (error) {
      lines = [`I could not do that: ${error instanceof Error ? error.message : String(error)}. A person should look.`]
      deps.log.warn("instruction failed", { key, error: String(error) })
    }
    const now = deps.now()
    if (payload.monday) {
      // Words from the Monday board are answered there (STEP-3289), with a like beside them, and links as Monday shows them.
      const { itemId, updateId, threadId } = payload.monday
      enqueueMonday(deps.paths, { itemId, threadId, text: plainLinks(lines.join("\n")), like: updateId }, now)
    } else {
      enqueueSlack(deps.paths, { kind: "reply", channelId: payload.channel, threadTs: payload.threadTs, text: lines.join("\n") }, now)
      // A ✅ beside the words, never instead of them.
      enqueueSlack(deps.paths, { kind: "react", channelId: payload.channel, ts: payload.ts, name: "white_check_mark" }, now)
    }
    ack(deps.paths.inbox, key)
    const issue = payload.issue ?? payload.target.issue
    appendLedger(deps.paths, { type: "instruction", ...(issue ? { issue } : {}), actions: payload.actions, by: payload.userName }, now)
  }
}

/** The watched PR the instruction means: the thread's issue, a named issue, or a named PR of this mini's. */
function findPr(paths: AgentPaths, entry: AnyInstructionEntry): { issue: string | null; pr: WatchedPr | null } {
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

async function viewPr(deps: InstructionDeps, url: string): Promise<OwnPrView> {
  const r = await deps.exec("gh", ["pr", "view", url, "--json", "url,number,state,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup"], { timeoutMs: GH_TIMEOUT_MS })
  if (r.code !== 0) throw new Error(`gh could not read ${url} (${r.stderr.trim() || `exit ${r.code}`})`)
  return JSON.parse(r.stdout)
}

const busyJob = (paths: AgentPaths, issue: string): JobRecord | null =>
  [...listJobs(paths, "running"), ...listJobs(paths, "pending")].find((j) => j.issue === issue) ?? null

/** One closing line: the one thing a person must do, or that nothing is needed (../plain.ts). */
const closed = (lines: string[]) => (lines.some((l) => /\bA person (needs|should)\b|\bPlease\b/.test(l)) ? lines : [...lines, NOTHING_NEEDED])

/**
 * A person's whole "make it look" (D1), on the issue its thread or item is
 * for: a lowering through the answer recorder, announced in #polads-agents, a
 * raise through the agent's own tracker. A Slack thread that holds more than
 * one request (agentctl request) changes none of them.
 */
async function changeClassFor(deps: InstructionDeps, entry: AnyInstructionEntry, to: ApprovalClass): Promise<string[]> {
  const issue = entry.issue
  if (!issue) return [`I could not tell which request you mean, so I changed nothing. Please say it in the request's own thread or on its Monday item.`]
  const thread = entry.monday ? null : threadFor(deps.paths, issue)
  if (thread?.alsoFor?.length) return [say.classShared([issue, ...thread.alsoFor])]
  if (!deps.lower) return [say.classNeedsLinear(issue, to)]
  const who = entry.userName || entry.user
  const via = entry.monday ? "on Monday" : "in Slack"
  const where = entry.permalink ?? thread?.permalink ?? issue
  try {
    const out = await changeClass(deps.lower, { issue, to, who, where, via })
    if (out.outcome === "same") return [say.classSame(issue, to)]
    if (out.outcome === "lowered") enqueueSlack(deps.paths, { kind: "post", channel: "agents", text: say.lowered(issue, out.from, to, who, via, where) }, deps.now())
    return [say.classChanged(issue, to, who)]
  } catch (error) {
    if (error instanceof NeedsRecorder) return [say.classNeedsLinear(issue, to)]
    throw error
  }
}

async function act(deps: InstructionDeps, entry: AnyInstructionEntry): Promise<string[]> {
  const { paths, config } = deps
  const now = deps.now()
  // A class verb is the whole message (slack/instruction.ts), so it runs alone.
  const verb = entry.actions.find(isClassAction)
  if (verb) return changeClassFor(deps, entry, verb === "class-look" ? "look" : "auto")
  const who = entry.userName || entry.user
  const where = entry.monday ? "on the Monday board" : "in Slack"
  const { issue, pr } = findPr(paths, entry)
  const lines: string[] = []
  const actions = ORDER.filter((a) => entry.actions.includes(a))
  // A pause is the whole mini's: it needs no PR, so "@eve pause" pauses (STEP-3293 review).
  if (actions.includes("pause")) {
    if (existsSync(paths.pauseFile)) {
      lines.push("I am paused already, so nothing changed. To carry on, a person lifts the pause on the mini.")
    } else {
      const reason = `asked by ${who} ${where}`
      mkdirSync(paths.root, { recursive: true })
      writeFileSync(paths.pauseFile, JSON.stringify({ at: now.toISOString(), reason }))
      appendLedger(paths, { type: "paused", reason }, now)
      lines.push("Paused, as you asked. I start nothing new and finish what I am doing now. To carry on, a person lifts the pause on the mini.")
    }
  }
  if (!actions.some((a) => a !== "pause")) return closed(lines)
  if (!issue) {
    const did = lines.length ? "so I did nothing more" : "so I did nothing"
    return closed([...lines, `I could not tell which PR you mean, ${did}. Please name it: STEP-<n>, #<number> or its link. I only act on PRs I opened.`])
  }
  let view: OwnPrView | null = null
  const open = async () => {
    if (!pr) return null
    view ??= await viewPr(deps, pr.url)
    return view.state === "OPEN" ? view : null
  }
  let revising = false

  for (const action of actions) {
    if (action === "leave") {
      lines.push(`OK, I will leave ${pr ? prLink(pr.url) : issue} to a person and not touch it until someone asks.`)
    }
    if (action === "revise") {
      const busy = busyJob(paths, issue)
      const v = await open()
      if (busy) {
        lines.push(`I am already ${listJobs(paths, "running").some((j) => j.id === busy.id) ? "working on it" : "about to work on it, as it is next in line"}.`)
        revising = busy.kind === "revise"
      } else if (v && pr) {
        const round = (pr.revise?.rounds ?? 0) + 1
        // The browser test's findings at this head go with the round, as agentd's own rounds carry them (WS5).
        const ut = readUserTestState(paths, v.url)
        const usertestFindings = ut?.verdict === "findings" && ut.head === v.headRefOid ? ut.findings : undefined
        // A PR that clashes with the base: the round merges it in, and agentd sends no round of its own for this head (STEP-3340).
        const conflict = conflictWith(v, config.repo.base)
        const job = submitJob(paths, issue, null, now, {
          kind: "revise",
          revise: {
            url: v.url, number: v.number, branch: v.headRefName, round, since: pr.revise?.lastRoundAt ?? pr.openedAt,
            reasons: [`asked by ${who} ${where}`, ...(conflict ? [conflict] : [])], instruction: entry.text,
            ...(usertestFindings ? { usertestFindings } : {}),
          },
        })
        // The head the round cap asked at stays: findings at a later head ask again (WS5).
        updateWatchedPr(paths, {
          ...pr,
          revise: {
            ...pr.revise,
            rounds: round,
            handled: [...(pr.revise?.handled ?? []), ...(conflict ? [`conflict:${v.headRefOid}`] : [])],
            lastRoundAt: now.toISOString(),
          },
        })
        appendLedger(paths, { type: "pr.revise", issue, url: v.url, round, reasons: [`asked by ${who}`] }, now)
        const past = round > MAX_REVISE_ROUNDS ? ` This is try ${round}, past my usual ${MAX_REVISE_ROUNDS}, because you asked.` : ""
        lines.push(`I am fixing ${prLink(v.url)} now, as you asked.${past}`)
        deps.log.info("revise job queued, as a person asked", { issue, jobId: job.id, by: who })
        revising = true
      } else if (lastBlocked(paths, issue)) {
        // No open PR to revise: the work is a blocked job's, so it is retried, once however the reply put it.
        if (!entry.actions.includes("retry")) lines.push(...retry(paths, issue, now))
      } else {
        lines.push(`I have no open PR for ${issue}, so there is nothing to fix.`)
      }
    }
    if (action === "rerun") {
      const v = await open()
      if (!v) {
        lines.push(`I have no open PR for ${issue}, so there are no checks to start again.`)
        continue
      }
      const runs = [...new Set(failingRequired(v, requiredChecks(config.repo.path)).map((f) => f.job?.runId).filter((r): r is string => Boolean(r)))]
      if (!runs.length) {
        lines.push(`Nothing that must pass is failing on ${prLink(v.url)}, so there is nothing to start again.`)
        continue
      }
      const done: string[] = []
      for (const run of runs) {
        // In full, never --failed: Test shards share a database branch the first run tore down.
        const r = await deps.exec("gh", ["run", "rerun", run, "--repo", config.repo.slug], { timeoutMs: GH_TIMEOUT_MS })
        if (r.code === 0) done.push(run)
      }
      if (pr && done.length) updateWatchedPr(paths, { ...pr, reruns: [...(pr.reruns ?? []), ...done.map((run) => `${v.headRefOid}:${run}`)] })
      lines.push(done.length ? `I started the automatic checks on ${prLink(v.url)} again.` : `GitHub would not let me start the checks on ${prLink(v.url)} again. A person needs to start them from the PR.`)
    }
    if (action === "retry") lines.push(...retry(paths, issue, now))
    if (action === "merge") {
      const v = await open()
      if (!v) {
        lines.push(`I have no open PR for ${issue} to merge.`)
        continue
      }
      const base = v.baseRefName ?? config.repo.base
      const mode = mergeMode(readAutoMergePolicy(config.repo.path, base), config)
      if (mode === "mini-off") {
        lines.push(`I cannot merge ${prLink(v.url)} myself, because merging by myself is turned off on this mini. A person needs to merge it once the checks pass.`)
      } else if (mode === "person") {
        lines.push(`I cannot merge ${prLink(v.url)} myself, because a person merges into ${base}. A person needs to merge it once the checks pass.`)
      } else {
        const r = await deps.exec("gh", ["pr", "merge", v.url, "--auto", "--squash", "--delete-branch"], { cwd: config.repo.path, timeoutMs: GH_TIMEOUT_MS })
        lines.push(
          r.code === 0
            ? `${prLink(v.url)} will go into ${base} by itself${revising ? " after my fixes" : ""}, once the checks and the review pass.`
            : `GitHub would not let me set ${prLink(v.url)} to go in by itself (${r.stderr.trim().split("\n")[0] || `exit ${r.code}`}). A person needs to merge it.`,
        )
      }
    }
  }
  // Whatever it asked, it answers the issue's open question.
  for (const d of openDecisions(paths, issue)) closeDecision(paths, d.id, `answered by ${who}: ${actions.join(", ")}`, now)
  if (!lines.length) lines.push(`I read that as a request about ${issue}, but found nothing to do.`)
  return closed(lines)
}

function lastBlocked(paths: AgentPaths, issue: string): JobRecord | null {
  // A browser test is not work on the issue to try again (WS5).
  const done = listJobs(paths, "done").filter((j) => j.issue === issue && j.endedAt && j.kind !== "usertest")
  const last = done.sort((a, b) => a.endedAt!.localeCompare(b.endedAt!)).at(-1)
  return last?.result?.status === "blocked" ? last : null
}

function retry(paths: AgentPaths, issue: string, now: Date): string[] {
  const busy = busyJob(paths, issue)
  if (busy) return [`I am already working on ${issue}.`]
  const blocked = lastBlocked(paths, issue)
  if (!blocked) return [`My last try at ${issue} did not stop on a problem, so there is nothing to try again.`]
  submitJob(paths, issue, blocked.model, now, retryFields(blocked))
  return [`I am trying ${issue} again from where I stopped (last time: ${plainReason(blocked.result?.reason ?? "no reason recorded")}).`]
}
