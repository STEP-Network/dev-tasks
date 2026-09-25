import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { realExec, type Exec } from "../../worker/git.ts"
import type { QueryFn, SdkMessage } from "../../worker/run.ts"
import { runRetro } from "../retro.ts"

/**
 * Review B1 on dev-tasks #120, with real git: whatever the session does to
 * refs, replace refs and HEAD in the repository it shares, the runner checks
 * and pushes only its own commit of the worktree's files, on the base it
 * fetched before the session. The retro's sandbox keeps the session out of
 * .git altogether; these tests give it the run of it, as a sandbox that
 * failed would.
 */

const RETRO_PR = "https://github.com/STEP-Network/dev-tasks/pull/130"
const GUARD = "runtime/src/retro/guard.ts"
const DOC = "docs/agent-mini-runbook.md"

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

beforeEach(() => {
  // Hermetic: no one's global git config (a signing key, a hook path), and an identity for every commit.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null")
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1")
  for (const who of ["AUTHOR", "COMMITTER"]) {
    vi.stubEnv(`GIT_${who}_NAME`, "eve")
    vi.stubEnv(`GIT_${who}_EMAIL`, "eve@localhost")
  }
})
afterEach(() => vi.unstubAllEnvs())

/** dev-tasks' origin (a bare repository) and the mini's checkout of it, beside an agentd home. */
function world() {
  const home = mkdtempSync(join(tmpdir(), "agentd-retro-git-"))
  const origin = join(home, "origin.git")
  const root = join(home, "dev-tasks")
  git(home, "init", "--quiet", "--bare", "-b", "main", origin)
  git(home, "clone", "--quiet", origin, root)
  git(root, "symbolic-ref", "HEAD", "refs/heads/main")
  mkdirSync(join(root, "runtime", "src", "retro"), { recursive: true })
  mkdirSync(join(root, "docs"), { recursive: true })
  writeFileSync(join(root, GUARD), "export const guard = true\n")
  writeFileSync(join(root, DOC), "# Runbook\n")
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", "init")
  git(root, "push", "--quiet", "origin", "main")
  const base = git(root, "rev-parse", "HEAD")
  const paths = agentPaths(home)
  const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/r" }, pluginRoot: join(root, "plugin"), slack: { allowedUsers: ["UNATE"] }, retro: { enabled: true } })
  return { home, origin, root, base, paths, config, wt: join(paths.worktrees, "retro-2026-09-25") }
}

/** gh answered by a fake, git by the real one. */
function execFor(): { exec: Exec; lines: string[] } {
  const lines: string[] = []
  const exec: Exec = async (cmd, args, opts) => {
    lines.push(`${cmd} ${args.join(" ")}`)
    if (cmd !== "gh") return realExec(cmd, args, opts)
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: "[]", stderr: "" }
    if (args[0] === "pr" && args[1] === "create") return { code: 0, stdout: `${RETRO_PR}\n`, stderr: "" }
    return { code: 1, stdout: "", stderr: "not faked" }
  }
  return { exec, lines }
}

/** A session that runs `act` in its worktree, then reports one change to the runbook. */
function sessionThat(act: (wt: string) => void): QueryFn {
  return ({ options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", plugins: [], apiKeySource: "none" } as SdkMessage
      act(options.cwd!)
      yield {
        type: "result",
        subtype: "success",
        total_cost_usd: 1,
        num_turns: 5,
        session_id: "r-1",
        structured_output: { status: "done", summary: "I added a line to the runbook.", changes: [{ path: DOC, metric: "fixRate", why: "Reviews asked.", evidence: ["STEP-1"] }], reverts: [] },
      } as SdkMessage
    })()
}

