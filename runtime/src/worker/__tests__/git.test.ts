import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { fakeExec } from "../../__tests__/fakes.ts"
import { execFileSync } from "node:child_process"
import { assertPushable, changedFiles, commitMessages, commitsAhead, conflictMarkers, isDirty, leftoverMarkers, ownChanges, prepareWorktree, pushBranch, realExec, removeWorktree, startMerge, WorktreeRefused } from "../git.ts"

const OPTS = { repo: "/Users/eve/polads", worktreesDir: "/Users/eve/.agentd/worktrees", branch: "STEP-7-fix-the-date", base: "staging" }
const WT = "/Users/eve/.agentd/worktrees/STEP-7-fix-the-date"
/** Every git the runner runs: no replace refs, no hook and no fsmonitor, whatever a config or ref the worker wrote says. */
const GIT = "git --no-replace-objects -c core.hooksPath=/dev/null -c core.fsmonitor=false"

const ABSENT = [/ls-remote/, { code: 2 }] as const
const PRESENT = [/ls-remote/, { code: 0 }] as const
const NO_LOCAL = [/rev-parse --verify/, { code: 1 }] as const
const LOCAL = [/rev-parse --verify/, { code: 0, stdout: "abc123\n" }] as const

describe("prepareWorktree", () => {
  it("refuses a repository with grafts or a shallow list, which can hide what a branch changes, before any git runs", async () => {
    for (const file of [["info", "grafts"], ["shallow"]]) {
      const repo = mkdtempSync(join(tmpdir(), "prepare-graft-"))
      mkdirSync(join(repo, ".git", "info"), { recursive: true })
      writeFileSync(join(repo, ".git", ...file), "")
      const f = fakeExec([[...ABSENT], [...NO_LOCAL]])
      const refused = prepareWorktree(f.exec, { ...OPTS, repo })
      await expect(refused).rejects.toBeInstanceOf(WorktreeRefused)
      await expect(refused).rejects.toThrow(`the repository has .git/${file.join("/")}, which can hide what a branch changes, so a person must look at it before a worker runs here`)
      expect(f.lines()).toEqual([])
    }
  })

  it("cuts a new branch from origin/staging, installs there, then checks the branch out", async () => {
    const f = fakeExec([[...ABSENT], [...NO_LOCAL]])
    expect(await prepareWorktree(f.exec, OPTS)).toEqual({ path: WT, resumed: false })
    const lines = f.lines()
    expect(lines).toContain(`${GIT} -C /Users/eve/polads worktree add --detach ${WT} origin/staging`)
    const install = f.calls.findIndex((c) => c.line === "pnpm install --frozen-lockfile --prefer-offline" && c.cwd === WT)
    expect(install).toBeGreaterThan(-1)
    expect(lines.at(-1)).toBe(`${GIT} -C ${WT} checkout -B STEP-7-fix-the-date origin/staging`)
    expect(lines.some((l) => l.includes("diff --name-only"))).toBe(false)
  })

  it("resumes the pushed branch, installing at the base first so none of its unreviewed scripts run outside the sandbox", async () => {
    const f = fakeExec([[...PRESENT], [...NO_LOCAL]])
    expect(await prepareWorktree(f.exec, OPTS)).toEqual({ path: WT, resumed: true })
    const lines = f.lines()
    expect(lines).toContain(`${GIT} -C /Users/eve/polads fetch origin STEP-7-fix-the-date`)
    expect(lines).toContain(`${GIT} -C /Users/eve/polads diff --name-only origin/staging...origin/STEP-7-fix-the-date`)
    expect(lines).toContain(`${GIT} -C /Users/eve/polads worktree add --detach ${WT} origin/staging`)
    const install = lines.indexOf("pnpm install --frozen-lockfile --prefer-offline")
    const checkout = lines.indexOf(`${GIT} -C ${WT} checkout -B STEP-7-fix-the-date origin/STEP-7-fix-the-date`)
    expect(install).toBeGreaterThan(-1)
    expect(checkout).toBeGreaterThan(install)
  })

  it("refuses to resume a branch that changes the agent configuration, before anything is checked out or installed", async () => {
    const f = fakeExec([[...PRESENT], [...NO_LOCAL], [/diff --name-only/, { stdout: ".claude/hooks/e2e-gate-guard.sh\nlib/x.ts\n.mcp.json\n" }]])
    const refused = prepareWorktree(f.exec, OPTS)
    await expect(refused).rejects.toBeInstanceOf(WorktreeRefused)
    await expect(refused).rejects.toThrow(
      "the branch changes the agent configuration (.claude/hooks/e2e-gate-guard.sh, .mcp.json), so a person must review it before a worker continues it",
    )
    expect(f.lines().some((l) => l.includes("worktree add") || l.startsWith("pnpm"))).toBe(false)
  })

  it("counts .claude/settings files as agent configuration, and the rest of .claude not", async () => {
    const settings = fakeExec([[...PRESENT], [...NO_LOCAL], [/diff --name-only/, { stdout: ".claude/settings.local.json\n" }]])
    await expect(prepareWorktree(settings.exec, OPTS)).rejects.toThrow(/agent configuration \(\.claude\/settings\.local\.json\)/)
    const rules = fakeExec([[...PRESENT], [...NO_LOCAL], [/diff --name-only/, { stdout: ".claude/rules/copy.md\n" }]])
    expect((await prepareWorktree(rules.exec, OPTS)).resumed).toBe(true)
  })

  it("continues from local commits that never reached origin, so checkout -B never resets past them", async () => {
    const f = fakeExec([[...ABSENT], [...LOCAL], [/rev-list --count refs\/heads/, { stdout: "2\n" }]])
    expect(await prepareWorktree(f.exec, OPTS)).toEqual({ path: WT, resumed: true })
    expect(f.lines()).toContain(`${GIT} -C /Users/eve/polads rev-list --count refs/heads/STEP-7-fix-the-date --not origin/staging`)
    expect(f.lines()).toContain(`${GIT} -C /Users/eve/polads diff --name-only origin/staging...refs/heads/STEP-7-fix-the-date`)
    expect(f.lines().at(-1)).toBe(`${GIT} -C ${WT} checkout -B STEP-7-fix-the-date refs/heads/STEP-7-fix-the-date`)
  })

  it("takes origin's branch for a revise job, a person's pushes included, whatever a local branch holds (STEP-3274)", async () => {
    const f = fakeExec([[...PRESENT], [...LOCAL], [/rev-list --count refs\/heads/, { stdout: "3\n" }]])
    expect(await prepareWorktree(f.exec, { ...OPTS, fromOrigin: true })).toEqual({ path: WT, resumed: true })
    expect(f.lines().at(-1)).toBe(`${GIT} -C ${WT} checkout -B STEP-7-fix-the-date origin/STEP-7-fix-the-date`)
    const gone = fakeExec([[...ABSENT]])
    await expect(prepareWorktree(gone.exec, { ...OPTS, fromOrigin: true })).rejects.toThrow("origin has no branch STEP-7-fix-the-date to revise")
  })

  it("weighs local commits against origin's copy of the branch too", async () => {
    const ahead = fakeExec([[...PRESENT], [...LOCAL], [/rev-list --count refs\/heads/, { stdout: "1\n" }]])
    await prepareWorktree(ahead.exec, OPTS)
    expect(ahead.lines()).toContain(`${GIT} -C /Users/eve/polads rev-list --count refs/heads/STEP-7-fix-the-date --not origin/staging origin/STEP-7-fix-the-date`)
    expect(ahead.lines().at(-1)).toBe(`${GIT} -C ${WT} checkout -B STEP-7-fix-the-date refs/heads/STEP-7-fix-the-date`)
    const pushed = fakeExec([[...PRESENT], [...LOCAL], [/rev-list --count refs\/heads/, { stdout: "0\n" }]])
    await prepareWorktree(pushed.exec, OPTS)
    expect(pushed.lines().at(-1)).toBe(`${GIT} -C ${WT} checkout -B STEP-7-fix-the-date origin/STEP-7-fix-the-date`)
    const stale = fakeExec([[...ABSENT], [...LOCAL], [/rev-list --count refs\/heads/, { stdout: "0\n" }]])
    expect((await prepareWorktree(stale.exec, OPTS)).resumed).toBe(false)
    expect(stale.lines().at(-1)).toBe(`${GIT} -C ${WT} checkout -B STEP-7-fix-the-date origin/staging`)
  })

  it("treats an ls-remote that could not ask as a failure, never as a branch origin lacks", async () => {
    const f = fakeExec([[/ls-remote/, { code: 128, stderr: "fatal: unable to access 'https://github.com/'" }]])
    await expect(prepareWorktree(f.exec, OPTS)).rejects.toThrow(/ls-remote --exit-code --heads origin STEP-7-fix-the-date failed \(128\): fatal: unable to access/)
    expect(f.lines().some((l) => l.includes("worktree add"))).toBe(false)
  })

  it("stops at a failing step and names it", async () => {
    const f = fakeExec([[...ABSENT], [...NO_LOCAL], [/pnpm install/, { code: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE" }]])
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
    expect(f.lines()).toEqual([`${GIT} -C ${WT} push -u origin HEAD:refs/heads/STEP-7-fix-the-date`])
    await expect(pushBranch(f.exec, WT, "staging", "STEP-7")).rejects.toThrow(/refusing to push staging/)
    expect(f.lines()).toHaveLength(1)
  })

  it("names a failed push without the safety prefix", async () => {
    const f = fakeExec([[/ push /, { code: 1, stderr: "rejected: non-fast-forward" }]])
    await expect(pushBranch(f.exec, WT, "STEP-7-fix-the-date", "STEP-7")).rejects.toThrow(
      `git -C ${WT} push -u origin HEAD:refs/heads/STEP-7-fix-the-date failed (1): rejected: non-fast-forward`,
    )
  })
})

describe("commitsAhead, isDirty and removeWorktree", () => {
  it("count from origin, never look inside a submodule, and remove by force once the runner has looked", async () => {
    const f = fakeExec([[/rev-list --count/, { stdout: "3\n" }], [/status --porcelain/, { stdout: " M lib/x.ts\n" }]])
    expect(await commitsAhead(f.exec, WT, "staging")).toBe(3)
    expect(await isDirty(f.exec, WT)).toBe(true)
    expect(await removeWorktree(f.exec, "/Users/eve/polads", WT)).toBe(true)
    expect(f.lines()).toEqual([
      `${GIT} -C ${WT} rev-list --count origin/staging..HEAD`,
      `${GIT} -C ${WT} status --porcelain --ignore-submodules=all`,
      `${GIT} -C /Users/eve/polads worktree remove --force ${WT}`,
    ])
  })
})

describe("startMerge, commitsAhead by first parent and ownChanges (STEP-3340)", () => {
  const repoWith = () => {
    const repo = mkdtempSync(join(tmpdir(), "start-merge-"))
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString()
    const write = (file: string, text: string) => writeFileSync(join(repo, file), text)
    execFileSync("git", ["init", "-q", "-b", "staging", repo])
    git("config", "user.name", "t")
    git("config", "user.email", "t@localhost")
    write("a.ts", "one\n")
    git("add", ".")
    git("commit", "-q", "-m", "base")
    git("checkout", "-q", "-b", "STEP-7-x")
    write("a.ts", "the PR's\n")
    git("commit", "-q", "-am", "feat: the PR (STEP-7)")
    git("update-ref", "refs/remotes/origin/STEP-7-x", "HEAD")
    git("checkout", "-q", "staging")
    write("b.test.ts", "staging's test\n")
    git("add", ".")
    git("commit", "-q", "-m", "staging moves on")
    return { repo, git, write }
  }

  it("leaves a clash marked and named for the worker, and a merge commit counts once", async () => {
    const { repo, git, write } = repoWith()
    write("a.ts", "staging's\n")
    git("commit", "-q", "-am", "staging changes the same line")
    git("update-ref", "refs/remotes/origin/staging", "HEAD")
    git("checkout", "-q", "STEP-7-x")
    expect(await startMerge(realExec, repo, "staging")).toEqual({ conflicts: ["a.ts"] })
    write("a.ts", "the PR's, and staging's\n")
    git("add", "a.ts")
    git("commit", "-q", "--no-edit")
    expect(await commitsAhead(realExec, repo, "STEP-7-x")).toBe(3)
    expect(await commitsAhead(realExec, repo, "STEP-7-x", { firstParent: true })).toBe(1)
    // What the round did itself: not staging's test, which the merge brought.
    expect(await ownChanges(realExec, repo, "staging", await changedFiles(realExec, repo, "STEP-7-x"))).toEqual(["a.ts"])
  })

  it("commits a merge with no clash itself, and names no file", async () => {
    const { repo, git } = repoWith()
    git("update-ref", "refs/remotes/origin/staging", "HEAD")
    git("checkout", "-q", "STEP-7-x")
    expect(await startMerge(realExec, repo, "staging")).toEqual({ conflicts: [] })
    expect(git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ")).toHaveLength(3)
    expect(await commitsAhead(realExec, repo, "STEP-7-x", { firstParent: true })).toBe(1)
  })

  it("throws, naming the command, when the merge fails without a clash", async () => {
    const { repo, git } = repoWith()
    git("checkout", "-q", "STEP-7-x")
    await expect(startMerge(realExec, repo, "no-such-base")).rejects.toThrow(/^git -C \S+ merge --no-ff --no-edit origin\/no-such-base failed \(\d+\)/)
  })
})

describe("conflictMarkers (STEP-3340)", () => {
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), "markers-"))
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { stdio: "pipe" }).toString()
    const write = (file: string, text: string) => writeFileSync(join(dir, file), text)
    execFileSync("git", ["init", "-q", "-b", "staging", dir])
    write("a.ts", "one\n")
    write("doc.md", "Intro\n")
    git("add", ".")
    git("commit", "-q", "-m", "base")
    return { dir, git, write }
  }

  it("names each file where HEAD adds a marker that opens or closes a conflict", async () => {
    const { dir, git, write } = repo()
    // An added line "++ x" reads "+++ x" in a hunk: it names no file.
    write("a.ts", "++ x\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin/staging\n")
    write("b.yml", "key: 1\n>>>>>>>\n")
    // A Markdown heading underlined with exactly seven "=" is no marker.
    write("doc.md", "Title\n=======\n")
    git("add", ".")
    git("commit", "-q", "-m", "next")
    expect(await conflictMarkers(realExec, dir, ["HEAD~1"])).toEqual(["a.ts", "b.yml"])
    expect(await conflictMarkers(realExec, dir, ["HEAD"])).toEqual([])
    expect(leftoverMarkers(["a.ts", "b.yml"])).toBe("leftover conflict marker in a.ts, b.yml")
    expect(leftoverMarkers(["1", "2", "3", "4", "5", "6", "7"])).toBe("leftover conflict marker in 1, 2, 3, 4, 5 and 2 more files")
  })

  it("reads longer markers, a diff3 base's marker, and a file its attributes would show as binary", async () => {
    const { dir, git, write } = repo()
    // conflict-marker-size=10 writes ten; -diff would make git diff print "Binary files differ".
    write(".gitattributes", "hidden.txt -diff\n")
    write("long-open.ts", "<<<<<<<<<< HEAD\nours\n")
    write("long-close.ts", "theirs\n>>>>>>>>>> origin/staging\n")
    write("base.ts", "||||||| merged common ancestors\n")
    write("hidden.txt", "<<<<<<< HEAD\nours\n")
    git("add", ".")
    git("commit", "-q", "-m", "next")
    expect(await conflictMarkers(realExec, dir, ["HEAD~1"])).toEqual(["base.ts", "hidden.txt", "long-close.ts", "long-open.ts"])
  })

  it("counts only a marker new over every ref: one the base already had came in by the merge", async () => {
    const { dir, git, write } = repo()
    git("checkout", "-q", "-b", "STEP-7-x")
    git("checkout", "-q", "staging")
    write("vendored.txt", ">>>>>>> the base's own line\n")
    git("add", ".")
    git("commit", "-q", "-m", "the base gains a marker-like line")
    git("checkout", "-q", "STEP-7-x")
    git("merge", "-q", "--no-ff", "--no-edit", "staging")
    expect(await conflictMarkers(realExec, dir, ["STEP-7-x~1"])).toEqual(["vendored.txt"])
    expect(await conflictMarkers(realExec, dir, ["STEP-7-x~1", "staging"])).toEqual([])
    write("a.ts", "<<<<<<< HEAD\none\n=======\ntwo\n>>>>>>> staging\n")
    git("commit", "-q", "-am", "a marker of the round's own")
    expect(await conflictMarkers(realExec, dir, ["STEP-7-x~2", "staging"])).toEqual(["a.ts"])
  })
})

describe("commitMessages", () => {
  it("reads the branch's own commits, newest first, as git writes them", async () => {
    const repo = mkdtempSync(join(tmpdir(), "commit-messages-"))
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { stdio: "ignore" })
    execFileSync("git", ["init", "-q", "-b", "staging", repo])
    git("commit", "-q", "--allow-empty", "-m", "base")
    git("update-ref", "refs/remotes/origin/staging", "HEAD")
    git("commit", "-q", "--allow-empty", "-m", "wip: first pass (STEP-7)")
    git("commit", "-q", "--allow-empty", "-m", "fix: rotate the token (STEP-7)", "-m", "Two paragraphs.\n\nThe second one.")
    expect(await commitMessages(realExec, repo, "staging")).toEqual([
      { subject: "fix: rotate the token (STEP-7)", body: "Two paragraphs.\n\nThe second one." },
      { subject: "wip: first pass (STEP-7)", body: "" },
    ])
    git("update-ref", "refs/remotes/origin/staging", "HEAD")
    expect(await commitMessages(realExec, repo, "staging")).toEqual([])
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
