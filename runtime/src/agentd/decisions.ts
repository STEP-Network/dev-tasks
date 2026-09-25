/**
 * The mini escalates only a real decision (STEP-3285), and then as ONE
 * question in the issue's Slack thread, with its options and a recommended
 * default. An answer in the thread is an instruction (agentd/instructions.ts)
 * and closes the question. With no answer by its deadline, agentd takes the
 * default, but only a reversible, staging-only one (a CI re-run, leaving a PR
 * alone), and says so in the thread, the PR body and the issue.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { readJson, writeJsonAtomic } from "../fsq.ts"
import { appendLedger, type Logger } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import type { Exec } from "../worker/git.ts"

/** How long a question waits before its default is taken. */
export const DECISION_MINUTES = 60

/** What a default may do: re-run CI in full, or leave the PR to a person. Both reversible, neither beyond the PR. */
export type DefaultAction = { kind: "rerun"; runs: string[] } | { kind: "leave" }

export interface Decision {
  id: string
  issue: string
  url: string
  /** The situation, in one sentence. */
  question: string
  /** The replies it takes, each with what it does. */
  options: Array<{ reply: string; does: string }>
  /** One of the options' replies. */
  defaultReply: string
  defaultAction: DefaultAction
  askedAt: string
  deadlineAt: string
  closed?: { at: string; how: string }
}

const dir = (paths: AgentPaths) => join(paths.state, "decisions")
const file = (paths: AgentPaths, id: string) => join(dir(paths), `${id}.json`)

export function openDecisions(paths: AgentPaths, issue?: string): Decision[] {
  if (!existsSync(dir(paths))) return []
  return readdirSync(dir(paths))
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<Decision>(join(dir(paths), f)))
    .filter((d): d is Decision => d !== null && !d.closed && (!issue || d.issue === issue))
    .sort((a, b) => a.askedAt.localeCompare(b.askedAt))
}

export function closeDecision(paths: AgentPaths, id: string, how: string, now: Date): void {
  const d = readJson<Decision>(file(paths, id))
  if (d && !d.closed) writeJsonAtomic(file(paths, id), { ...d, closed: { at: now.toISOString(), how } })
}

/** "14:05", in the mini's own time zone. */
function clock(at: Date, timeZone: string): string {
  return at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone })
}

/** The question as Slack shows it: the situation, then each reply and what it does, the default marked with its time. */
export function questionText(d: Decision, timeZone: string): string {
  const options = d.options.map((o) =>
    o.reply === d.defaultReply ? `"${o.reply}" to ${o.does} (the default: I do it at ${clock(new Date(d.deadlineAt), timeZone)} if nobody answers)` : `"${o.reply}" to ${o.does}`,
  )
  return `${d.question} Reply ${options.join(", or ")}.`
}

/** Asks once: a question for this id already asked is not asked again. */
export function askDecision(
  paths: AgentPaths,
  config: AgentConfig,
  d: Omit<Decision, "askedAt" | "deadlineAt">,
  now: Date,
): Decision | null {
  if (existsSync(file(paths, d.id))) return null
  const decision: Decision = { ...d, askedAt: now.toISOString(), deadlineAt: new Date(now.getTime() + DECISION_MINUTES * 60_000).toISOString() }
  mkdirSync(dir(paths), { recursive: true })
  writeJsonAtomic(file(paths, d.id), decision)
  enqueueSlack(paths, { kind: "issue", issue: d.issue, text: questionText(decision, config.queue.timeZone), question: true }, now)
  appendLedger(paths, { type: "decision.asked", issue: d.issue, url: d.url, id: d.id }, now)
  return decision
}

export interface DefaultDeps {
  exec: Exec
  paths: AgentPaths
  config: AgentConfig
  now: () => Date
  log: Logger
  /** A comment on the issue, for the decisions log. */
  comment: (issue: string, body: string) => Promise<void>
}

const GH_TIMEOUT_MS = 2 * 60_000

/**
 * Every question past its deadline: take its default, and write it where a
 * reviewer and a person reading the issue will see it.
 */
export async function takeDefaults(deps: DefaultDeps): Promise<void> {
  const now = deps.now()
  for (const d of openDecisions(deps.paths)) {
    if (Date.parse(d.deadlineAt) > now.getTime()) continue
    const chosen = d.options.find((o) => o.reply === d.defaultReply)
    let did = chosen?.does ?? d.defaultReply
    if (d.defaultAction.kind === "rerun") {
      const done: string[] = []
      for (const run of d.defaultAction.runs) {
        // In full, never --failed: Test shards share a database branch the first run tore down.
        const r = await deps.exec("gh", ["run", "rerun", run, "--repo", deps.config.repo.slug], { timeoutMs: GH_TIMEOUT_MS })
        if (r.code === 0) done.push(run)
        else deps.log.warn("gh run rerun failed", { url: d.url, run, stderr: r.stderr.trim() })
      }
      if (!done.length) did = `${did}, but GitHub refused the re-run`
    }
    const line = `${now.toISOString().slice(0, 16).replace("T", " ")} UTC: ${d.question} Nobody answered by ${d.deadlineAt.slice(11, 16)} UTC, so I took the default: ${did}.`
    closeDecision(deps.paths, d.id, `default: ${d.defaultReply}`, now)
    enqueueSlack(deps.paths, { kind: "issue", issue: d.issue, text: `No answer, so I took the default: ${did}. It is logged in the PR and the issue.`, question: false }, now)
    await logDecision(deps, d, line)
    appendLedger(deps.paths, { type: "decision.default", issue: d.issue, url: d.url, id: d.id, reply: d.defaultReply }, now)
  }
}

/** The decisions log: a line under "Decisions taken by default" in the PR body, and the same on the issue. */
async function logDecision(deps: DefaultDeps, d: Decision, line: string): Promise<void> {
  const heading = "## Decisions taken by default"
  const view = await deps.exec("gh", ["pr", "view", d.url, "--json", "body", "--jq", ".body"], { timeoutMs: GH_TIMEOUT_MS })
  if (view.code === 0) {
    const body = view.stdout.replace(/\n+$/, "")
    const next = body.includes(heading) ? `${body}\n- ${line}\n` : `${body}\n\n${heading}\n\n- ${line}\n`
    mkdirSync(deps.paths.state, { recursive: true })
    const bodyFile = join(deps.paths.state, `pr-body-${d.issue}-decisions.md`)
    writeFileSync(bodyFile, next)
    const edit = await deps.exec("gh", ["pr", "edit", d.url, "--body-file", bodyFile], { timeoutMs: GH_TIMEOUT_MS })
    if (edit.code !== 0) deps.log.warn("the PR body could not take the decision", { url: d.url, stderr: edit.stderr.trim() })
  } else {
    deps.log.warn("the PR body could not be read for the decision", { url: d.url, stderr: view.stderr.trim() })
  }
  await deps.comment(d.issue, `Decision taken by default. ${line}`).catch((error: unknown) => {
    deps.log.warn("the issue could not take the decision", { issue: d.issue, error: String(error) })
  })
}
