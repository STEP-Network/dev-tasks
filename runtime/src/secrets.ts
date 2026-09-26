/**
 * An agent mini's secrets live in chmod-600 env files, never in a plist, an
 * argv, a log line or a repository:
 *   ~/.config/linear/.env        LINEAR_API_KEY   (the plugin's linear-client reads it)
 *   ~/.config/agentd/slack.env   SLACK_BOT_TOKEN, SLACK_APP_TOKEN   (the bridge only)
 *   ~/.config/agentd/agentd.env  SENTRY_CRON_URL, optional   (agentd only)
 *   ~/.config/agentd/claude.env  CLAUDE_CODE_OAUTH_TOKEN, optional   (the worker only)
 *   ~/.config/agentd/monday.env  MONDAY_API_TOKEN, the coordinator mini only   (agentd only)
 *   ~/.config/agentd/usertest.env  TEST_LOGIN_SECRET, VERCEL_AUTOMATION_BYPASS_SECRET, optional
 *                                (the browser test's own code, never the browser or the model)
 *   ~/.config/agentd/recorder.env  RECORDER_LINEAR_KEY, optional, the coordinator mini only
 *                                (agentd only, for a person's lowering: lower.ts)
 *
 * The Monday token is the agent's own Monday user's, with access to the one
 * board (STEP-3289). It is never the admin's: the bridge refuses one.
 *
 * A file other users can read is refused, not warned about: the phase 0
 * rehearsal found the laptop's Linear file at 644, and a warning is what let
 * that stand. No message here ever contains a value.
 */

import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

export const linearKeyPath = (home: string) => join(home, ".config", "linear", ".env")
export const slackSecretsPath = (home: string) => join(home, ".config", "agentd", "slack.env")
export const userTestSecretsPath = (home: string) => join(home, ".config", "agentd", "usertest.env")
export const agentdSecretsPath = (home: string) => join(home, ".config", "agentd", "agentd.env")
export const claudeTokenPath = (home: string) => join(home, ".config", "agentd", "claude.env")
export const mondaySecretsPath = (home: string) => join(home, ".config", "agentd", "monday.env")
export const recorderSecretsPath = (home: string) => join(home, ".config", "agentd", "recorder.env")

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

/** The Monday bridge's token (STEP-3289): a personal API token, which Monday issues as a JWT. */
export function loadMondayToken(home: string): string {
  const path = mondaySecretsPath(home)
  return token(readSecretsFile(path), "MONDAY_API_TOKEN", "eyJ", path)
}

/**
 * The answer recorder's personal Linear API key (Wave 2, D1): the account
 * PolAds' Approval class check trusts with a lowering. Optional: no file, and
 * a class is lowered only in Linear. agentd reads it when a person's lowering
 * comes, and never hands it on.
 */
export function loadRecorderKey(home: string): string | null {
  const path = recorderSecretsPath(home)
  try {
    statSync(path)
  } catch {
    return null
  }
  return token(readSecretsFile(path), "RECORDER_LINEAR_KEY", "lin_api_", path)
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
 * The browser test's two secrets (WS5): the staging test-login route's shared
 * secret, and Vercel's protection bypass for the project's previews. Both are
 * optional. Without the first the test runs as a visitor who is not signed
 * in, without the second it cannot open a protected preview. Only the
 * runtime's own code reads them: the browser and the model never see either.
 * The first goes only to staging and the release candidate, never to a
 * preview (login.ts).
 */
export function loadUserTestSecrets(home: string): { testLoginSecret: string | null; bypassSecret: string | null } {
  const path = userTestSecretsPath(home)
  try {
    statSync(path)
  } catch {
    return { testLoginSecret: null, bypassSecret: null }
  }
  const values = readSecretsFile(path)
  return { testLoginSecret: values.TEST_LOGIN_SECRET || null, bypassSecret: values.VERCEL_AUTOMATION_BYPASS_SECRET || null }
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
