/**
 * Test day's state, under ~/.agentd/state/testday: run.json (the current run,
 * one at a time), runs/<id>.json (finished runs), and <id>/ (the sessions'
 * result files and screenshots). One writer, agentd's controller; the bridges
 * only read.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { AgentPaths } from "../config.ts"
import { readJson, writeJsonAtomic } from "../fsq.ts"
import type { Checkpoint, TestDayRun } from "./types.ts"

export const testDayRoot = (paths: AgentPaths) => join(paths.state, "testday")
const runFile = (paths: AgentPaths) => join(testDayRoot(paths), "run.json")

export const readRun = (paths: AgentPaths): TestDayRun | null => readJson<TestDayRun>(runFile(paths))

export function saveRun(paths: AgentPaths, run: TestDayRun): void {
  writeJsonAtomic(runFile(paths), run)
}

/** A finished or stopped run leaves run.json for runs/, so the next start begins clean. */
export function archiveRun(paths: AgentPaths, run: TestDayRun): void {
  writeJsonAtomic(join(testDayRoot(paths), "runs", `${run.id}.json`), run)
  rmSync(runFile(paths), { force: true })
}

export function sessionDir(paths: AgentPaths, runId: string): string {
  const dir = join(testDayRoot(paths), runId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export const archivedRunExists = (paths: AgentPaths, id: string) => existsSync(join(testDayRoot(paths), "runs", `${id}.json`))

export const testDayKey = (id: string) => `testday-${id}`
/** A test day's own key (its Slack thread's issue): testday-<date>, with -2, -3 for a second run that day. */
export const isTestDayKey = (key: string) => /^testday-\d{4}-\d{2}-\d{2}(-\d+)?$/.test(key)

/** The checkpoint of this issue that failed and waits for "fix before release" or "next week". */
export function openDecisionFor(paths: AgentPaths, issue: string): Checkpoint | null {
  const run = readRun(paths)
  return run?.checkpoints.find((c) => c.issue === issue && c.decision && !c.decision.answer) ?? null
}
