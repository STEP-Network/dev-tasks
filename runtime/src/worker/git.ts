/**
 * git and gh for the runner, through an injected Exec so tests can read every
 * command. The runner is a plain Node process, outside the worker's hooks and
 * sandbox, so the push guard lives here in code. It pushes and opens PRs with
 * the mini's own gh login (decision 5): nothing it runs carries a token in its
 * arguments or its environment.
 */

import { execFile } from "node:child_process"
import { join } from "node:path"
import { workerEnv } from "./guard.ts"

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>

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

export async function must(exec: Exec, cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<string> {
  const r = await exec(cmd, args, opts)
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.code}): ${r.stderr.trim().slice(0, 500)}`)
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
}

export async function prepareWorktree(exec: Exec, o: WorktreeOptions): Promise<{ path: string; resumed: boolean }> {
  const path = join(o.worktreesDir, o.branch)
  await must(exec, "git", ["-C", o.repo, "fetch", "origin", o.base, "--prune"])
  // A leftover from an earlier run of this issue. Its commits were pushed, or
  // live on in the branch ref; only uncommitted changes are lost, as the brief says.
  await exec("git", ["-C", o.repo, "worktree", "remove", "--force", path])
  await must(exec, "git", ["-C", o.repo, "worktree", "prune"])
  const remote = await exec("git", ["-C", o.repo, "ls-remote", "--exit-code", "--heads", "origin", o.branch])
  const resumed = remote.code === 0
  if (resumed) await must(exec, "git", ["-C", o.repo, "fetch", "origin", o.branch])
  await must(exec, "git", ["-C", o.repo, "worktree", "add", "-B", o.branch, path, resumed ? `origin/${o.branch}` : `origin/${o.base}`])
  await must(exec, "pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: path, timeoutMs: 20 * 60_000 })
  return { path, resumed }
}

export async function commitsAhead(exec: Exec, path: string, base: string): Promise<number> {
  return Number.parseInt((await must(exec, "git", ["-C", path, "rev-list", "--count", `origin/${base}..HEAD`])).trim(), 10) || 0
}

/**
 * Submodules are never entered: git would run itself inside one with that
 * repository's own config, which the worker could have written, and this runs
 * outside the sandbox.
 */
export async function isDirty(exec: Exec, path: string): Promise<boolean> {
  return (await must(exec, "git", ["-C", path, "status", "--porcelain", "--ignore-submodules=all"])).trim().length > 0
}

export async function pushBranch(exec: Exec, path: string, branch: string, issueId: string): Promise<void> {
  assertPushable(branch, issueId)
  await must(exec, "git", ["-C", path, "push", "-u", "origin", `HEAD:refs/heads/${branch}`])
}

/**
 * Forced, so git skips its own cleanliness check, which does enter submodules.
 * The caller has already looked (isDirty) and keeps a dirty worktree for a
 * person; agentd clears it after three days.
 */
export async function removeWorktree(exec: Exec, repo: string, path: string): Promise<boolean> {
  return (await exec("git", ["-C", repo, "worktree", "remove", "--force", path])).code === 0
}
