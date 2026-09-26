"""
The git commits and pushes, and the destructive commands, a Bash command
runs, for bash-guard and the secrets scan (STEP-3354). Reads the command on
stdin and prints one line per finding, then END:

  DESTRUCTIVE <label>   what gate (a) refuses: rm -rf, git push --force
                        (--force-with-lease too), git push -f, git reset --hard,
                        git checkout \. (the argument "." only), git clean -f,
                        git branch -D. Read from the command's words, so
                        grep "rm -rf" or a message that names one is none.
  COMMIT <dir>          a git commit, run in <dir> (relative to the hook's root)
  COMMIT @unknown       a git commit in a repository or directory it cannot name
  PUSH <branch>         a branch a git push names
  PUSH @current <dir>   the branch checked out in <dir>: a push that names
                        only a remote, or HEAD
  PUSH @all             every branch, or the ones git's config picks: --all,
                        --mirror, --branches, a ':' or glob refspec,
                        -c push.* or -c remote.<name>.push
  PUSH @unknown         a push from a repository or directory it cannot name

What it reads: each command word in the text, split on ; && || | & ( ); the
body of each $(...), `...`, <(...) and >(...), which bash runs, in double
quotes and unquoted heredocs too; the text of sh -c and eval; the command
after xargs and find -exec; and a `cd` before a git command. Not what quotes
or a heredoc hold as text: `git commit` with a message that says "push" is
no push. A text it cannot read (an unclosed quote, parenthesis or heredoc)
raises: no END, and the hooks refuse the command.

Out of scope, left to the server's rulesets: git aliases, and config from the
environment (GIT_CONFIG_*).
"""

import os
import re
import shlex
import sys

