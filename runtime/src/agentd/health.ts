/**
 * agentd's slower duties, each small and testable:
 *   the PR watcher: review feedback on a PR this mini opened brings a
 *     revise job, an infrastructure failure a full CI re-run, and what
 *     neither fixes goes to the issue's Slack thread (revise.ts)
 *   the Linear-down notice (spec 12: after 15 minutes, and when it is back)
 *   the health verdict behind the Sentry cron check-in (the dead-man switch:
 *     if the mini is off, the missing check-in is the alert)
 *   keeping the front door's checkout on origin's base for /refine
 *   cleanup of old queue entries, jobs, big logs and abandoned worktrees
 *
 * gh and git run as the mini's own login through realExec's scrubbed
 * environment (decision 5), and every git is the runner's hardened one, with
 * no replace refs, hooks or fsmonitor: the worker writes under <repo>/.git.
 * That closes what a ref or a config could do, not all of it: the worker can
 * also overwrite a loose object in the shared store, and a checkout does not
 * re-hash what it reads. Only a clone of its own for the worker closes that
 * (a residual risk, in the PR that added this file).
 */

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { listNew } from "../fsq.ts"
import { forgetWatchedPr, listJobs, readWatchedPrs } from "../jobs.ts"
import { appendLedger, type Logger } from "../log.ts"
import { plural } from "../plain.ts"
import { pruneJsonl } from "../retro/jsonl.ts"
import { lessonsFile } from "../retro/lessons.ts"
import { retrosFile } from "../retro/retro.ts"
import { git, isDirty, removeWorktree, type Exec } from "../worker/git.ts"
import { PR_FIELDS, reviseOwnPr, type OwnPrView } from "./revise.ts"

const GH_TIMEOUT_MS = 2 * 60_000

/** The PolAds checks a PR needs, from the main checkout's project config (agentd keeps it on origin's base). */
export function requiredChecks(repo: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(repo, ".claude", "project-config.json"), "utf8")) as { ci?: { requiredChecks?: string[] } }
    return parsed.ci?.requiredChecks ?? []
  } catch {
    return []
  }
}

