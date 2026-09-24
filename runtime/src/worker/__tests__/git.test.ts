import { describe, expect, it } from "vitest"
import { fakeExec } from "../../__tests__/fakes.ts"
import { assertPushable, commitsAhead, isDirty, prepareWorktree, pushBranch, realExec, removeWorktree } from "../git.ts"

const OPTS = { repo: "/Users/eve/polads", worktreesDir: "/Users/eve/.agentd/worktrees", branch: "STEP-7-fix-the-date", base: "staging" }
const WT = "/Users/eve/.agentd/worktrees/STEP-7-fix-the-date"

describe("prepareWorktree", () => {
  it("cuts a new branch from origin/staging and installs", async () => {
    const f = fakeExec([[/ls-remote/, { code: 2 }]])
    expect(await prepareWorktree(f.exec, OPTS)).toEqual({ path: WT, resumed: false })
    expect(f.lines()).toContain(`git -C /Users/eve/polads worktree add -B STEP-7-fix-the-date ${WT} origin/staging`)
    expect(f.calls.at(-1)).toEqual({ line: "pnpm install --frozen-lockfile --prefer-offline", cwd: WT })
  })

  it("resumes the pushed branch when origin has it", async () => {
    const f = fakeExec([[/ls-remote/, { code: 0 }]])
    expect((await prepareWorktree(f.exec, OPTS)).resumed).toBe(true)
    expect(f.lines()).toContain("git -C /Users/eve/polads fetch origin STEP-7-fix-the-date")
    expect(f.lines()).toContain(`git -C /Users/eve/polads worktree add -B STEP-7-fix-the-date ${WT} origin/STEP-7-fix-the-date`)
  })

  it("stops at a failing step and names it", async () => {
    const f = fakeExec([[/ls-remote/, { code: 2 }], [/pnpm install/, { code: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE" }]])
    await expect(prepareWorktree(f.exec, OPTS)).rejects.toThrow(/pnpm install .* failed \(1\): ERR_PNPM_OUTDATED_LOCKFILE/)
  })
})

describe("assertPushable", () => {
  it("allows only the issue's own branch and never a protected one", () => {
    expect(() => assertPushable("STEP-7-fix-the-date", "STEP-7")).not.toThrow()
    for (const branch of ["staging", "main", "master", "production", "prod", "STEP-70-other", "feat/x"]) {
      expect(() => assertPushable(branch, "STEP-7"), branch).toThrow(/refusing to push/)
    }
  })
})

describe("pushBranch", () => {
  it("pushes the issue's own branch, and refuses any other before git runs", async () => {
    const f = fakeExec()
    await pushBranch(f.exec, WT, "STEP-7-fix-the-date", "STEP-7")
    expect(f.lines()).toEqual([`git -C ${WT} push -u origin HEAD:refs/heads/STEP-7-fix-the-date`])
    await expect(pushBranch(f.exec, WT, "staging", "STEP-7")).rejects.toThrow(/refusing to push staging/)
    expect(f.lines()).toHaveLength(1)
  })
})

describe("commitsAhead, isDirty and removeWorktree", () => {
  it("count from origin, never look inside a submodule, and remove by force once the runner has looked", async () => {
    const f = fakeExec([[/rev-list --count/, { stdout: "3\n" }], [/status --porcelain/, { stdout: " M lib/x.ts\n" }]])
    expect(await commitsAhead(f.exec, WT, "staging")).toBe(3)
    expect(await isDirty(f.exec, WT)).toBe(true)
    expect(await removeWorktree(f.exec, "/Users/eve/polads", WT)).toBe(true)
    expect(f.lines()).toEqual([
      `git -C ${WT} rev-list --count origin/staging..HEAD`,
      `git -C ${WT} status --porcelain --ignore-submodules=all`,
      `git -C /Users/eve/polads worktree remove --force ${WT}`,
    ])
  })
})

describe("realExec", () => {
  it("runs children with the mini's own gh login: no token in their environment (decision 5)", async () => {
    const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN }
    process.env.GH_TOKEN = "ghp_not_a_real_token"
    process.env.GITHUB_TOKEN = "ghp_not_a_real_token_either"
    try {
      const r = await realExec(process.execPath, ["-e", "process.stdout.write(JSON.stringify([process.env.GH_TOKEN ?? null, process.env.GITHUB_TOKEN ?? null, Boolean(process.env.PATH)]))"])
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual([null, null, true])
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it("reports a command that cannot start, with the reason", async () => {
    const r = await realExec("/nonexistent/agentd-tool", [])
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/ENOENT/)
  })
})