HEREDOC_AT = re.compile(r"<<(-?)[ \t]*(\\?)([\"']?)([^\s\"'<>;&|()]+)\3")
SEPARATOR = set(";&|()")
REDIRECT = re.compile(r"^[0-9]*[<>]+&?$|^&>+$")
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# Words bash runs another command after: wrappers, and the keywords a command follows.
WRAPPERS = {
    "command", "builtin", "exec", "env", "time", "nohup", "nice", "sudo",
    "!", "{", "(", "then", "do", "else", "elif", "if", "while", "until",
}
XARGS_VALUE_OPTIONS = {"-n", "-I", "-L", "-P", "-s", "-E", "-d", "-a", "-J", "-R", "-S"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
FIND_EXEC = {"-exec", "-execdir", "-ok", "-okdir"}
GLOBAL_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"}
OTHER_REPO = {"--git-dir", "--work-tree", "--namespace"}
PUSH_VALUE_OPTIONS = {"-o", "--push-option", "--repo", "--receive-pack", "--exec"}


class Unreadable(Exception):
    pass


def command_texts(text):
    """Every command text bash runs from `text`: the text itself and each substitution's body, heredoc bodies out."""
    texts = []
    end, outer = command(text, 0, None, texts)
    texts.append(outer)
    return texts


def command(t, i, closer, texts):
    """Reads a command context from i to its closer (')' or '`', or the end). Returns (index after it, its text)."""
    out, pending, depth = [], [], 0
    while i < len(t):
        c = t[i]
        if c == closer and (closer == "`" or depth == 0):
            if pending:
                raise Unreadable("a heredoc with no body")
            return i + 1, "".join(out)
        if t.startswith("\\\n", i):
            # A line continued: one command, as bash reads it.
            out.append(" ")
            i += 2
        elif c == "\\":
            out.append(t[i : i + 2])
            i += 2
        elif t.startswith("$'", i):
            # ANSI-C quoting: \' inside does not close it. A word, never a command.
            j = i + 2
            while j < len(t) and t[j] != "'":
                j += 2 if t[j] == "\\" else 1
            if j >= len(t):
                raise Unreadable("an unclosed $'...'")
            out.append(" _ ")
            i = j + 1
        elif t.startswith(("$((", "(("), i):
            # Arithmetic: its << is a shift, not a heredoc. A substitution inside it still runs.
            i = arithmetic(t, i + (3 if c == "$" else 2), texts)
            out.append(" _ ")
        elif c == "'":
            end = t.find("'", i + 1)
            if end < 0:
                raise Unreadable("an unclosed single quote")
            out.append(t[i : end + 1])
            i = end + 1
        elif c == '"':
            i = double_quoted(t, i + 1, out, texts)
        elif t.startswith(("$(", "<(", ">("), i) and not t.startswith("$((", i):
            i, body = command(t, i + 2, ")", texts)
            texts.append(body)
            out.append(" _ ")
        elif c == "`":
            i, body = command(t, i + 1, "`", texts)
            texts.append(body)
            out.append(" _ ")
        elif c == "#" and (not out or out[-1][-1:] in ("", " ", "\t", "\n", ";", "&", "|", "(")):
            end = t.find("\n", i)
            i = len(t) if end < 0 else end
        elif t.startswith("<<", i) and not t.startswith("<<<", i):
            m = HEREDOC_AT.match(t, i)
            if not m:
                raise Unreadable("a heredoc with no word")
            pending.append((m.group(1) == "-", m.group(4), not (m.group(2) or m.group(3))))
            out.append(t[i : m.end()])
            i = m.end()
        elif c == "\n":
            # A newline ends a command, as `;` does (shlex reads it as a space).
            out.append(" ; ")
            i += 1
            if pending:
                i = heredoc_bodies(t, i, pending, texts)
                pending = []
        else:
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            out.append(c)
            i += 1
    if closer or pending:
        raise Unreadable("an unclosed " + ("substitution" if closer else "heredoc"))
    return i, "".join(out)


def double_quoted(t, i, out, texts):
    """Reads a double-quoted string from just past its quote. Its substitutions run: their bodies go to texts."""
    out.append('"')
    while i < len(t):
        c = t[i]
        if c == "\\":
            out.append(t[i : i + 2])
            i += 2
        elif c == '"':
            out.append('"')
            return i + 1
        elif t.startswith("$(", i) and not t.startswith("$((", i):
            i, body = command(t, i + 2, ")", texts)
            texts.append(body)
            out.append(" _ ")
        elif c == "`":
            i, body = command(t, i + 1, "`", texts)
            texts.append(body)
            out.append(" _ ")
        else:
            out.append(c)
            i += 1
    raise Unreadable("an unclosed double quote")


def heredoc_bodies(t, i, pending, texts):
    """Skips each pending heredoc's lines, its closing line included. An unquoted one's substitutions run."""
    for strip_tabs, word, expands in pending:
        lines = []
        while True:
            if i >= len(t):
                raise Unreadable("a heredoc that never ends: " + word)
            end = t.find("\n", i)
            end = len(t) if end < 0 else end
            line = t[i:end]
            i = end + 1
            if (line.lstrip("\t") if strip_tabs else line) == word:
                break
            lines.append(line)
        if expands:
            substitutions_in("\n".join(lines), texts)
    return min(i, len(t))


def substitutions_in(body, texts):
    """The substitutions in text bash expands but does not run as a command: each one's body runs."""
    j = 0
    while j < len(body):
        if body[j] == "\\":
            j += 2
        elif body.startswith("$(", j) and not body.startswith("$((", j):
            j, sub = command(body, j + 2, ")", texts)
            texts.append(sub)
        elif body[j] == "`":
            j, sub = command(body, j + 1, "`", texts)
            texts.append(sub)
        else:
            j += 1


def arithmetic(t, i, texts):
    """Skips an arithmetic expression from just inside its (( to past its )). Returns the index after it.
    Bash reads a (( that does not parse as arithmetic as nested subshells: the text is read as a command too."""
    j, depth = i, 2
    while j < len(t) and depth:
        if t[j] == "(":
            depth += 1
        elif t[j] == ")":
            depth -= 1
        j += 1
    if depth:
        raise Unreadable("an unclosed arithmetic expression")
    inner = t[i : j - 2]
    substitutions_in(inner, texts)
    texts.append(inner)
    return j


def segments(text):
    lexer = shlex.shlex(text, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    words, skip = [], False
    try:
        for token in lexer:
            if skip:
                skip = False
            elif set(token) <= SEPARATOR:
                yield words
                words = []
            elif REDIRECT.match(token):
                skip = True
            else:
                words.append(token)
    except ValueError as error:
        raise Unreadable(str(error))
    yield words


def command_word(words):
    """The index of the word bash runs: past VAR=value words and wrappers like env, sudo, time, xargs."""
    i = 0
    while i < len(words):
        if ASSIGNMENT.match(words[i]):
            i += 1
        elif words[i] in WRAPPERS or words[i] == "xargs":
            takes_values = XARGS_VALUE_OPTIONS if words[i] == "xargs" else set()
            i += 1
            while i < len(words) and words[i].startswith("-"):
                i += 2 if words[i] in takes_values else 1
        else:
            break
    return i


def git_subcommand(args):
    """A git invocation's subcommand and its words, past git's own options."""
    i = 0
    while i < len(args) and args[i].startswith("-"):
        i += 2 if args[i] in GLOBAL_VALUE_OPTIONS else 1
    return (args[i], args[i + 1 :]) if i < len(args) else (None, [])


def destructive(argv):
    """What gate (a) refuses, by the label it has always named, for a command's words from its command word on; or None.
    Flags are read as git and rm read them, not as text: a message or a path that holds the words is none of these."""
    name, args = os.path.basename(argv[0]), argv[1:]

    def shorts(words):
        return "".join(a[1:] for a in words if a.startswith("-") and not a.startswith("--"))

    if name == "rm":
        recursive = any(c in shorts(args) for c in "rR") or "--recursive" in args
        force = "f" in shorts(args) or "--force" in args
        return "rm -rf" if recursive and force else None
    if name != "git":
        return None
    sub, rest = git_subcommand(args)
    if sub == "push":
        if any(a.startswith("--force") for a in rest):
            return "git push --force"
        return "git push -f" if "f" in shorts(rest) else None
    if sub == "reset" and "--hard" in rest:
        return "git reset --hard"
    if sub == "checkout" and "." in rest:
        return "git checkout \\."
    if sub == "clean" and ("f" in shorts(rest) or "--force" in rest):
        return "git clean -f"
    if sub == "branch":
        delete = "d" in shorts(rest) or "--delete" in rest
        force = "f" in shorts(rest) or "--force" in rest
        if "D" in shorts(rest) or (delete and force):
            return "git branch -D"
    return None


def config_pushes(key):
    key = key.lower()
    return key.startswith("push.") or re.fullmatch(r"remote\..+\.push", key) is not None


def git_command(words, cwd, out):
    """One git invocation (the words after `git`): what it commits or pushes."""
    i, directory, other_repo, by_config = 0, cwd, False, False
    while i < len(words) and words[i].startswith("-"):
        option, value = words[i], None
        if option.startswith("--") and "=" in option:
            option, value = option.split("=", 1)
        elif option in GLOBAL_VALUE_OPTIONS and i + 1 < len(words):
            i += 1
            value = words[i]
        if option == "-C" and value is not None and directory is not None:
            directory = os.path.normpath(os.path.join(directory, os.path.expanduser(value)))
        elif option in ("-c", "--config-env") and value is not None:
            by_config = by_config or config_pushes(value.split("=", 1)[0])
        elif option in OTHER_REPO:
            other_repo = True
        i += 1
    if i >= len(words):
        return
    sub, rest = words[i], words[i + 1 :]
    unknown = other_repo or directory is None
    if sub == "commit":
        out.append("COMMIT @unknown" if unknown else "COMMIT " + directory)
    if sub != "push":
        return
    current = "PUSH @unknown" if unknown else "PUSH @current " + directory
    if by_config:
        out.append("PUSH @all")
    args, skip = [], False
    for word in rest:
        if skip:
            skip = False
        elif word in PUSH_VALUE_OPTIONS:
            skip = True
        elif word in ("--all", "--mirror", "--branches"):
            out.append("PUSH @all")
        elif not word.startswith("-"):
            args.append(word)
    if len(args) < 2:
        out.append(current)
    for spec in args:
        if spec.lstrip("+") == ":" or "*" in spec:
            out.append("PUSH @all")
            continue
        dst = spec.split(":")[-1].lstrip("+")
        if dst.startswith("refs/heads/"):
            dst = dst[len("refs/heads/") :]
        out.append(current if dst in ("HEAD", "") else "PUSH " + dst)


def run(words, cwd, out):
    """One simple command's words: what it commits, pushes or destroys, and the directory after it."""
    w = command_word(words)
    if w >= len(words):
        return cwd
    argv = words[w:]
    name = os.path.basename(argv[0])
    label = destructive(argv)
    if label:
        out.append("DESTRUCTIVE " + label)
    if name in ("cd", "pushd"):
        target = argv[1] if len(argv) > 1 else "~"
        if target == "-" or cwd is None:
            return None
        return os.path.normpath(os.path.join(cwd, os.path.expanduser(target)))
    if name == "git":
        git_command(argv[1:], cwd, out)
    elif name in SHELLS:
        # sh -c '…' (or -lc, -ec) runs its text as a command: read it the same way.
        flag = next((k for k, a in enumerate(argv[1:-1], 1) if a.startswith("-") and not a.startswith("--") and "c" in a), None)
        if flag is not None:
            out.extend(analyse(argv[flag + 1], cwd))
    elif name == "eval":
        out.extend(analyse(" ".join(argv[1:]), cwd))
    elif name == "find":
        # find -exec … ; runs the words after it for each file.
        for k, word in enumerate(argv):
            if word in FIND_EXEC:
                command = argv[k + 1 :]
                end = next((j for j, x in enumerate(command) if x in (";", "+")), len(command))
                run(command[:end], cwd, out)
    return cwd


def analyse(text, cwd="."):
    out = []
    for command_text in command_texts(text):
        here = cwd
        for words in segments(command_text):
            here = run(words, here, out)
    return out


def main():
    try:
        out = analyse(sys.stdin.read())
    except Unreadable as error:
        raise SystemExit("unreadable: " + str(error))
    print("\n".join(out + ["END"]))


if __name__ == "__main__":
    main()