export async function watchPrs(deps: { exec: Exec; paths: AgentPaths; config: AgentConfig; now: () => Date; log: Logger }): Promise<void> {
  const required = requiredChecks(deps.config.repo.path)
  if (!required.length) deps.log.warn("no required checks in the project config: the PR watcher reports nothing red", { repo: deps.config.repo.path })
  for (const pr of readWatchedPrs(deps.paths)) {
    try {
      const r = await deps.exec("gh", ["pr", "view", pr.url, "--json", PR_FIELDS], { timeoutMs: GH_TIMEOUT_MS })
      if (r.code !== 0) {
        deps.log.warn("gh pr view failed", { url: pr.url, stderr: r.stderr.trim() })
        continue
      }
      const view = JSON.parse(r.stdout) as OwnPrView
      if (view.state !== "OPEN") {
        // For the weekly retro's first-pass measure (STEP-3290): how many rounds it took, and whether anyone else committed to it.
        appendLedger(
          deps.paths,
          { type: "pr.closed", issue: pr.issue, url: pr.url, state: view.state, rounds: pr.revise?.rounds ?? 0, otherCommits: await othersCommits(deps.exec, pr.url) },
          deps.now(),
        )
        forgetWatchedPr(deps.paths, pr.url)
        continue
      }
      await reviseOwnPr(deps, pr, view, required)
    } catch (error) {
      // One PR's bad answer must not stop the watch of the others.
      deps.log.warn("PR not checked", { url: pr.url, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/**
 * The PR's commits by anyone but its author (the mini), or null when gh
 * cannot say. GitHub names a commit's authors by the login its email is
 * linked to: the mini's commits count as its own only while its git email
 * is on its GitHub account, and a commit whose email is on no account counts
 * as someone else's. A co-authored commit counts as the mini's when it is
 * one of the authors. The retro's first-pass measure takes null as none
 * (retro/metrics.ts), so a gh that could not answer never costs a first pass.
 */
export async function othersCommits(exec: Exec, url: string): Promise<number | null> {
  const r = await exec("gh", ["pr", "view", url, "--json", "author,commits"], { timeoutMs: GH_TIMEOUT_MS })
  if (r.code !== 0) return null
  try {
    const v = JSON.parse(r.stdout) as { author?: { login?: string }; commits?: Array<{ authors?: Array<{ login?: string }> }> }
    const author = v.author?.login
    if (!author) return null
    return (v.commits ?? []).filter((c) => !(c.authors ?? []).some((a) => a.login === author)).length
  } catch {
    return null
  }
}

export function linearDownNotice(
  state: { downSince: string | null; notified: boolean },
  ok: boolean,
  now: Date,
): { state: { downSince: string | null; notified: boolean }; message: string | null } {
  if (ok) return { state: { downSince: null, notified: false }, message: state.notified ? "Linear is reachable again." : null }
  const since = state.downSince ?? now.toISOString()
  if (!state.notified && now.getTime() - Date.parse(since) >= 15 * 60_000) {
    return {
      state: { downSince: since, notified: true },
      message: "Linear has been unreachable for 15 minutes. The worker keeps going, but claims are not refreshed until it is back.",
    }
  }
  return { state: { downSince: since, notified: state.notified }, message: null }
}

/** bridge.json as the bridge writes it every 30 seconds (slack/bridge.ts, bridgeStatus). */
export interface BridgeHeartbeat {
  at: string
  connected: boolean
  /** While the bridge runs: why its outbox is paused. After it stopped: why it stopped. */
  error?: string
  /** Written by the bridge's halt: it has exited, whatever `at` says. */
  stopped?: boolean
  outboxFailed?: number
}


/** A front door started this recently has not had its first wakeup yet, and is not late for it. */
export const STARTUP_GRACE_MINUTES = 10

export function healthStatus(input: {
  frontDoorAlive: boolean
  /** Its last tick, never its last start: a front door that restarts without ever waking must show up here. */
  lastWakeAt: Date | null
  /** Its last start: until STARTUP_GRACE_MINUTES after it, no wakeup is due (a reboot, a restart). */
  lastStartAt?: Date | null
  bridge: BridgeHeartbeat | null
  now: Date
  staleTickMinutes: number
  /** bridge.json's outboxFailed at the previous check. null: no earlier reading, so nothing is new. */
  outboxFailedBefore?: number | null
  /** Intakes the bridge has retried against Linear for over an hour (inboxStuck). */
  stuckInbox?: number
  /** People's messages the front door has not closed for over half an hour (inboxUnhandled). */
  unhandledInbox?: number
  /** The last checkout refresh's result. */
  checkout?: string | null
}): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const now = input.now.getTime()
  const wake = input.lastWakeAt?.getTime() ?? null
  const start = input.lastStartAt?.getTime() ?? null
  const starting = start !== null && (wake === null || wake < start) && now - start <= STARTUP_GRACE_MINUTES * 60_000
  if (!input.frontDoorAlive) problems.push("the front door is not running")
  else if (!starting && (wake === null || now - wake > input.staleTickMinutes * 60_000)) {
    problems.push(wake === null ? "the front door has never woken up" : `the front door has not woken up for ${Math.round((now - wake) / 60_000)} minutes`)
  }
  const bridge = input.bridge
  const fresh = bridge !== null && now - Date.parse(bridge.at) <= 3 * 60_000
  // A running bridge writes its heartbeat every 30 seconds, error or not: an
  // error with a fresh heartbeat is the outbox paused, not the bridge stopped.
  if (!bridge || !fresh || bridge.stopped) problems.push(bridge?.error ? `the Slack bridge stopped: ${bridge.error}` : "the Slack bridge has no recent heartbeat")
  else if (bridge.error) problems.push(`the Slack bridge's outbox is paused: ${bridge.error}`)
  else if (!bridge.connected) problems.push("the Slack bridge is disconnected")
  if (input.checkout === CHECKOUT_LEFT_ALONE) problems.push("the main checkout has local changes, so it is no longer kept on origin's base")
  const failed = bridge?.outboxFailed ?? 0
  const before = input.outboxFailedBefore
  // A message Slack refused for good goes to outbox/failed, and nothing else says so.
  if (before !== null && before !== undefined && failed > before) {
    problems.push(`Slack refused ${plural(failed - before, "more message", "more messages")} for good, kept in ~/.agentd/outbox/failed`)
  }
  if (input.stuckInbox) {
    problems.push(`${plural(input.stuckInbox, "Slack request has", "Slack requests have")} waited over an hour for Linear`)
  }
  if (input.unhandledInbox) {
    problems.push(`${plural(input.unhandledInbox, "person's Slack message has", "people's Slack messages have")} waited over 30 minutes for the front door`)
  }
  return { ok: problems.length === 0, problems }
}

type Waiting = { type?: string; issue?: string | null; receivedAt?: string }
const olderThan = (p: Waiting, now: Date, ms: number) => typeof p.receivedAt === "string" && now.getTime() - Date.parse(p.receivedAt) > ms

/**
 * Intakes the bridge is still retrying against Linear, received over an hour
 * ago. It gives up on each after a day of refusals: until then only this says
 * they wait.
 */
export function inboxStuck(paths: AgentPaths, now: Date): number {
  return listNew<Waiting>(paths.inbox).filter(({ payload: p }) => p.type === "intake" && !p.issue && olderThan(p, now, 60 * 60_000)).length
}

/**
 * People's replies and mentions the front door has not closed within half an
 * hour (STEP-3293 review). The Slack channel and the digest both offer every
 * one, so a message this old means neither reached a front door that acts:
 * Claude Code dropped the channel's pushes, or the front door cannot work.
 * "answer" is a reply filed before STEP-3293.
 */
export function inboxUnhandled(paths: AgentPaths, now: Date): number {
  return listNew<Waiting>(paths.inbox).filter(({ payload: p }) => ["reply", "mention", "answer"].includes(p.type ?? "") && olderThan(p, now, 30 * 60_000)).length
}

export function sentryCheckInUrl(base: string, ok: boolean): string {
  const url = new URL(base)
  url.searchParams.set("status", ok ? "ok" : "error")
  return url.toString()
}

/** The message a dirty checkout's refresh returns: health reports it, since /refine then reads a stale checkout. */
export const CHECKOUT_LEFT_ALONE = "left alone: the checkout has local changes"

/**
 * Moves a clean main checkout to the commit origin names for the base. The
 * commit comes from `ls-remote`, never from a ref under .git, origin/<base>
 * included: the worker can write refs there, and a checkout of its commit
 * would put its settings and hooks where every later session loads them.
 * SAFE_GIT's --no-replace-objects keeps a replace ref from swapping the tree.
 */
export async function refreshCheckout(exec: Exec, repo: string, base: string): Promise<string> {
  try {
    if (await isDirty(exec, repo)) return CHECKOUT_LEFT_ALONE
  } catch (error) {
    return `git status failed: ${error instanceof Error ? error.message : String(error)}`
  }
  const ref = `refs/heads/${base}`
  const remote = await git(exec, ["-C", repo, "ls-remote", "--exit-code", "origin", ref], { timeoutMs: 60_000 })
  if (remote.code !== 0) return `ls-remote failed: ${remote.stderr.trim()}`
  // The pattern matches ref tails too (refs/heads/x/refs/heads/staging): only the exact ref counts.
  const line = remote.stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find((parts) => parts[1] === ref)
  const sha = line?.[0] ?? ""
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return `origin named no commit for ${base}`
  const fetched = await git(exec, ["-C", repo, "fetch", "origin", base, "--prune"], { timeoutMs: 5 * 60_000 })
  if (fetched.code !== 0) return `fetch failed: ${fetched.stderr.trim()}`
  const moved = await git(exec, ["-C", repo, "checkout", "--detach", sha], { timeoutMs: 5 * 60_000 })
  return moved.code === 0 ? `up to date at ${sha.slice(0, 7)}` : `checkout failed: ${moved.stderr.trim()}`
}

function pruneOlderThan(dir: string, days: number, now: number, match: (name: string) => boolean = () => true): number {
  if (!existsSync(dir)) return 0
  let removed = 0
  for (const name of readdirSync(dir)) {
    if (!match(name)) continue
    const path = join(dir, name)
    if (now - statSync(path).mtimeMs > days * 86_400_000) {
      rmSync(path, { force: true })
      removed++
    }
  }
  return removed
}

export async function cleanup(deps: { paths: AgentPaths; config: AgentConfig; exec: Exec; now: () => Date }): Promise<{ removed: number }> {
  const now = deps.now().getTime()
  let removed = 0
  for (const dir of [join(deps.paths.inbox, "done"), join(deps.paths.outbox, "done")]) removed += pruneOlderThan(dir, 14, now)
  removed += pruneOlderThan(join(deps.paths.jobs, "done"), 30, now)
  // One log per job, never written again once it ends.
  removed += pruneOlderThan(deps.paths.logs, 30, now, (name) => name.startsWith("worker-") && name.endsWith(".log"))
  if (existsSync(deps.paths.logs)) {
    for (const name of readdirSync(deps.paths.logs)) {
      const path = join(deps.paths.logs, name)
      if (!name.endsWith(".1") && statSync(path).size > 20 * 1024 * 1024) renameSync(path, `${path}.1`)
    }
  }
  // What the weekly retro reads (STEP-3290): it looks back two weeks, and
  // compares with the last retro. A quarter is plenty, and the cap bounds a flood.
  removed += pruneJsonl(lessonsFile(deps.paths), { days: 90, max: 5000 }, deps.now())
  removed += pruneJsonl(retrosFile(deps.paths), { days: 90, max: 52 }, deps.now())
  const busy = listJobs(deps.paths, "running").map((j) => j.issue)
  // A retro's worktree (retro-<date>) is dev-tasks', beside the plugin, not the project's.
  const devTasks = dirname(deps.config.pluginRoot)
  if (existsSync(deps.paths.worktrees)) {
    for (const name of readdirSync(deps.paths.worktrees)) {
      const path = join(deps.paths.worktrees, name)
      if (busy.some((issue) => name === issue || name.startsWith(`${issue}-`))) continue
      if (now - statSync(path).mtimeMs <= 3 * 86_400_000) continue
      // Forced, as the runner removes its own: git's clean check would enter submodules.
      await removeWorktree(deps.exec, name.startsWith("retro-") ? devTasks : deps.config.repo.path, path)
      removed++
    }
  }
  await git(deps.exec, ["-C", deps.config.repo.path, "worktree", "prune"])
  return { removed }
}

/** Named intervals inside one loop. */
export class Every {
  private last = new Map<string, number>()
  constructor(private readonly clock: () => number) {}
  due(name: string, everyMs: number): boolean {
    const t = this.clock()
    const previous = this.last.get(name)
    if (previous !== undefined && t - previous < everyMs) return false
    this.last.set(name, t)
    return true
  }
}
