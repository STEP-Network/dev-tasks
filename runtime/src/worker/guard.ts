/**
 * The worker's own last line of defence, independent of whether the plugin's
 * hooks load in an SDK session (Task 19 proves they do). Two kinds of ban:
 * what a worker never needs because the launcher does it (decision 2: push,
 * PR, merge), and this machine's secrets, which it never reads. ~/.config
 * holds the Linear key, the Slack tokens and the Claude token, and no task
 * needs a .env file. The sandbox (Task 12) refuses the same reads to Bash.
 * The file tools run outside it, so these checks are what holds them.
 */

import { realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const SECRETS = "Workers never read or write ~/.config or .env files: this machine's secrets live there, and no task needs them."

const BANS: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|[\s;&|(])git\s+push\b/, reason: "Workers never push. The launcher pushes your commits after you report." },
  { re: /(^|[\s;&|(])gh\s+pr\s+(create|merge)\b/, reason: "Workers never open or merge PRs. The launcher opens the PR and arms auto-merge." },
  { re: /--admin\b/, reason: "--admin is banned outright (spec section 11)." },
  // A path segment `.config` (so not jest.config.ts) and a `.env` file name
  // (so not process.env). The sandbox refuses the read itself: this says why.
  { re: /(^|[\s'"=:(<>|;&/~])\.config(?![\w-])/, reason: SECRETS },
  { re: /(^|[\s'"=:(<>|;&/])\.env/, reason: SECRETS },
]

export function workerBashDenial(command: string): string | null {
  for (const ban of BANS) if (ban.re.test(command)) return ban.reason
  return null
}

export interface WorkerScope {
  /** The worker's own worktree: its cwd, and the only place its file tools write. */
  worktree: string
  /** The machine user's home, whose ~/.config the worker never reads. */
  home: string
}

/** The fields that carry a path, per file tool. Grep's own `pattern` is a regex over contents, not a path. */
const PATH_FIELDS: Record<string, string[]> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Grep: ["path", "glob"],
  Glob: ["path", "pattern"],
  LS: ["path"],
}

const WRITES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

/** The file tools the PreToolUse hook is registered for (a matcher is a regex over the tool name). */
export const FILE_TOOL_MATCHER = `^(${Object.keys(PATH_FIELDS).join("|")})$`

/** Where a path really leads: symlinks resolved as far as the path exists. */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(real(parent), basename(path))
  }
}

function within(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
}

/**
 * Why a file tool's call is refused, or null. Every path is checked as
 * written and as it resolves, so a symlink in the worktree reaches neither
 * ~/.config nor anywhere outside the worktree.
 */
export function workerPathDenial(toolName: string, input: unknown, scope: WorkerScope): string | null {
  const fields = PATH_FIELDS[toolName]
  if (!fields || !input || typeof input !== "object") return null
  const configs = [join(scope.home, ".config"), join(real(scope.home), ".config")]
  const worktree = real(scope.worktree)
  for (const field of fields) {
    const raw = (input as Record<string, unknown>)[field]
    if (typeof raw !== "string" || !raw) continue
    const expanded = raw === "~" || raw.startsWith("~/") ? join(scope.home, raw.slice(1)) : raw
    const written = resolve(scope.worktree, expanded)
    const resolved = real(written)
    for (const path of [written, resolved]) {
      if (configs.some((dir) => within(path, dir))) return SECRETS
      if (path.split(sep).some((segment) => segment.startsWith(".env"))) return SECRETS
    }
    if (!WRITES.has(toolName)) continue
    if (!within(resolved, worktree)) return `Workers write only inside their worktree, ${scope.worktree}.`
    if (relative(worktree, resolved).split(sep).includes(".git")) return "Workers never edit git's own files. Commit with git instead."
  }
  return null
}

/** The same rules for any tool: what the worker's canUseTool names before it denies. */
export function workerToolDenial(toolName: string, input: unknown, scope: WorkerScope): string | null {
  if (toolName !== "Bash") return workerPathDenial(toolName, input, scope)
  const command = (input as { command?: unknown } | null)?.command
  return typeof command === "string" ? workerBashDenial(command) : null
}

interface HookInputLike {
  hook_event_name: string
  tool_name?: string
  tool_input?: unknown
}

function deny(reason: string) {
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason },
  }
}

/** An SDK PreToolUse hook callback (registered with matcher "Bash" in Task 12). */
export async function denyBannedBash(input: HookInputLike) {
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {}
  const command = String((input.tool_input as { command?: unknown } | undefined)?.command ?? "")
  const reason = workerBashDenial(command)
  return reason ? deny(reason) : {}
}

/**
 * The file tools' PreToolUse hook. A hook sees every call: canUseTool only
 * hears about the ones that would prompt, and acceptEdits never prompts for
 * an edit inside the worktree, nor any tool for a read.
 */
export function denyWorkerPaths(scope: WorkerScope) {
  return async (input: HookInputLike) => {
    if (input.hook_event_name !== "PreToolUse" || !input.tool_name) return {}
    const reason = workerPathDenial(input.tool_name, input.tool_input, scope)
    return reason ? deny(reason) : {}
  }
}

/**
 * Never billed to an API key or a cloud account (spec 1: subscriptions),
 * never holding a secret the worker does not need. The Monday key would let
 * the plugin's hooks write to Monday. The runner's own children (git, gh,
 * pnpm) get the same: gh then uses the mini's own login (decision 5).
 */
const DROP = /^(ANTHROPIC_[A-Z0-9_]+|CLAUDE_CODE_USE_[A-Z0-9_]+|LINEAR_API_KEY|MONDAY_API_KEY|SLACK_[A-Z0-9_]+|SENTRY_[A-Z0-9_]+|GH_TOKEN|GITHUB_TOKEN|DATABASE_URL)$/

export function workerEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !DROP.test(key)) env[key] = value
  return { ...env, ...extra }
}
