/**
 * `agentctl tick`: everything the front door needs at one wakeup, computed
 * without the model, as one JSON object. The /front-door skill acts on it.
 * Calling it is also the front door's heartbeat: agentd restarts a session
 * whose last tick is too old (Task 14). The heartbeat is written first, so a
 * wakeup counts even while Linear is down.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { openDecisions } from "./agentd/decisions.ts"
import type { AgentConfig, AgentPaths } from "./config.ts"
import { listNew, readJson, writeJsonAtomic } from "./fsq.ts"
import { threadFor } from "./threads.ts"
import { coolingIssues, heldBackIssues, listJobs, updateJob } from "./jobs.ts"
import { nextWakeupSeconds, selectNext, type QueuePolicy } from "./select.ts"
import { onQueue } from "./select.ts"
import type { Tracker, TrackerIssue } from "./tracker.ts"
import { developBlockedByUsage, readUsage } from "./usage.ts"

export interface InboxEvent {
  key: string
  /** reply: a person's message in a thread this mini owns, which the front door reads and decides about (STEP-3293). */
  type: "intake" | "mention" | "reply"
  /** Set on intake: the Triage issue the bridge filed. On reply: the thread's issue. */
  issue?: string
  /** Set on intake: whether this mini refines it (open mode, or the id on queue.allow). The bridge's reply said which. */
  refine?: boolean
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
  /** Set on reply: the last question this mini asked in the thread, whose recommendation a "yes" agrees to. */
  question?: string
  /** Set on reply: the decision agentd waits on for the issue, with the reply it takes by default. */
  decision?: { id: string; defaultReply: string; replies: string[] }
  /** Set on a reply or mention the bridge acted on itself (pause, leave): done already, so never again. */
  acted?: string[]
}

export interface Digest {
  now: string
  mini: string
  paused: boolean
  /** Why, while paused: what agentctl pause, agentd (early losses) or the runner (a graft) wrote. "" when none was given. */
  pauseReason: string | null
  /** open: the whole queue. allowlist: only queue.allow, so a request filed now is left to a person. */
  queueMode: AgentConfig["queue"]["mode"]
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
  /** On a reply: the last question this mini had asked in the thread when the bridge filed it (STEP-3293). */
  lastQuestion?: string | null
  lastQuestionAt?: string | null
  acted?: string[]
}

/** The types the front door reads. "answer" is a reply filed before STEP-3293, read the same way. */
const FOR_FRONT_DOOR = new Set(["mention", "reply", "answer"])

export const tickPath = (paths: AgentPaths) => join(paths.state, "frontdoor-tick.json")

/**
 * null while the mini runs. Paused: the reason agentctl pause, agentd (early
 * losses) or the runner (a graft) wrote, or "" when there is none, as after a
 * bare `touch ~/.agentd/PAUSE`.
 */
export function pauseReason(paths: AgentPaths): string | null {
  if (!existsSync(paths.pauseFile)) return null
  const reason = readJson<{ reason?: unknown }>(paths.pauseFile)?.reason
  return typeof reason === "string" ? reason : ""
}

/** What the front door acts on, and nothing of the bridge's own bookkeeping (linearId, retry marks): every wakeup reads it. */
function toEvent(paths: AgentPaths, p: StoredEntry, queue: AgentConfig["queue"]): InboxEvent {
  const reply = p.type === "reply" || p.type === "answer"
  const decision = reply && p.issue ? openDecisions(paths, p.issue)[0] : undefined
  // The question they answered: the one asked before the bridge filed the reply. Older entries carry none, and the thread's stands in.
  const question = reply && p.issue ? (p.lastQuestionAt !== undefined ? p.lastQuestion : threadFor(paths, p.issue)?.lastQuestion) : undefined
  return {
    key: p.key,
    type: p.type === "intake" ? "intake" : reply ? "reply" : "mention",
    ...(p.type === "intake" && p.issue ? { issue: p.issue, refine: onQueue(p.issue, queue) } : {}),
    ...(reply && p.issue ? { issue: p.issue } : {}),
    channel: p.channel,
    ts: p.ts,
    threadTs: p.threadTs ?? p.ts,
    user: p.user,
    userName: p.userName ?? p.user,
    text: p.text,
    receivedAt: p.receivedAt,
    ...(p.filedBy ? { filedBy: p.filedBy } : {}),
    ...(question ? { question } : {}),
    ...(decision ? { decision: { id: decision.id, defaultReply: decision.defaultReply, replies: decision.options.map((o) => o.reply) } } : {}),
    ...(p.acted?.length ? { acted: p.acted } : {}),
  }
}

/**
 * Every message waiting for the front door, oldest first: the digest's events
 * and what the Slack channel pushes (channel/server.ts). Intakes the bridge
 * has not filed yet are the bridge's to finish.
 */
export function inboxEvents(paths: AgentPaths, config: AgentConfig): InboxEvent[] {
  return listNew<StoredEntry>(paths.inbox)
    .map((e) => e.payload)
    .filter((p) => FOR_FRONT_DOOR.has(p.type) || (p.type === "intake" && Boolean(p.issue)))
    .map((p) => toEvent(paths, p, config.queue))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
}

export async function buildDigest(deps: DigestDeps): Promise<Digest> {
  const { paths, config } = deps
  const now = deps.now()
  writeJsonAtomic(tickPath(paths), { at: now.toISOString() })
  const paused = existsSync(paths.pauseFile)

  // Every message not closed yet, pushed by the Slack channel or not: Claude
  // Code drops a push it did not register the channel for, and says nothing
  // (STEP-3293 review). Closing one twice is refused, so it is handled once.
  const events = inboxEvents(paths, config).slice(0, 10)

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
    // On the allowlist, the listed issues themselves, ranked among themselves: each state's top first and the
    // allowlist after lost every listed issue past it (STEP-3368: 463 in Refining, 432 in Ready).
    const only = policy.mode === "allowlist" ? policy.allow : undefined
    const listed = await deps.tracker.listReady(250, only)
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
    const triage: TrackerIssue[] = wantRefine ? await deps.tracker.listByState("Triage", 20, only) : []
    const refining: TrackerIssue[] = wantRefine ? await deps.tracker.listByState("Refining", 20, only) : []
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
    pauseReason: pauseReason(paths),
    queueMode: config.queue.mode,
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
