/**
 * One Slack thread per issue (spec 6.5: two questions on one issue are one
 * thread). It is the #polads-intake thread an issue was filed from, or a
 * thread the bridge opens in #polads-questions for the first question or
 * report. One small file per issue, so no two processes rewrite a shared map.
 */

import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { AgentPaths } from "./config.ts"
import { readJson, writeJsonAtomic } from "./fsq.ts"

export interface ThreadRecord {
  issue: string
  channelId: string
  /** The ts of the thread's first message. */
  ts: string
  permalink: string | null
  createdAt: string
  lastQuestionAt: string | null
}

const fileFor = (paths: AgentPaths, issue: string) => join(paths.threads, `${issue}.json`)

export function threadFor(paths: AgentPaths, issue: string): ThreadRecord | null {
  return readJson<ThreadRecord>(fileFor(paths, issue))
}

export function saveThread(paths: AgentPaths, record: ThreadRecord): void {
  writeJsonAtomic(fileFor(paths, record.issue), record)
}

export function issueForThread(paths: AgentPaths, channelId: string, ts: string): string | null {
  if (!existsSync(paths.threads)) return null
  for (const name of readdirSync(paths.threads)) {
    if (!name.endsWith(".json")) continue
    const record = readJson<ThreadRecord>(join(paths.threads, name))
    if (record && record.channelId === channelId && record.ts === ts) return record.issue
  }
  return null
}
