/**
 * git and gh for the runner, through an injected Exec so tests can read every
 * command. The runner is a plain Node process, outside the worker's hooks and
 * sandbox, so the push guard lives here in code. It pushes and opens PRs with
 * the mini's own gh login (decision 5): nothing it runs carries a token in its
 * arguments or its environment. Every git it runs turns git's replace refs,
 * hooks and fsmonitor off: the worker writes into the worktree and the shared
 * .git, and nothing it wrote may run outside the sandbox.
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { AGENT_CONFIG, workerEnv } from "./guard.ts"

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export type ExecOptions = { cwd?: string; timeoutMs?: number }

export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>

export const realExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      // A GH_TOKEN in the runner's own environment would win over the mini's gh login.
      { cwd: opts.cwd, env: workerEnv(process.env, {}), timeout: opts.timeoutMs ?? 15 * 60_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const exitCode = (error as { code?: unknown } | null)?.code
        const code = error ? (typeof exitCode === "number" ? exitCode : 1) : 0
        // A command that never started (ENOENT) or was killed says why only in the error.
        const why = error && typeof exitCode !== "number" ? error.message : ""
        resolve({ code, stdout: String(stdout), stderr: [String(stderr), why].filter(Boolean).join("\n") })
      },
    )
  })

function failed(command: string, r: ExecResult): Error {
  return new Error(`${command} failed (${r.code}): ${r.stderr.trim().slice(0, 500)}`)
}

export async function must(exec: Exec, cmd: string, args: string[], opts?: ExecOptions): Promise<string> {
  const r = await exec(cmd, args, opts)
  if (r.code !== 0) throw failed(`${cmd} ${args.join(" ")}`, r)
  return r.stdout
}

/**
 * Ahead of every git subcommand the runner and agentd run: no replace refs, no
 * hook and no fsmonitor, whatever a config or a ref says. The worker may write
 * <repo>/.git, refs/replace included, and git follows a replace ref by
 * default: `git replace <origin's commit> <its own>` would make every checkout
 * of origin's commit write the worker's tree. The option, not
 * core.useReplaceRefs, because an older git ignores a config key it does not know.
 */
export const SAFE_GIT = ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]

export function git(exec: Exec, args: string[], opts?: ExecOptions): Promise<ExecResult> {
  return exec("git", [...SAFE_GIT, ...args], opts)
}

/** git that must succeed. Its error names the command without the SAFE_GIT prefix, for people to read. */
export async function mustGit(exec: Exec, args: string[], opts?: ExecOptions): Promise<string> {
  const r = await git(exec, args, opts)
  if (r.code !== 0) throw failed(`git ${args.join(" ")}`, r)
  return r.stdout
}

const PROTECTED = new Set(["staging", "main", "master", "production", "prod"])

/** The runner pushes only the issue's own STEP-<n>-<slug> branch, never a protected one. */
export function assertPushable(branch: string, issueId: string): void {
  const own = branch === issueId || branch.startsWith(`${issueId}-`)
  if (PROTECTED.has(branch) || !own) {
    throw new Error(`refusing to push ${branch}: a worker branch is ${issueId}-<slug> and never a protected branch`)
  }
}

export interface WorktreeOptions {
  repo: string
  worktreesDir: string
  branch: string
  base: string
  /** A revise job: the branch as origin has it, since a person may have pushed to the PR. */
  fromOrigin?: boolean
}

/** What a person must look at before a worker may continue, as opposed to a step that failed. The message is the reason. */
export class WorktreeRefused extends Error {}

/**
 * Where the branch starts: its own local commits when any never reached
 * origin (a push that failed, a runner that died before it pushed), else
 * origin's copy of the branch, else the base. So `checkout -B` below never
 * resets a branch past a commit that exists nowhere else.
 */
async function startPoint(exec: Exec, o: WorktreeOptions): Promise<string> {
  const remote = await git(exec, ["-C", o.repo, "ls-remote", "--exit-code", "--heads", "origin", o.branch])
  // 0: origin has the branch. 2: it does not. Anything else: git could not ask.
  if (remote.code !== 0 && remote.code !== 2) throw failed(`git ls-remote --exit-code --heads origin ${o.branch}`, remote)
  const onOrigin = remote.code === 0
  if (onOrigin) await mustGit(exec, ["-C", o.repo, "fetch", "origin", o.branch])
  if (o.fromOrigin) {
    if (!onOrigin) throw new WorktreeRefused(`origin has no branch ${o.branch} to revise`)
    return `origin/${o.branch}`
  }
  const local = await git(exec, ["-C", o.repo, "rev-parse", "--verify", "--quiet", `refs/heads/${o.branch}`])
  if (local.code === 0) {
    const elsewhere = [`origin/${o.base}`, ...(onOrigin ? [`origin/${o.branch}`] : [])]
    const unpushed = Number.parseInt((await mustGit(exec, ["-C", o.repo, "rev-list", "--count", `refs/heads/${o.branch}`, "--not", ...elsewhere])).trim(), 10) || 0
    if (unpushed > 0) return `refs/heads/${o.branch}`
  }
  return onOrigin ? `origin/${o.branch}` : `origin/${o.base}`
}

/**
 * Files that rewrite history as git reads it, which no option turns off here
 * and the worker's sandbox may write: a graft can make origin's tip a child
 * of the worker's commit and empty the diff that the resume check reads.
 */
const HISTORY_REWRITES = [join("info", "grafts"), "shallow"]

/** The first history-rewriting file the repository has, as a path under .git, or null. */
export function historyRewrite(repo: string): string | null {
  return HISTORY_REWRITES.find((file) => existsSync(join(repo, ".git", file))) ?? null
}

