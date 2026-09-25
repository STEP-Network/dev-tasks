/**
 * JSON-lines logs, one file per process under ~/.agentd/logs, and the ledger
 * (ledger.jsonl): one line per thing worth counting (claimed, worker.end,
 * pr.opened, question.asked, answer.applied, released, frontdoor.start).
 * `agentctl report` reads the ledger. Token-shaped strings never reach disk.
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { AgentPaths } from "./config.ts"

// Slack, Linear and Claude tokens, and GitHub's: the runner pushes with the
// mini's own gh login (decision 5), and a remote URL in a git error can carry one.
// And Monday's, a JWT, which the Monday bridge holds (STEP-3289).
const TOKEN_RE =
  /\b(xox[abpr]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+|lin_api_[A-Za-z0-9]+|sk-ant-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+)/g

export function redact(text: string): string {
  return text.replace(TOKEN_RE, "[redacted]")
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

export function createLogger(paths: AgentPaths, name: string, now: () => Date = () => new Date()): Logger {
  mkdirSync(paths.logs, { recursive: true })
  const file = join(paths.logs, `${name}.log`)
  const write = (level: string, msg: string, fields: Record<string, unknown> = {}) => {
    appendFileSync(file, redact(JSON.stringify({ at: now().toISOString(), level, proc: name, msg, ...fields })) + "\n")
  }
  return {
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  }
}

export type LedgerEvent = { type: string; issue?: string } & Record<string, unknown>

export function appendLedger(paths: AgentPaths, event: LedgerEvent, now: Date = new Date()): void {
  mkdirSync(paths.logs, { recursive: true })
  appendFileSync(join(paths.logs, "ledger.jsonl"), redact(JSON.stringify({ at: now.toISOString(), ...event })) + "\n")
}
