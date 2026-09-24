/**
 * The watchdog's claim duties (spec 6.2): refresh the heartbeat of a claim a
 * live local job holds, and release any claim whose heartbeat is older than
 * the TTL (6 hours). A live local job is never released, whatever its
 * heartbeat says: Linear may simply have been down (Review Focus 4).
 *
 * The sweep releases only this mini's own claims: listClaims returns the
 * issues assigned to the key's own Linear account (isMe), and each mini has
 * its own (decision 7, 2026-09-24). No mini sweeps another's. A dead mini's
 * claims are released by running the rollback's release steps with that
 * mini's key (docs/agent-mini-runbook.md, "Rollback": trackerctl claims,
 * then trackerctl release for each).
 */

import type { AgentConfig, AgentPaths } from "../config.ts"
import { listJobs } from "../jobs.ts"
import { appendLedger, type Logger } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import type { ClaimRecord, Tracker } from "../tracker.ts"

export function sweepDecision(input: {
  claims: ClaimRecord[]
  runningIssues: ReadonlySet<string>
  now: Date
  ttlHours: number
}): { refresh: string[]; release: Array<{ issue: string; reason: string }> } {
  const refresh: string[] = []
  const release: Array<{ issue: string; reason: string }> = []
  for (const c of input.claims) {
    if (input.runningIssues.has(c.issue.id)) {
      refresh.push(c.issue.id)
      continue
    }
    const hours = (input.now.getTime() - Date.parse(c.heartbeatAt)) / 3_600_000
    if (hours > input.ttlHours) {
      release.push({ issue: c.issue.id, reason: `claim by ${c.claimant} has had no heartbeat for ${Math.floor(hours)} hours` })
    }
  }
  return { refresh, release }
}

export async function heartbeatAndSweep(deps: {
  tracker: Tracker
  paths: AgentPaths
  config: AgentConfig
  now: () => Date
  /** Whether `pid` is still the worker for `jobId` (isWorkerAlive). */
  isAlive: (pid: number, jobId: string) => boolean
  log: Logger
}): Promise<{ refreshed: number; released: number }> {
  const running = new Set(
    listJobs(deps.paths, "running")
      .filter((j) => j.pid !== undefined && deps.isAlive(j.pid, j.id))
      .map((j) => j.issue),
  )
  const decision = sweepDecision({ claims: await deps.tracker.listClaims(), runningIssues: running, now: deps.now(), ttlHours: deps.config.claims.ttlHours })
  let refreshed = 0
  for (const issue of decision.refresh) {
    if (await deps.tracker.touchClaim(issue, deps.config.mini)) refreshed++
    // The running job's claim is signed by another name: it is never
    // released while the job runs, and after that it ages like any other.
    else deps.log.warn("no claim comment by this mini to refresh", { issue, mini: deps.config.mini })
  }
  for (const r of decision.release) {
    await deps.tracker.releaseIssue(r.issue, r.reason)
    appendLedger(deps.paths, { type: "released", issue: r.issue, reason: r.reason }, deps.now())
    enqueueSlack(deps.paths, { kind: "post", channel: "agents", text: `released ${r.issue}: ${r.reason}` }, deps.now())
  }
  return { refreshed, released: decision.release.length }
}