export async function prepareWorktree(exec: Exec, o: WorktreeOptions): Promise<{ path: string; resumed: boolean }> {
  const found = historyRewrite(o.repo)
  if (found) {
    throw new WorktreeRefused(`the repository has .git/${found}, which can hide what a branch changes, so a person must look at it before a worker runs here`)
  }
  const path = join(o.worktreesDir, o.branch)
  await mustGit(exec, ["-C", o.repo, "fetch", "origin", o.base, "--prune"])
  // A leftover from an earlier run of this issue. Its commits live on in the
  // branch ref, which startPoint keeps; only uncommitted changes are lost, as
  // the brief says. Forced, so git does not look inside it.
  await git(exec, ["-C", o.repo, "worktree", "remove", "--force", path])
  await mustGit(exec, ["-C", o.repo, "worktree", "prune"])
  const start = await startPoint(exec, o)
  const resumed = start !== `origin/${o.base}`
  if (resumed) {
    // Earlier work is a worker's, pushed with no review, and the session runs
    // the project's hooks outside the sandbox.
    const touched = (await mustGit(exec, ["-C", o.repo, "diff", "--name-only", `origin/${o.base}...${start}`]))
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => AGENT_CONFIG.test(f))
    if (touched.length) {
      throw new WorktreeRefused(`the branch changes the agent configuration (${touched.join(", ")}), so a person must review it before a worker continues it`)
    }
  }
  // Installed at the base, which people reviewed: pnpm runs the project's own
  // scripts, and this runs outside the sandbox. The branch's own dependency
  // changes the worker installs itself, inside it (workerRules).
  await mustGit(exec, ["-C", o.repo, "worktree", "add", "--detach", path, `origin/${o.base}`])
  await must(exec, "pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: path, timeoutMs: 20 * 60_000 })
  await mustGit(exec, ["-C", path, "checkout", "-B", o.branch, start])
  return { path, resumed }
}

export async function commitsAhead(exec: Exec, path: string, base: string, o: { firstParent?: boolean } = {}): Promise<number> {
  const args = ["-C", path, "rev-list", "--count", `origin/${base}..HEAD`, ...(o.firstParent ? ["--first-parent"] : [])]
  return Number.parseInt((await mustGit(exec, args)).trim(), 10) || 0
}

/**
 * Starts merging origin's copy of `base` into the worktree's branch, for a
 * revise round whose PR clashes with it (STEP-3340). Here, outside the
 * sandbox: the merge writes every file the base changed, the agent
 * configuration included, which the sandbox keeps read-only. None of those
 * conflicts: prepareWorktree refuses a branch that changes one. A clean merge
 * is committed. Otherwise the conflicted files are left marked, and named,
 * for the worker to resolve and commit. A merge, never a rebase: the branch
 * is on origin, and its push is never forced.
 */
export async function startMerge(exec: Exec, path: string, base: string): Promise<{ conflicts: string[] }> {
  const merge = ["-C", path, "merge", "--no-ff", "--no-edit", `origin/${base}`]
  const r = await git(exec, merge)
  const unmerged = await mustGit(exec, ["-C", path, "diff", "--name-only", "--diff-filter=U"])
  const conflicts = unmerged.split("\n").map((f) => f.trim()).filter(Boolean)
  if (r.code !== 0 && !conflicts.length) throw failed(`git ${merge.join(" ")}`, r)
  return { conflicts }
}

/**
 * Of `files`, those that still differ from origin's copy of `base`: what a
 * round changed itself, not what merging the base in brought (STEP-3340).
 */
export async function ownChanges(exec: Exec, path: string, base: string, files: readonly string[]): Promise<string[]> {
  const out = await mustGit(exec, ["-C", path, "diff", "--name-only", `origin/${base}`, "HEAD"])
  const differs = new Set(out.split("\n").map((f) => f.trim()).filter(Boolean))
  return files.filter((f) => differs.has(f))
}

/** The files the branch changes against origin's copy of `base`. */
export async function changedFiles(exec: Exec, path: string, base: string): Promise<string[]> {
  const out = await mustGit(exec, ["-C", path, "diff", "--name-only", `origin/${base}...HEAD`])
  return out.split("\n").map((f) => f.trim()).filter(Boolean)
}

/** The branch's own commits, newest first: each one's subject and body. */
export async function commitMessages(exec: Exec, path: string, base: string): Promise<Array<{ subject: string; body: string }>> {
  // Unit and record separators: a commit message never holds either.
  const out = await mustGit(exec, ["-C", path, "log", "--format=%s%x1f%b%x1e", `origin/${base}..HEAD`])
  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.includes("\x1f"))
    .map((record) => {
      const [subject, body] = record.split("\x1f")
      return { subject: subject.trim(), body: (body ?? "").trim() }
    })
}

/**
 * Submodules are never entered: git would run itself inside one with that
 * repository's own config, which the worker could have written, and this runs
 * outside the sandbox.
 */
export async function isDirty(exec: Exec, path: string): Promise<boolean> {
  return (await mustGit(exec, ["-C", path, "status", "--porcelain", "--ignore-submodules=all"])).trim().length > 0
}

export async function pushBranch(exec: Exec, path: string, branch: string, issueId: string): Promise<void> {
  assertPushable(branch, issueId)
  await mustGit(exec, ["-C", path, "push", "-u", "origin", `HEAD:refs/heads/${branch}`])
}

/**
 * Forced, so git skips its own cleanliness check, which does enter submodules.
 * The caller has already looked (isDirty) and keeps a dirty worktree for a
 * person; agentd clears it after three days.
 */
export async function removeWorktree(exec: Exec, repo: string, path: string): Promise<boolean> {
  return (await git(exec, ["-C", repo, "worktree", "remove", "--force", path])).code === 0
}
