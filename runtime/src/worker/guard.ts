/**
 * The worker's own last line of defence, independent of whether the plugin's
 * hooks load in an SDK session (Task 19 proves they do). Three kinds of ban:
 * what a worker never needs because the launcher does it (decision 2: push,
 * PR, merge), this machine's secrets, which it never reads (~/.config holds
 * the Linear key, the Slack tokens and the Claude token, and no task needs a
 * .env file), and the project's agent configuration, which runs outside the
 * sandbox. The sandbox (Task 12) refuses the same to Bash. The file tools run
 * outside it, so these checks are what holds them.
 */

import { realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const SECRETS = "Workers never read or write ~/.config or .env files: this machine's secrets live there, and no task needs them."
const AGENT_CONFIG_REASON =
  "Workers never change the project's agent configuration (.claude/hooks, .claude/settings*.json, .mcp.json): Claude Code runs and loads it outside the sandbox."

/**
 * Paths relative to a checkout's root that Claude Code runs (hooks) or loads
 * (settings, MCP servers) outside the sandbox. The runner also refuses to
 * resume a branch that changes one (git.ts).
 */
export const AGENT_CONFIG = /^(\.claude\/hooks(\/|$)|\.claude\/settings[^/]*\.json$|\.mcp\.json$)/

/** PolAds's tracked template holds no secret, and git stats every tracked file, so it is the one .env file allowed. */
export const ENV_TEMPLATE = ".env.example"

const BANS: Array<{ re: RegExp; reason: string }> = [
  // The sandbox's network allowlist (npm's registry only) is what stops a push
  // written some other way (`git -C x push`, a path to the binary): these
  // name the rule for the ordinary spelling.
  { re: /(^|[\s;&|(])git\s+push\b/, reason: "Workers never push. The launcher pushes your commits after you report." },
  { re: /(^|[\s;&|(])gh\s+pr\s+(create|merge)\b/, reason: "Workers never open or merge PRs. The launcher opens the PR and arms auto-merge." },
  { re: /--admin\b/, reason: "--admin is banned outright (spec section 11)." },
  // A path segment `.config` (so not jest.config.ts) and a `.env` file name
  // (so not process.env) other than the template. The sandbox refuses the
  // read itself: this says why.
  { re: /(^|[\s'"=:(<>|;&/~])\.config(?![\w-])/, reason: SECRETS },
  { re: /(^|[\s'"=:(<>|;&/])\.env(?!\.example(?![\w.-]))/, reason: SECRETS },
]

export function workerBashDenial(command: string): string | null {
  for (const ban of BANS) if (ban.re.test(command)) return ban.reason
  return null
}

export interface WorkerScope {
  /** The worker's own worktree: the only place its file tools write. */
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
/** Tools that walk a directory. Grep runs ripgrep with --hidden, so a search of home reads ~/.config. */
const SEARCHES = new Set(["Grep", "Glob", "LS"])

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

/** Grep's glob as the tool splits it: on whitespace, then on commas outside a {a,b} group. An exclusion (!x) narrows the search, so it is not checked. */
function grepGlobs(glob: string): string[] {
  const parts: string[] = []
  for (const piece of glob.split(/\s+/)) {
    if (piece.includes("{") && piece.includes("}")) parts.push(piece)
    else parts.push(...piece.split(","))
  }
  return parts.filter((p) => p && !p.startsWith("!"))
}

/**
 * Why a file tool's call is refused, or null. A relative path is taken from
 * `cwd`, the session's own directory (a hook's input carries it). Every path
 * is checked as written and as it resolves, so a symlink in the worktree
 * reaches neither ~/.config nor anywhere outside the worktree. A search is
 * refused when ~/.config lies inside what it would walk.
 */
export function workerPathDenial(toolName: string, input: unknown, scope: WorkerScope, cwd: string = scope.worktree): string | null {
  const fields = PATH_FIELDS[toolName]
  if (!fields || !input || typeof input !== "object") return null
  const config = join(scope.home, ".config")
  const configs = [config, join(real(scope.home), ".config"), real(config)]
  const worktree = real(scope.worktree)
  for (const field of fields) {
    const raw = (input as Record<string, unknown>)[field]
    if (typeof raw !== "string" || !raw) continue
    for (const value of toolName === "Grep" && field === "glob" ? grepGlobs(raw) : [raw]) {
      const expanded = value === "~" || value.startsWith("~/") ? join(scope.home, value.slice(1)) : value
      const written = resolve(cwd, expanded)
      const resolved = real(written)
      for (const path of [written, resolved]) {
        if (configs.some((dir) => within(path, dir) || (SEARCHES.has(toolName) && within(dir, path)))) return SECRETS
        if (path.split(sep).some((segment) => segment.startsWith(".env") && segment !== ENV_TEMPLATE)) return SECRETS
      }
      if (!WRITES.has(toolName)) continue
      if (!within(resolved, worktree)) return `Workers write only inside their worktree, ${scope.worktree}.`
      const inside = relative(worktree, resolved).split(sep)
      if (inside.includes(".git")) return "Workers never edit git's own files. Commit with git instead."
      if (AGENT_CONFIG.test(inside.join("/"))) return AGENT_CONFIG_REASON
    }
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
  /** The session's current directory, which a Bash `cd` can move. */
  cwd?: string
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
 * An SDK PreToolUse hook callback for every tool (Task 12), which answers only
 * the file tools. A hook sees every call: canUseTool only hears about the
 * ones that would prompt, and neither an edit acceptEdits allows nor a read
 * inside the worktree ever prompts.
 */
export function denyWorkerPaths(scope: WorkerScope) {
  return async (input: HookInputLike) => {
    if (input.hook_event_name !== "PreToolUse" || !input.tool_name) return {}
    const reason = workerPathDenial(input.tool_name, input.tool_input, scope, input.cwd || scope.worktree)
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
