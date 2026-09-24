/**
 * `agentctl tick`: everything the front door needs at one wakeup, computed
 * without the model, as one JSON object. The /front-door skill acts on it.
 * Calling it is also the front door's heartbeat: agentd restarts a session
 * whose last tick is too old (Task 14). The heartbeat is written first, so a
 * wakeup counts even while Linear is down.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { AgentConfig, AgentPaths } from "./config.ts"
import { listNew, writeJsonAtomic } from "./fsq.ts"
import { coolingIssues, heldBackIssues, listJobs, updateJob } from "./jobs.ts"
import { nextWakeupSeconds, selectNext, type QueuePolicy } from "./select.ts"
import type { Tracker, TrackerIssue } from "./tracker.ts"
import { developBlockedByUsage, readUsage } from "./usage.ts"

export interface InboxEvent {
  key: string
  type: "intake" | "mention"
  /** Set on intake: the Triage issue the bridge filed. */
  issue?: string
  channel: string
  ts: string
  /** Where to answer: the mention's thread, or the intake message itself. */
  threadTs: string
  user: string
  userName: string
  text: string
  receivedAt: string
  /** Set on a mention in an intake request another agent was named first in: that agent files it, so the front door must not. */
  filedBy?: string
}

export interface Digest {
  now: string
  mini: string
  paused: boolean
  events: InboxEvent[]
  finishedJobs: Array<{ issue: string; status: string; reason: string; prUrl: string | null }>
  worker: { issue: string; startedAt: string; minutes: number } | null
  pendingJobs: string[]
  usage: { fiveHourPct: number | null; sevenDayPct: number | null }
  develop: { id: string; title: string; url: string; mine: boolean } | null
  developBlockedBy: string | null
  refine: { id: string; title: string; url: string; state: string } | null
  readyEligible: number
  /** Ready issues no job is offered for: their last two workers were lost early (heldBackIssues). A person runs one by hand. */
  heldBack: string[]
  linearError: string | null
  nextWakeupSeconds: number
}

export interface DigestDeps {
  paths: AgentPaths
  config: AgentConfig
  tracker: Tracker
  now: () => Date
}

/** An inbox entry as the bridge writes it (slack/bridge.ts), with the fields the digest reads. */
type StoredEntry = {
  key: string
  type: string
  issue?: string | null
  channel: string
  ts: string
  threadTs?: string
  user: string
  userName?: string
  text: string
  receivedAt: string
  filedBy?: string
}

export const tickPath = (paths: AgentPaths) => join(paths.state, "frontdoor-tick.json")

/** What the front door acts on, and nothing of the bridge's own bookkeeping (linearId, retry marks): every wakeup reads it. */
function toEvent(p: StoredEntry): InboxEvent {
  return {
    key: p.key,
    type: p.type === "intake" ? "intake" : "mention",
    ...(p.type === "intake" && p.issue ? { issue: p.issue } : {}),
    channel: p.channel,
    ts: p.ts,
    threadTs: p.threadTs ?? p.ts,
    user: p.user,
    userName: p.userName ?? p.user,
    text: p.text,
    receivedAt: p.receivedAt,
    ...(p.filedBy ? { filedBy: p.filedBy } : {}),
  }
}

export async function buildDigest(deps: DigestDeps): Promise<Digest> {
  const { paths, config } = deps
  const now = deps.now()
  writeJsonAtomic(tickPath(paths), { at: now.toISOString() })
  const paused = existsSync(paths.pauseFile)

  // Answers and intakes the bridge has not filed yet are the bridge's to finish.
  const events = listNew<StoredEntry>(paths.inbox)
    .map((e) => e.payload)
    .filter((p) => p.type === "mention" || (p.type === "intake" && Boolean(p.issue)))
    .map(toEvent)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    .slice(0, 10)

  const finished = listJobs(paths, "done").filter((j) => !j.reported)
  for (const job of finished) updateJob(paths, "done", job.id, { reported: true })

  const running = listJobs(paths, "running")[0] ?? null
  const pending = listJobs(paths, "pending")
  const usage = readUsage(paths)
  const developBlockedBy = paused
    ? "paused"
    : running || pending.length
      ? "a worker is busy"
      : developBlockedByUsage(usage, config.queue, now)
  const policy: QueuePolicy = {
    mode: config.queue.mode,
    allow: config.queue.allow,
    refineWhenReadyBelow: config.queue.refineWhenReadyBelow,
    product: config.repo.product,
  }
  const refineBlockedBy = paused ? "paused" : null

  let develop: Digest["develop"] = null
  let refine: Digest["refine"] = null
  let readyEligible = 0
  let heldBack: string[] = []
  let linearError: string | null = null
  try {
    const me = await deps.tracker.whoami()
    const listed = await deps.tracker.listReady(250)
    // An issue whose last two workers were lost early would most likely lose a third.
    const held = heldBackIssues(paths)
    heldBack = listed.filter((i) => held.has(i.id)).map((i) => i.id)
    // One whose last job Linear failed waits a while, and is offered again on its own.
    const cooling = coolingIssues(paths, now)
    const ready = listed.filter((i) => !held.has(i.id) && !cooling.has(i.id))
    const firstPass = selectNext({ ready, triage: [], refining: [], meId: me.id, policy, developBlockedBy, refineBlockedBy })
    readyEligible = firstPass.readyEligible
    // Develop needs only the Ready list: a failure below loses the refine, not this.
    if (firstPass.develop) develop = { id: firstPass.develop.id, title: firstPass.develop.title, url: firstPass.develop.url, mine: firstPass.develop.assigneeId === me.id }
    // Only ask Linear for Triage and Refining when refining is actually due.
    const wantRefine = !paused && firstPass.readyEligible < policy.refineWhenReadyBelow
    const triage: TrackerIssue[] = wantRefine ? await deps.tracker.listByState("Triage", 20) : []
    const refining: TrackerIssue[] = wantRefine ? await deps.tracker.listByState("Refining", 20) : []
    const s = selectNext({ ready, triage, refining, meId: me.id, policy, developBlockedBy, refineBlockedBy })
    if (s.refine) refine = { id: s.refine.id, title: s.refine.title, url: s.refine.url, state: s.refine.state }
  } catch (error) {
    linearError = error instanceof Error ? error.message : String(error)
  }

  const acted = events.length > 0 || finished.length > 0 || develop !== null || refine !== null
  const startedAt = running ? (running.startedAt ?? running.submittedAt) : null
  return {
    now: now.toISOString(),
    mini: config.mini,
    paused,
    events,
    finishedJobs: finished.map((j) => ({
      issue: j.issue,
      status: j.result?.status ?? "unknown",
      reason: j.result?.reason ?? "",
      prUrl: j.result?.prUrl ?? null,
    })),
    worker:
      running && startedAt
        ? { issue: running.issue, startedAt, minutes: Math.round((now.getTime() - Date.parse(startedAt)) / 60_000) }
        : null,
    pendingJobs: pending.map((j) => j.issue),
    usage: { fiveHourPct: usage?.fiveHourPct ?? null, sevenDayPct: usage?.sevenDayPct ?? null },
    develop,
    developBlockedBy,
    refine,
    readyEligible,
    heldBack,
    linearError,
    nextWakeupSeconds: nextWakeupSeconds({ acted, now, timeZone: config.queue.timeZone }),
  }
}
