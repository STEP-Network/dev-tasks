/**
 * The latest browser test of each PR (WS5), one file per PR in
 * state/usertest/, named by the URL's hash. The worker writes it, agentd's PR
 * watcher only reads it, so neither can drop the other's write.
 */
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { AgentPaths } from "../config.ts"
import { readJson, writeJsonAtomic } from "../fsq.ts"

export type UserTestVerdict = "pass" | "findings" | "skipped" | "error"

/** The revise reason agentd gives a round the browser test's findings brought back. */
export const BROWSER_TEST_REASON = "the browser test found problems"

export interface UserTestState {
  issue: string
  url: string
  head: string
  verdict: UserTestVerdict
  /** Blockers and major findings, one line each. */
  findings: string[]
  at: string
}

const file = (paths: AgentPaths, url: string) => join(paths.state, "usertest", `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.json`)

export function saveUserTestState(paths: AgentPaths, state: UserTestState): void {
  mkdirSync(join(paths.state, "usertest"), { recursive: true })
  writeJsonAtomic(file(paths, state.url), state)
}

export function readUserTestState(paths: AgentPaths, url: string): UserTestState | null {
  return readJson<UserTestState>(file(paths, url))
}
