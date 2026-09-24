/**
 * Develop jobs, one JSON file each: jobs/pending -> jobs/running -> jobs/done.
 * The front door submits (agentctl job submit), agentd starts one at a time,
 * the runner moves its own job to done. A move writes the destination before
 * removing the source, so a crash between the two leaves the job in both
 * places; agentd treats done as the truth (Task 13).
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { AgentPaths } from "./config.ts"
import { readJson, writeJsonAtomic } from "./fsq.ts"

export type JobState = "pending" | "running" | "done"

export interface JobResult {
  status: "done" | "needs_input" | "blocked" | "limited" | "skipped"
  reason: string
  prUrl: string | null
  branch: string | null
  costUsd: number | null
  turns: number | null
  minutes: number | null
}

export interface JobRecord {
  id: string
  issue: string
  kind: "develop"
  /** null: decided at run time from the issue's labels. */
  model: string | null
  submittedAt: string
  pid?: number
  startedAt?: string
  killRequestedAt?: string
  endedAt?: string
  result?: JobResult
  /** Set once `agentctl tick` has shown the finished job to the front door. */
  reported?: boolean
}

export const jobPath = (paths: AgentPaths, state: JobState, id: string) => join(paths.jobs, state, `${id}.json`)

export function listJobs(paths: AgentPaths, state: JobState): JobRecord[] {
  const dir = join(paths.jobs, state)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<JobRecord>(join(dir, f)))
    .filter((j): j is JobRecord => j !== null)
    .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
}

export function submitJob(paths: AgentPaths, issue: string, model: string | null, now: Date): JobRecord {
  for (const state of ["pending", "running"] as const) {
    if (listJobs(paths, state).some((j) => j.issue === issue)) throw new Error(`a job for ${issue} is already ${state}`)
  }
  const stamp = now.toISOString().replace(/[-:TZ]/g, "").slice(0, 14)
  const job: JobRecord = { id: `${issue}-${stamp}`, issue, kind: "develop", model, submittedAt: now.toISOString() }
  writeJsonAtomic(jobPath(paths, "pending", job.id), job)
  return job
}

/** false when the job is no longer in `from` (another process moved it first). */
export function moveJob(paths: AgentPaths, id: string, from: JobState, to: JobState, patch: Partial<JobRecord> = {}): boolean {
  const source = jobPath(paths, from, id)
  const job = readJson<JobRecord>(source)
  if (!job) return false
  writeJsonAtomic(jobPath(paths, to, id), { ...job, ...patch })
  rmSync(source, { force: true })
  return true
}

export function updateJob(paths: AgentPaths, state: JobState, id: string, patch: Partial<JobRecord>): void {
  const path = jobPath(paths, state, id)
  const job = readJson<JobRecord>(path)
  if (job) writeJsonAtomic(path, { ...job, ...patch })
}

/** PRs a worker opened, until they merge or close. agentd's PR watcher reads them (Task 14). */
export interface WatchedPr {
  issue: string
  url: string
  openedAt: string
  /** `<head sha>:<failing checks>` last reported, so one failure is reported once. */
  notified?: string
}

/**
 * One file per PR, in state/prs/, named by its URL's hash. The runner only
 * adds files (recordPr) and agentd's watcher only changes or removes the ones
 * it read, so neither process can drop the other's write, as two
 * read-change-write cycles of one shared list could.
 */
const watchedDir = (paths: AgentPaths) => join(paths.state, "prs")
const watchedFile = (paths: AgentPaths, url: string) => join(watchedDir(paths), `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.json`)

export function readWatchedPrs(paths: AgentPaths): WatchedPr[] {
  const dir = watchedDir(paths)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<WatchedPr>(join(dir, f)))
    .filter((p): p is WatchedPr => p !== null)
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt))
}

/** Starts watching a PR. A PR already watched keeps its record, `notified` included. */
export function recordPr(paths: AgentPaths, pr: WatchedPr): void {
  const file = watchedFile(paths, pr.url)
  if (!existsSync(file)) writeJsonAtomic(file, pr)
}

/** Rewrites a watched PR's record. One forgotten meanwhile stays forgotten. */
export function updateWatchedPr(paths: AgentPaths, pr: WatchedPr): void {
  const file = watchedFile(paths, pr.url)
  if (existsSync(file)) writeJsonAtomic(file, pr)
}

export function forgetWatchedPr(paths: AgentPaths, url: string): void {
  rmSync(watchedFile(paths, url), { force: true })
}
