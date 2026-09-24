/**
 * Develop jobs, one JSON file each: jobs/pending -> jobs/running -> jobs/done.
 * The front door submits (agentctl job submit), agentd starts one at a time,
 * the runner moves its own job to done. A move writes the destination before
 * removing the source, so a crash between the two leaves the job in both
 * places; agentd treats done as the truth (Task 13).
 */

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