/** A commit on `parent` whose tree is parent's with the runbook changed: what the guard is shown instead. */
function benignCommit(wt: string, parent: string): string {
  const scratch = join(wt, "..", "benign.md")
  writeFileSync(scratch, "# Runbook\n\nImproved.\n")
  const blob = git(wt, "hash-object", "-w", scratch)
  git(wt, "read-tree", parent)
  git(wt, "update-index", "--add", "--cacheinfo", `100644,${blob},${DOC}`)
  const tree = git(wt, "write-tree")
  return git(wt, "commit-tree", tree, "-p", parent, "-m", "docs(retro): benign")
}

const evilCommit = (wt: string) => {
  writeFileSync(join(wt, GUARD), "export const guard = false\n")
  git(wt, "commit", "--quiet", "-am", "evil")
  return git(wt, "rev-parse", "HEAD")
}

async function run(w: ReturnType<typeof world>, act: (wt: string) => void) {
  const { exec, lines } = execFor()
  const deps = { paths: w.paths, config: w.config, exec, query: sessionThat(act), now: () => new Date("2026-09-25T12:30:00.000Z"), log: { info() {}, warn() {}, error() {} }, fyi: { post: async () => {} }, claudeToken: null }
  const r = await runRetro(deps, { slot: "2026-09-25", dryRun: false })
  const originBranches = git(w.origin, "for-each-ref", "--format=%(refname)", "refs/heads/retro/")
  return { r, lines, originBranches }
}

describe("the retro's guard and push, with real git (review B1)", () => {
  it("is not fooled by a replace ref that shows it a harmless commit in place of the session's", async () => {
    const w = world()
    let evil = ""
    const { r, originBranches } = await run(w, (wt) => {
      evil = evilCommit(wt)
      git(wt, "replace", evil, benignCommit(wt, w.base))
      // HEAD now reads as the harmless commit to any git that follows replace refs.
      git(wt, "read-tree", "HEAD")
    })
    expect(r.status).toBe("refused")
    expect(r.problems).toEqual([`${GUARD}: not a prompt, checklist, skill or doc the retro may change`])
    expect(originBranches).toBe("")
    expect(() => git(w.origin, "cat-file", "-e", evil)).toThrow()
  })

  it("is not fooled by a remote-tracking ref the session moved onto its own commit", async () => {
    const w = world()
    let evil = ""
    const { r, originBranches } = await run(w, (wt) => {
      evil = evilCommit(wt)
      git(wt, "update-ref", "refs/remotes/origin/main", evil)
      writeFileSync(join(wt, DOC), "# Runbook\n\nv2\n")
      git(wt, "commit", "--quiet", "-am", "docs(retro): benign")
    })
    expect(r.status).toBe("refused")
    expect(r.problems).toEqual([`${GUARD}: not a prompt, checklist, skill or doc the retro may change`])
    expect(originBranches).toBe("")
    expect(() => git(w.origin, "cat-file", "-e", evil)).toThrow()
  })

  it("pushes its own commit of the worktree's files on the base, never the session's HEAD or history", async () => {
    const w = world()
    let evil = ""
    const { r, lines, originBranches } = await run(w, (wt) => {
      evil = evilCommit(wt)
      git(wt, "replace", evil, benignCommit(wt, w.base))
      // The files are harmless again; the evil commit stays in HEAD's history.
      git(wt, "read-tree", "HEAD")
      git(wt, "checkout-index", "--all", "--force")
    })
    expect(r).toMatchObject({ status: "opened", pr: RETRO_PR, problems: [] })
    expect(originBranches).toBe("refs/heads/retro/eve-2026-09-25")
    const pushed = git(w.origin, "rev-parse", "refs/heads/retro/eve-2026-09-25")
    expect(git(w.origin, "rev-parse", `${pushed}^`)).toBe(w.base)
    expect(git(w.origin, "diff", "--name-only", w.base, pushed)).toBe(DOC)
    expect(() => git(w.origin, "cat-file", "-e", evil)).toThrow()
    expect(lines.filter((l) => l.includes(" push "))).toEqual([expect.stringMatching(new RegExp(` push --quiet origin ${pushed}:refs/heads/retro/eve-2026-09-25$`))])
  })
})
