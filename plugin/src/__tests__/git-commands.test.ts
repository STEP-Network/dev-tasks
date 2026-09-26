/**
 * hooks/lib/git_commands.py (STEP-3354): the git commits and pushes a Bash
 * command runs, for bash-guard and the secrets scan. What a quote or a
 * heredoc holds is text, never a command. What bash runs, a substitution or
 * a command after a separator, is read.
 */

import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "lib", "git_commands.py")

/** The lines it prints for a command, without END; or the error it stops with. */
function analyse(command: string): string[] | { error: string } {
  const r = spawnSync("python3", [LIB], { input: command, encoding: "utf8" })
  const lines = r.stdout.trim().split("\n")
  if (r.status !== 0 || lines.at(-1) !== "END") return { error: r.stderr.trim() }
  return lines.slice(0, -1)
}

describe("git_commands.py", () => {
  it("reads a commit message as text, however it is written, and never as a push", () => {
    for (const command of [
      "git commit -F - <<'EOF'\nfix: don't push twice\nEOF",
      "git commit -F - <<EOF\nfix: git push origin main, never\nEOF",
      'git commit -m "$(cat <<\'EOF\'\nfix: an odd " and git push origin main\nEOF\n)"',
      "git commit -m \"fix: don't push\"",
      "git commit -m 'git push origin main'",
      "git commit -m x # git push origin main",
    ]) {
      expect(analyse(command), command).toEqual(["COMMIT ."])
    }
    expect(analyse("echo git push origin main")).toEqual([])
    expect(analyse("gh pr create --body \"run git push origin main\"")).toEqual([])
  })

  it("reads every push bash runs: after a separator, in a substitution, behind env", () => {
    expect(analyse("git push origin feat && git push origin main")).toEqual(["PUSH origin", "PUSH feat", "PUSH origin", "PUSH main"])
    expect(analyse("`git push origin main`")).toEqual(["PUSH origin", "PUSH main"])
    expect(analyse('echo "$(git push origin main)"')).toEqual(["PUSH origin", "PUSH main"])
    expect(analyse("cat <<EOF\n$(git push origin main)\nEOF")).toEqual(["PUSH origin", "PUSH main"])
    // A quoted heredoc's body is only text.
    expect(analyse("cat <<'EOF'\n$(git push origin main)\nEOF")).toEqual([])
    expect(analyse("FOO=1 env -i /usr/bin/git push origin main")).toEqual(["PUSH origin", "PUSH main"])
  })

  it("names each branch a refspec reaches, and every branch where git or its config picks them", () => {
    expect(analyse("git push -u origin +HEAD:refs/heads/staging")).toEqual(["PUSH origin", "PUSH staging"])
    expect(analyse("git push -o ci.skip origin main")).toEqual(["PUSH origin", "PUSH main"])
    for (const command of [
      "git push origin :",
      "git push origin +:",
      "git push origin 'refs/heads/*:refs/heads/*'",
      "git push --all origin",
      "git push --mirror origin",
      "git -c push.default=matching push origin",
      "git -c remote.origin.push=refs/heads/main push origin",
      "git --config-env=push.default=MODE push origin",
    ]) {
      expect(analyse(command), command).toContain("PUSH @all")
    }
  })

  it("names where an implicit push or a commit runs: -C, a cd before it, or nowhere it can tell", () => {
    expect(analyse("git push")).toEqual(["PUSH @current ."])
    expect(analyse("git -C sub push origin HEAD")).toEqual(["PUSH origin", "PUSH @current sub"])
    expect(analyse("cd ../other && git push")).toEqual(["PUSH @current ../other"])
    expect(analyse("cd - && git push")).toEqual(["PUSH @unknown"])
    expect(analyse("git --git-dir=/x/.git push origin HEAD")).toEqual(["PUSH origin", "PUSH @unknown"])
    expect(analyse("git -C sub -c user.name=x commit -m y")).toEqual(["COMMIT sub"])
    expect(analyse("cd a && git -C b commit -m y")).toEqual(["COMMIT a/b"])
  })

  it("reads each line as a command, and a command after a shell keyword (#151 review)", () => {
    expect(analyse("git status\ngit push origin main")).toEqual(["PUSH origin", "PUSH main"])
    expect(analyse("cat <<'EOF'\ntext\nEOF\ngit push origin staging")).toEqual(["PUSH origin", "PUSH staging"])
    expect(analyse("git add app.ts\ngit commit -m x")).toEqual(["COMMIT ."])
    expect(analyse("if true; then git push origin main; fi")).toEqual(["PUSH origin", "PUSH main"])
    expect(analyse("for b in a; do git push origin main; done")).toEqual(["PUSH origin", "PUSH main"])
    expect(analyse("if false; then :; else git push origin main; fi")).toEqual(["PUSH origin", "PUSH main"])
    expect(analyse("if false; then :; elif git push origin main; then :; fi")).toEqual(["PUSH origin", "PUSH main"])
    expect(analyse("while git push origin main; do :; done")).toEqual(["PUSH origin", "PUSH main"])
    expect(analyse("{ git push origin main; }")).toEqual(["PUSH origin", "PUSH main"])
    expect(analyse("! git push origin main")).toEqual(["PUSH origin", "PUSH main"])
    expect(analyse("git push \\\n  origin main")).toEqual(["PUSH origin", "PUSH main"])
    for (const command of ["\tgit push origin main", "\\git push origin main", "/usr/bin/git push origin main", "git --no-pager push origin main", "GIT_EXEC_PATH=/x git push origin main", "gi''t push origin main", "true || git push origin main", "sleep 1 & git push origin main", "case x in x) git push origin main;; esac"]) {
      expect(analyse(command), command).toEqual(["PUSH origin", "PUSH main"])
    }
  })

  it("reads arithmetic and ANSI-C quoting, and a substitution inside arithmetic", () => {
    expect(analyse("echo $((1<<2))")).toEqual([])
    expect(analyse("(( x = 1 << 2 ))")).toEqual([])
    expect(analyse("git commit -m $'it\\'s done'")).toEqual(["COMMIT ."])
    // Read as a substitution and as the text bash may run as a subshell: found either way, maybe twice.
    expect(new Set(analyse("echo $(( $(git push origin main) + 1 ))") as string[])).toEqual(new Set(["PUSH origin", "PUSH main"]))
    expect(analyse("((git push origin main))")).toEqual(["PUSH origin", "PUSH main"])
  })

  it("stops on a command it cannot read, so the hooks refuse it", () => {
    for (const command of ['git push origin "main', "git push origin 'main", "echo $(git push", "cat <<EOF\nno end", "echo `git push"]) {
      expect(analyse(command), command).toHaveProperty("error")
    }
  })
})
