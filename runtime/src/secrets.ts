/**
 * An agent mini's secrets live in chmod-600 env files, never in a plist, an
 * argv, a log line or a repository:
 *   ~/.config/linear/.env        LINEAR_API_KEY   (the plugin's linear-client reads it)
 *   ~/.config/agentd/slack.env   SLACK_BOT_TOKEN, SLACK_APP_TOKEN   (the bridge only)
 *   ~/.config/agentd/agentd.env  SENTRY_CRON_URL, optional   (agentd only)
 *   ~/.config/agentd/claude.env  CLAUDE_CODE_OAUTH_TOKEN, optional   (the worker only)
 *
 * A file other users can read is refused, not warned about: the phase 0
 * rehearsal found the laptop's Linear file at 644, and a warning is what let
 * that stand. No message here ever contains a value.
 */

import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

export const linearKeyPath = (home: string) => join(home, ".config", "linear", ".env")
export const slackSecretsPath = (home: string) => join(home, ".config", "agentd", "slack.env")
export const agentdSecretsPath = (home: string) => join(home, ".config", "agentd", "agentd.env")
export const claudeTokenPath = (home: string) => join(home, ".config", "agentd", "claude.env")

export function readSecretsFile(path: string): Record<string, string> {
  let mode: number
  try {
    mode = statSync(path).mode
  } catch {
    throw new Error(`secrets: ${path} is missing. See docs/agent-mini-runbook.md, "Secrets".`)
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(`secrets: ${path} is readable by other users (mode ${(mode & 0o777).toString(8)}). Run: chmod 600 ${path}`)
  }
  const values: Record<string, string> = {}
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2")
  }
  return values
}

function token(values: Record<string, string>, name: string, prefix: string, path: string): string {
  const value = values[name]
  if (!value) throw new Error(`secrets: ${name} is missing from ${path}`)
  if (!value.startsWith(prefix)) throw new Error(`secrets: ${name} in ${path} is not a ${prefix} token`)
  return value
}

export function loadSlackSecrets(home: string): { botToken: string; appToken: string } {
  const path = slackSecretsPath(home)
  const values = readSecretsFile(path)
  return {
    botToken: token(values, "SLACK_BOT_TOKEN", "xoxb-", path),
    appToken: token(values, "SLACK_APP_TOKEN", "xapp-", path),
  }
}

/** The dead-man switch is optional: no file means no check-ins. */
export function loadSentryCronUrl(home: string): string | null {
  const path = agentdSecretsPath(home)
  try {
    statSync(path)
  } catch {
    return null
  }
  return readSecretsFile(path).SENTRY_CRON_URL || null
}

/**
 * Optional. If the Agent SDK does not pick up Claude Code's Keychain login for
 * the worker, `claude setup-token` makes a one-year token for the same
 * subscription. It is kept here and handed to the worker's environment only.
 */
export function loadClaudeOauthToken(home: string): string | null {
  const path = claudeTokenPath(home)
  try {
    statSync(path)
  } catch {
    return null
  }
  return readSecretsFile(path).CLAUDE_CODE_OAUTH_TOKEN || null
}

/**
 * The plugin reads the key itself (plugin/src/tracker/linear-client.ts); the
 * runtime checks the file at start, its mode and its line the way that client
 * reads it: the line that starts `LINEAR_API_KEY=`, and all of the rest of it,
 * quotes included, as the key.
 */
export function assertLinearKeyFile(home: string): void {
  if (process.env.LINEAR_API_KEY?.trim()) return
  const path = linearKeyPath(home)
  readSecretsFile(path)
  const line = readFileSync(path, "utf8").split("\n").find((l) => l.startsWith("LINEAR_API_KEY="))
  const key = line?.slice("LINEAR_API_KEY=".length).trim()
  if (!key) throw new Error(`secrets: LINEAR_API_KEY is missing from ${path}`)
  if (/^["']/.test(key)) throw new Error(`secrets: LINEAR_API_KEY in ${path} is quoted, and the plugin's Linear client would send the quotes. Remove them.`)
}
