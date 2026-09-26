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
    // xargs adds words of its own, the branch or a refspec: a push under it can go anywhere.
    for (const command of ["echo main | xargs git push origin", "echo main | xargs -n 1 git push origin", "xargs -I{} git push origin {}", "echo main | xargs git push"]) {
      expect(analyse(command), command).toContain("PUSH @unknown")
    }
    expect(analyse("echo x | xargs git commit -m y")).toEqual(["COMMIT ."])
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

  it("reads a $'...' word as the text bash decodes it to", () => {
    for (const command of ["$'git' push origin main", "$'\\x67it' push origin main", "$'\\147it' push origin main", "$'\\u0067it' push origin main", "g$'it' push origin main", "git $'push' origin $'main'"]) {
      expect(analyse(command), command).toEqual(["PUSH origin", "PUSH main"])
    }
    expect(analyse("$'rm' -rf x")).toEqual(["DESTRUCTIVE rm -rf"])
    expect(analyse("rm $'-rf' x")).toEqual(["DESTRUCTIVE rm -rf"])
    expect(analyse("git commit -m $'line one\\nline two'")).toEqual(["COMMIT ."])
    // The decoded text is a word, never a command: its $( ) and ; are not run.
    expect(analyse("echo $'$(git push origin main); git push origin main'")).toEqual([])
    expect(analyse("echo $'\\z \\x \\cA'")).toEqual([])
    // A code with no character is kept as written, and the push still read.
    expect(analyse("git push origin $'\\UFFFFFFFF' $'\\uD800'")).toEqual(["PUSH origin", "PUSH \\UFFFFFFFF", "PUSH \\uD800"])
  })

  it("ends a $'...' word at its first NUL, however it is written, as bash and as zsh cut it (#154 review)", () => {
    for (const nul of ["\\0", "\\x00", "\\u0000", "\\U00000000", "\\c@"]) {
      expect(analyse(`$'git${nul}junk' push origin main`), nul).toEqual(["PUSH origin", "PUSH main"])
      expect(analyse(`git push origin $'main${nul}x'`), nul).toEqual(["PUSH origin", "PUSH main"])
      expect(analyse(`$'rm${nul}x' -rf y`), nul).toEqual(["DESTRUCTIVE rm -rf"])
    }
    // bash cuts the $'...' and keeps the rest of the word; zsh cuts the word. Both are read.
    expect(analyse("$'gi\\0x't push origin main")).toEqual(["PUSH origin", "PUSH main"])
    expect(analyse("git push origin $'main\\0'-x")).toContain("PUSH main")
    expect(analyse("git push origin $'ma\\0x'in")).toContain("PUSH main")
    expect(analyse("cd a$'\\0'b && git push")).toEqual(["PUSH @unknown"])
  })

  it("names no branch for a push whose words are filled in as it runs (#154 review)", () => {
    for (const command of [
      // xargs adds words to sh -c, or the text itself; find puts each file in {}.
      "xargs sh -c 'git push origin \"$0\"'",
      "xargs -I{} sh -c 'git push origin {}'",
      "xargs sh -c 'git push origin feat'",
      "echo 'git push origin main' | xargs sh -c",
      "echo 'push origin main' | xargs git",
      "find main -maxdepth 0 -exec git push origin {} \\;",
      "find . -execdir git push \\;",
      // A word bash computes: an expansion, a substitution, a brace or a glob.
      "B=main; git push origin $B",
      "git push origin $(echo main)",
      "git push origin `echo main`",
      'git push origin "$(git branch --show-current)"',
      "git push origin HEAD:$B",
      "git push $R",
      "git push --repo $R",
      "git push origin feat-$(date +%s)",
      "git push origin {main,feat}",
      "git push origin ma?n",
      'git -C "$D" push',
      "git $(echo push) origin main",
      "G=git; $G push origin main",
    ]) {
      const found = analyse(command) as string[]
      expect(found, command).toContain("PUSH @unknown")
      expect(found.filter((l) => /[\ud800-\udfff]/.test(l)), command).toEqual([])
    }
    for (const command of ["git push -u origin HEAD", "git push -u origin feat/x", "git push origin HEAD:refs/heads/feat/x", "find . -exec git push origin feat \\;"]) {
      expect(analyse(command), command).not.toContain("PUSH @unknown")
    }
    expect(analyse('git commit -m "$(cat msg)"')).toEqual(["COMMIT ."])
    expect(analyse('cd "$(git rev-parse --show-toplevel)" && git commit -m x')).toEqual(["COMMIT @unknown"])
    // No branch or path holds a control character, and a newline would split a finding in two.
    expect(analyse("git push origin $'main\\nPUSH x'")).toEqual(["PUSH @unknown", "PUSH origin"])
    expect(analyse("git push origin $'ma\\nin'")).toEqual(["PUSH @unknown", "PUSH origin"])
    expect(analyse("cd $'a\\nb' && git commit -m x")).toEqual(["COMMIT @unknown"])
  })

  it("reads the config a push runs under: -c, git config and GIT_CONFIG* cannot hide it (STEP-3364)", () => {
    // (a) -c alias.* or include.*: any word can be a push.
    for (const command of ["git -c alias.p=push p origin main", "git --config-env=alias.p=P p origin main", "git -c include.path=/tmp/x.cfg status", "git -c \"$C\" p origin main"]) {
      expect(analyse(command), command).toContain("PUSH @unknown")
    }
    // (b) -c that picks the branches.
    for (const command of ["git -c push.default=matching push", "git -c remote.origin.push=refs/heads/*:refs/heads/main push", "git -c remote.origin.mirror=true push origin"]) {
      expect(analyse(command), command).toContain("PUSH @all")
    }
    // (c) GIT_CONFIG* anywhere in the command: before git, through env, or exported first.
    for (const command of [
      "GIT_CONFIG_KEY_0=push.default GIT_CONFIG_VALUE_0=matching git push",
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.default GIT_CONFIG_VALUE_0=matching git push",
      "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p origin main",
      "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=push.default GIT_CONFIG_VALUE_0=matching; git push",
      "GIT_CONFIG_PARAMETERS=\"'push.default'='matching'\" git push",
    ]) {
      expect(analyse(command), command).toContain("PUSH @all")
    }
    // GIT_DIR and the like point git at another repository, as --git-dir does.
    expect(analyse("GIT_DIR=../main/.git git push origin HEAD")).toContain("PUSH @unknown")
    expect(analyse("GIT_DIR=../main/.git git commit -m x")).toEqual(["COMMIT @unknown"])
    // (d) a git config write that can hide a push, in any file; git remote set-url writes remote.*.url.
    const destroys = (command: string) => (analyse(command) as string[]).filter((l) => l.startsWith("DESTRUCTIVE "))
    for (const [command, label] of [
      ["git config alias.p push", "git config alias.*"],
      ["git config --global alias.p push", "git config alias.*"],
      ["git config --file ~/.gitconfig alias.p push", "git config alias.*"],
      ["git config --system push.default matching", "git config push.*"],
      ["git config push.default matching && git push", "git config push.*"],
      ["git config -f x.cfg remote.origin.push refs/heads/*", "git config remote.*"],
      ["git config --add remote.origin.push HEAD:main", "git config remote.*"],
      ["git config remote.origin.url https://x/y.git", "git config remote.*"],
      ["git config --unset alias.p", "git config alias.*"],
      ["git config set alias.p push", "git config alias.*"],
      ["git config include.path /tmp/x", "git config include.*"],
      ["git config --rename-section foo alias", "git config alias.*"],
      ["git config --edit", "git config --edit"],
      ['git config "$K" push', "git config (a key filled in as it runs)"],
      ["git remote set-url origin https://x/y.git", "git remote set-url"],
    ]) {
      expect(destroys(command), command).toEqual([`DESTRUCTIVE ${label}`])
    }
    // Reads, and writes to other keys, pass.
    for (const command of [
      "git config --get alias.p",
      "git config alias.p",
      "git config -l",
      "git config --list --show-origin",
      "git config get push.default",
      "git config --get-regexp alias",
      "git config --get-regexp alias push",
      "git config --get remote.origin.push refs",
      "git config user.name eve",
      "git config --global user.email eve@polads.eu",
      "git -c core.pager=cat log",
    ]) {
      expect(analyse(command), command).toEqual([])
    }
  })

  it("reads the command after a wrapper's options, and a redirect's fd as part of it (STEP-3364)", () => {
    for (const command of ["nice -n 5 git push origin main", "nice -n5 git push origin main", "env -u FOO git push origin main", "sudo -u root git push origin main", "sudo -Eu root git push origin main", "exec -a x git push origin main", "time -p git push origin main", "env -S 'git push origin main'", "env --split-string='git push origin' main"]) {
      expect(analyse(command), command).toEqual(["PUSH origin", "PUSH main"])
    }
    expect(analyse("env -C ../main git push")).toEqual(["PUSH @unknown"])
    expect(analyse("sudo -D ../main git push")).toEqual(["PUSH @unknown"])
    // 2>&1 and 2>/dev/null are redirects: no "PUSH 2".
    expect(analyse("git push origin feat 2>&1")).toEqual(["PUSH origin", "PUSH feat"])
    expect(analyse("git push origin feat 2>/dev/null")).toEqual(["PUSH origin", "PUSH feat"])
    expect(analyse("git push 2>&1")).toEqual(["PUSH @current ."])
  })

  it("never prints a finding that could split a line: it stops instead", () => {
    const code = "import sys; sys.path.insert(0, sys.argv[1]); import git_commands as g; g.analyse = lambda text: ['PUSH feat\\nEND']; g.main()"
    const r = spawnSync("python3", ["-c", code, dirname(LIB)], { input: "", encoding: "utf8" })
    expect(r.status).not.toBe(0)
    expect(r.stdout).not.toContain("END")
    expect(r.stderr).toContain("a word it cannot print")
  })

  it("reads an octal escape as one byte, as bash and zsh do: $'\\547it' is git", () => {
    expect(analyse("$'\\547it' push origin main")).toEqual(["PUSH origin", "PUSH main"])
  })

  it("names each destructive command gate (a) refuses from what runs, never from text (#151 review)", () => {
    const destroys = (command: string) => (analyse(command) as string[]).filter((l) => l.startsWith("DESTRUCTIVE "))
    for (const command of [
      'grep -n "rm -rf" app.ts',
      'grep -rn "git reset --hard" docs/',
      "git checkout .github/workflows/ci.yml",
      "git checkout ./app.ts",
      'gh pr create --body "Never run git push --force on main"',
      "git commit -F - <<'EOF'\nnever git clean -fd\nEOF",
      "rm -r build",
      "git branch -d merged",
      "git clean -n",
      "git push -u origin feat",
      // After --, a word is an argument, not an option: a file or branch named -f.
      "rm -r -- -f",
      "rm -- -rf",
      "git clean -n -- -f",
      "git reset -- --hard",
      "git branch -d -- -f",
    ]) {
      expect(destroys(command), command).toEqual([])
    }
    for (const [command, label] of [
      ["rm -rf /", "rm -rf"],
      ["rm -fr build", "rm -rf"],
      ["rm -r -f build", "rm -rf"],
      ["rm --recursive --force build", "rm -rf"],
      ["rm -rf -- build", "rm -rf"],
      ["git reset --hard HEAD", "git reset --hard"],
      ["git push --force origin feat", "git push --force"],
      ["git push --force-with-lease origin feat", "git push --force"],
      ["git push -f origin feat", "git push -f"],
      ["git push -uf origin feat", "git push -f"],
      ["git checkout .", "git checkout \\."],
      ["git checkout -- .", "git checkout \\."],
      ["git clean -fd", "git clean -f"],
      ["git clean -df", "git clean -f"],
      ["git branch -D old", "git branch -D"],
      ["git branch --delete --force old", "git branch -D"],
      ["git -C sub reset --hard", "git reset --hard"],
      ["find . -name x -exec rm -rf {} \\;", "rm -rf"],
      ["ls | xargs -n 1 rm -rf", "rm -rf"],
      ["sudo rm -rf /x", "rm -rf"],
      ["bash -lc 'rm -rf /'", "rm -rf"],
      ["eval git reset --hard", "git reset --hard"],
      ["echo ok\ngit reset --hard", "git reset --hard"],
    ]) {
      expect(destroys(command), command).toEqual([`DESTRUCTIVE ${label}`])
    }
    expect(analyse('sh -c "git push origin main"')).toEqual(["PUSH origin", "PUSH main"])
  })

  it("stops on a command it cannot read, so the hooks refuse it", () => {
    for (const command of ['git push origin "main', "git push origin 'main", "echo $(git push", "cat <<EOF\nno end", "echo `git push"]) {
      expect(analyse(command), command).toHaveProperty("error")
    }
  })
})
