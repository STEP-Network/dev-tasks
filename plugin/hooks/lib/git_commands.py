"""
The git commits and pushes, and the destructive commands, a Bash command
runs, for bash-guard and the secrets scan (STEP-3354). Reads the command on
stdin and prints one line per finding, then END:

  DESTRUCTIVE <label>   what gate (a) refuses: rm -rf, git push --force
                        (--force-with-lease too), git push -f, git reset --hard,
                        git checkout \. (the argument "." only), git clean -f,
                        git branch -D; a git config write to alias.*,
                        include.*, push.* or remote.<name>.push, .url,
                        .pushurl or .mirror (--global, --system, --file
                        too), git config --edit, git remote set-url. Read
                        from the command's words, so grep "rm -rf" or a
                        message that names one is none.
  COMMIT <dir>          a git commit, run in <dir> (relative to the hook's root)
  COMMIT @unknown       a git commit in a repository or directory it cannot
                        name (--git-dir, GIT_DIR=, cd -)
  PUSH <branch>         a branch a git push names
  PUSH @current <dir>   the branch checked out in <dir>: a push that names
                        only a remote, or HEAD
  PUSH @all             every branch, or the ones git's config picks: --all,
                        --mirror, --branches, a ':' or glob refspec,
                        -c push.* or -c remote.<name>.push or .mirror; and
                        any git that runs with GIT_CONFIG* in the command,
                        whose config it cannot see
  PUSH @unknown         a push whose branch it cannot name: from a repository
                        or directory it cannot name; under xargs, which adds
                        words (the subcommand, a branch); or with a word bash
                        or find computes as it runs ($B, $(...), a backtick,
                        a brace or glob, find's {}), the git word or
                        subcommand too; and any git with -c alias.* or
                        include.*, where any word can be a push

What it reads: each command word in the text, split on ; && || | & ( ); the
body of each $(...), `...`, <(...) and >(...), which bash runs, in double
quotes and unquoted heredocs too; the text of sh -c and eval; the command
after xargs and find -exec, and after a wrapper, by its name or path
(/usr/bin/env), and its options and operands (nice -n 5, env -u X, sudo -u
u, timeout 30, script -q /dev/null; env -S's and script -c's text; env -C
runs it elsewhere); and a `cd` before a git command. After a command word it
does not know (flock f git push ...), a git push is PUSH @unknown and a
destructive command DESTRUCTIVE. A shell with no script runs its stdin: a
heredoc or here-string it is given is read as its commands (bash <<'EOF'),
and a pipe, a < file or -s is PUSH @unknown (echo ... | sh). A 2> or 2>&1 is a redirect, not a word. A $'...' word
is its decoded text ($'git' is git), up to a NUL, where bash and zsh cut it
differently: both readings are checked. An option after `--` is an argument
(rm -r -- -f). Not what quotes or a heredoc hold as text: `git
commit` with a message that says "push" is no push. A text it cannot read (an unclosed quote, parenthesis or heredoc)
raises: no END, and the hooks refuse the command.

Out of scope, left to the server's rulesets: what files hold, as it reads
commands and not files. Git config a Write or Edit puts in .git/config or a
gitconfig (an alias, push.default), and aliases already there; a script a
command runs (sh deploy.sh). A command can no longer write that config
(git config), pass it (-c, GIT_CONFIG*) or point git at it (HOME=,
XDG_CONFIG_HOME=).
"""

import os
import re
import shlex
import sys

HEREDOC_AT = re.compile(r"<<(-?)[ \t]*(\\?)([\"']?)([^\s\"'<>;&|()]+)\3")
SEPARATOR = set(";&|()")
REDIRECT = re.compile(r"^[0-9]*[<>]+&?$|^&>+$")
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
# Words bash runs another command after: wrappers, by their name or path (/usr/bin/env), and the
# keywords a command follows. A wrapper not here is caught by run()'s fallback.
WRAPPERS = {
    "command", "builtin", "exec", "env", "time", "nohup", "nice", "sudo", "xargs",
    "timeout", "gtimeout", "stdbuf", "gstdbuf", "caffeinate", "sandbox-exec", "arch", "script",
    "!", "{", "(", "then", "do", "else", "elif", "if", "while", "until",
}
XARGS_VALUE_OPTIONS = {"-n", "-I", "-L", "-P", "-s", "-E", "-d", "-a", "-J", "-R", "-S"}
# A wrapper's options that take a value: the word after one is not the command (nice -n 5 git).
WRAPPER_VALUE_OPTIONS = {
    "xargs": XARGS_VALUE_OPTIONS,
    "env": {"-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P"},
    "nice": {"-n", "--adjustment"},
    "sudo": {"-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-D", "--chdir",
             "-R", "--chroot", "-T", "--command-timeout", "-U", "--other-user", "-r", "--role", "-t", "--type"},
    "exec": {"-a"},
    "time": {"-f", "--format", "-o", "--output"},
    "timeout": {"-s", "--signal", "-k", "--kill-after"},
    "gtimeout": {"-s", "--signal", "-k", "--kill-after"},
    "stdbuf": {"-i", "--input", "-o", "--output", "-e", "--error"},
    "gstdbuf": {"-i", "--input", "-o", "--output", "-e", "--error"},
    "caffeinate": {"-w", "-t"},
    "sandbox-exec": {"-f", "-n", "-p", "-D"},
    "arch": {"-arch", "-d", "-e"},
    "script": {"-t", "-c", "--command", "-I", "--log-in", "-O", "--log-out", "-B", "--log-io", "-T", "--log-timing",
               "-m", "--logging-format", "-E", "--echo", "-o", "--output-limit"},
}
# Words a wrapper takes before the command: timeout's duration, script's file.
WRAPPER_OPERANDS = {"timeout": 1, "gtimeout": 1, "script": 1}
WRAPPER_CHDIR = {("env", "-C"), ("env", "--chdir"), ("sudo", "-D"), ("sudo", "--chdir")}
# A wrapper option whose value is the command's text: env -S splits it, script -c runs it in a shell.
WRAPPER_SPLIT = {("env", "-S"), ("env", "--split-string"), ("script", "-c"), ("script", "--command")}
FD_REDIRECT = re.compile(r"[0-9]+(?=[<>])")
SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
FIND_EXEC = {"-exec", "-execdir", "-ok", "-okdir"}
GLOBAL_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"}
OTHER_REPO = {"--git-dir", "--work-tree", "--namespace"}
# The same, from the environment. GIT_CONFIG* (COUNT, KEY_n, VALUE_n, PARAMETERS, GLOBAL, SYSTEM)
# carries config the command's words do not show.
REPO_ENV = {"GIT_DIR", "GIT_WORK_TREE", "GIT_NAMESPACE"}
# Where git finds its global config: HOME=x or XDG_CONFIG_HOME=x points it at one a file write made.
CONFIG_HOME_ENV = {"HOME", "XDG_CONFIG_HOME"}
# git config: its reads, the options that write, and the options whose value is the next word.
CONFIG_READS = {"--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "-l", "--list"}
CONFIG_WRITES = {"--add", "--replace-all", "--unset", "--unset-all"}
CONFIG_SECTION_WRITES = {"--rename-section", "--remove-section"}
CONFIG_VALUE_OPTIONS = {"-f", "--file", "--blob", "--type", "--default", "--comment", "--value", "--url"}
CONFIG_VERBS = {"get", "list", "set", "unset", "rename-section", "remove-section", "edit"}
PUSH_VALUE_OPTIONS = {"-o", "--push-option", "--repo", "--receive-pack", "--exec"}
# Stand-ins no shell word can hold: lone surrogates. A decoded $'...' keeps none,
# and stdin's surrogateescape gives only U+DC80-U+DCFF.
COMPUTED = "\ud800"  # a value bash computes as it runs: $(...), backticks, arithmetic
CUT = "\ud801"  # where a $'...' held a NUL: see readings()
HEREDOC = "\ud802"  # HEREDOC<n>: a command reads heredoc n on stdin, see segments()
# A shell's options whose value is the next word: bash -o pipefail, -O extglob, --rcfile f.
SHELL_VALUE_OPTIONS = {"--rcfile", "--init-file"}


class Unreadable(Exception):
    pass


class Texts(list):
    """The command texts bash runs, and each heredoc's body by its number (a HEREDOC<n> word marks where)."""

    def __init__(self):
        super().__init__()
        self.heredocs = []


class Stdin:
    """What a simple command reads on stdin: the heredoc bodies and here-strings it is given (texts),
    and whether a pipe or a < file feeds it."""

    def __init__(self, piped=False):
        self.texts, self.piped, self.file = [], piped, False


def command_texts(text):
    """Every command text bash runs from `text`: the text itself and each substitution's body, heredoc bodies out."""
    texts = Texts()
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
            # ANSI-C quoting: \' inside does not close it. Its literal word, as
            # bash decodes it: $'git' push is git push.
            j = i + 2
            while j < len(t) and t[j] != "'":
                j += 2 if t[j] == "\\" else 1
            if j >= len(t):
                raise Unreadable("an unclosed $'...'")
            out.append(shlex.quote(ansi_c(t[i + 2 : j])))
            i = j + 1
        elif t.startswith(("$((", "(("), i):
            # Arithmetic: its << is a shift, not a heredoc. A substitution inside it still runs.
            i = arithmetic(t, i + (3 if c == "$" else 2), texts)
            out.append(COMPUTED)
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
            out.append(COMPUTED)
        elif c == "`":
            i, body = command(t, i + 1, "`", texts)
            texts.append(body)
            out.append(COMPUTED)
        elif c in "0123456789" and word_start(out) and FD_REDIRECT.match(t, i):
            # The fd of a redirect (2>&1, 2>/dev/null) is part of it, not a word of the command.
            i = FD_REDIRECT.match(t, i).end()
        elif c == "#" and word_start(out):
            end = t.find("\n", i)
            i = len(t) if end < 0 else end
        elif t.startswith("<<<", i):
            # A here-string: the word after it is the command's stdin (segments()).
            out.append(" <<< ")
            i += 3
        elif t.startswith("<<", i):
            m = HEREDOC_AT.match(t, i)
            if not m:
                raise Unreadable("a heredoc with no word")
            # The body is the command's stdin: a word marks it, and segments() hands it to the command.
            texts.heredocs.append("")
            pending.append((m.group(1) == "-", m.group(4), not (m.group(2) or m.group(3)), len(texts.heredocs) - 1))
            out.append(" %s%d " % (HEREDOC, len(texts.heredocs) - 1))
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


def word_start(out):
    """Whether the next character of the text read so far starts a word."""
    return not out or out[-1][-1:] in ("", " ", "\t", "\n", ";", "&", "|", "(")


ANSI_C = {"n": "\n", "t": "\t", "r": "\r", "a": "\a", "b": "\b", "f": "\f", "v": "\v", "e": "\x1b", "E": "\x1b", "\\": "\\", "'": "'", '"': '"', "?": "?"}


def ansi_c(body):
    """The literal text of a $'...' body: \\n, \\xHH, \\NNN (octal), \\uHHHH, \\UHHHHHHHH, \\cX and the rest, as bash reads them."""
    out, i = [], 0
    while i < len(body):
        c = body[i]
        if c != "\\" or i + 1 >= len(body):
            out.append(c)
            i += 1
            continue
        e = body[i + 1]
        if e in ANSI_C:
            out.append(ANSI_C[e])
            i += 2
        elif e in "xuU":
            digits = re.match(r"[0-9A-Fa-f]{1,%d}" % {"x": 2, "u": 4, "U": 8}[e], body[i + 2 :])
            code = int(digits.group(), 16) if digits else -1
            # No character (none, a surrogate, past U+10FFFF): kept as written.
            valid = 0 <= code <= 0x10FFFF and not 0xD800 <= code <= 0xDFFF
            out.append(chr(code) if valid else "\\" + e + (digits.group() if digits else ""))
            i += 2 + (len(digits.group()) if digits else 0)
        elif e in "01234567":
            digits = re.match(r"[0-7]{1,3}", body[i + 1 :]).group()
            out.append(chr(int(digits, 8) & 0xFF))  # one byte: \\777 is \\377
            i += 1 + len(digits)
        elif e == "c" and i + 2 < len(body):
            out.append(chr(ord(body[i + 2]) & 0x1F))
            i += 3
        else:
            out.append("\\" + e)
            i += 2
    text = "".join(out)
    # A NUL ends it: bash cuts the $'...' there, zsh the whole word (readings()).
    return text[: text.index("\0")] + CUT if "\0" in text else text


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
            out.append(COMPUTED)
        elif c == "`":
            i, body = command(t, i + 1, "`", texts)
            texts.append(body)
            out.append(COMPUTED)
        else:
            out.append(c)
            i += 1
    raise Unreadable("an unclosed double quote")


def heredoc_bodies(t, i, pending, texts):
    """Reads each pending heredoc's lines, its closing line included, into texts.heredocs. An unquoted one's
    substitutions run."""
    for strip_tabs, word, expands, number in pending:
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
        texts.heredocs[number] = "\n".join(lines)
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


def segments(text, heredocs=()):
    """Each simple command's words, and its Stdin: the heredocs and here-strings it reads, a pipe, a < file."""
    lexer = shlex.shlex(text, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    words, stdin, skip = [], Stdin(), None
    try:
        for token in lexer:
            if skip:
                if skip == "<<<":
                    stdin.texts.append(token)
                skip = None
            elif set(token) <= SEPARATOR:
                yield words, stdin
                words, stdin = [], Stdin(piped=token in ("|", "|&"))
            elif token.startswith(HEREDOC):
                stdin.texts.append(heredocs[int(token[len(HEREDOC) :])])
            elif REDIRECT.match(token):
                skip = token
                stdin.file = stdin.file or (token.startswith("<") and token != "<<<")
            else:
                words.append(token)
    except ValueError as error:
        raise Unreadable(str(error))
    yield words, stdin


def computed(word):
    """A word bash, xargs or find fills in as it runs: a $ expansion, a substitution, a brace or glob,
    find's {}. Or one no branch or path it prints can hold: a control character ($'main\\nPUSH x')."""
    return (
        COMPUTED in word
        or any(c in word for c in "$`?[")
        or ("{" in word and "}" in word)
        or any(c < " " or c == "\x7f" for c in word)
    )


def git_env(words):
    """What a command's words may set in git's environment: its config (GIT_CONFIG*, or a HOME= or
    XDG_CONFIG_HOME= that moves its global config), which can pick a push's branches or make any
    word a push; or another repository (GIT_DIR and the like)."""
    found = set()
    for word in words:
        name = word.split("=", 1)[0]
        if name.startswith("GIT_CONFIG") or (name in CONFIG_HOME_ENV and "=" in word):
            found.add("config")
        elif name in REPO_ENV:
            found.add("repo")
    return found


def readings(words):
    """The words as each shell runs them. Where a $'...' held a NUL, bash drops the rest of
    the $'...' ($'gi\\0x't is git) and zsh the rest of the word ($'main\\0'-x is main)."""
    if not any(CUT in w for w in words):
        return [words]
    return [[w.replace(CUT, "") for w in words], [w.split(CUT, 1)[0] for w in words]]


def command_word(words):
    """The index of the word bash runs, past VAR=value words and wrappers like env, sudo, time,
    xargs; whether xargs runs it, which adds words of its own to the command; whether a wrapper
    runs it in another directory (env -C, sudo -D); and (the wrapper, the text it runs) for env -S
    and script -c, or None."""
    i, via_xargs, moved, split = 0, False, False, None
    while i < len(words):
        if ASSIGNMENT.match(words[i]):
            i += 1
        elif os.path.basename(words[i]) in WRAPPERS:
            wrapper = os.path.basename(words[i])
            via_xargs = via_xargs or wrapper == "xargs"
            takes_values = WRAPPER_VALUE_OPTIONS.get(wrapper, set())
            i += 1
            while i < len(words) and words[i].startswith("-"):
                option, value = wrapper_option(words[i], takes_values)
                if option in takes_values and value is None:
                    value = words[i + 1] if i + 1 < len(words) else ""
                    i += 1
                i += 1
                moved = moved or (wrapper, option) in WRAPPER_CHDIR
                split = (wrapper, value) if (wrapper, option) in WRAPPER_SPLIT else split
            if i + WRAPPER_OPERANDS.get(wrapper, 0) < len(words):
                i += WRAPPER_OPERANDS.get(wrapper, 0)
        else:
            break
    return i, via_xargs, moved, split


def wrapper_option(word, takes_values):
    """One option word of a wrapper: (the option, its value in the same word or None). A short option
    that takes a value ends a bundle: sudo -Eu root, nice -n5."""
    if word.startswith("--"):
        option, equals, value = word.partition("=")
        return option, value if equals else None
    for k, c in enumerate(word[1:], 1):
        if "-" + c in takes_values:
            return "-" + c, word[k + 1 :] or None
    return word, None


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

    def flags(words):
        """The options: the words before `--`, after which each is an argument (rm -r -- -f removes a file named -f)."""
        return words[: words.index("--")] if "--" in words else words

    def shorts(words):
        return "".join(a[1:] for a in flags(words) if a.startswith("-") and not a.startswith("--"))

    def has(words, option):
        return option in flags(words)

    if name == "rm":
        recursive = any(c in shorts(args) for c in "rR") or has(args, "--recursive")
        force = "f" in shorts(args) or has(args, "--force")
        return "rm -rf" if recursive and force else None
    if name != "git":
        return None
    sub, rest = git_subcommand(args)
    if sub == "push":
        if any(a.startswith("--force") for a in flags(rest)):
            return "git push --force"
        return "git push -f" if "f" in shorts(rest) else None
    if sub == "reset" and has(rest, "--hard"):
        return "git reset --hard"
    if sub == "checkout" and "." in rest:
        return "git checkout \\."
    if sub == "clean" and ("f" in shorts(rest) or has(rest, "--force")):
        return "git clean -f"
    if sub == "config":
        return config_write(rest)
    if sub == "remote" and rest[:1] == ["set-url"]:
        return "git remote set-url"
    if sub == "branch":
        delete = "d" in shorts(rest) or has(rest, "--delete")
        force = "f" in shorts(rest) or has(rest, "--force")
        if "D" in shorts(rest) or (delete and force):
            return "git branch -D"
    return None


def config_pushes(key):
    """A config key that picks the branches a push takes: push.*, remote.<name>.push or .mirror."""
    key = key.lower()
    return key.startswith("push.") or re.fullmatch(r"remote\..+\.(push|mirror)", key) is not None


def config_commands(key):
    """A config key that can make a git word run something else: an alias, or a file of config it includes."""
    return key.lower().startswith(("alias.", "include.", "includeif."))


def config_write(args):
    """A git config write to a key that can hide a push, as gate (a)'s label; None for a read or another key.
    The keys: alias.*, include.* and includeIf.* (a file of config), push.*, remote.<name>.push, .url,
    .pushurl and .mirror, in any config file (--global, --system, --file too); and --edit, which writes any."""
    names, flags, skip = [], set(), False
    for a in args:
        if skip:
            skip = False
        elif a in CONFIG_VALUE_OPTIONS:
            skip = True
        elif a.startswith("-"):
            flags.add(a.split("=", 1)[0])
        else:
            names.append(a)
    verb = names.pop(0) if names and names[0] in CONFIG_VERBS else None
    if flags & CONFIG_READS or verb in ("get", "list"):
        return None
    if flags & {"-e", "--edit"} or verb == "edit":
        return "git config --edit"
    sections = bool(flags & CONFIG_SECTION_WRITES) or verb in ("rename-section", "remove-section")
    if not (sections or verb in ("set", "unset") or flags & CONFIG_WRITES or len(names) >= 2):
        return None  # git config <key>: a read
    for name in names[:2] if sections else names[:1]:
        if computed(name):
            return "git config (a key filled in as it runs)"
        section, _, rest = name.lower().partition(".")
        if section in ("alias", "push", "include", "includeif"):
            return "git config " + section + ".*"
        if section == "remote" and (sections or rest.rpartition(".")[2] in ("push", "url", "pushurl", "mirror")):
            return "git config remote.*"
    return None


def git_command(words, cwd, out, appended=False, env=frozenset()):
    """One git invocation (the words after `git`): what it commits or pushes. appended: xargs adds
    words of its own (the subcommand, a branch, a refspec), so a push can go anywhere. env: what
    the command sets in git's environment (git_env)."""
    i, directory, other_repo, by_config, aliased = 0, cwd, "repo" in env, False, False
    while i < len(words) and words[i].startswith("-"):
        option, value = words[i], None
        if option.startswith("--") and "=" in option:
            option, value = option.split("=", 1)
        elif option in GLOBAL_VALUE_OPTIONS and i + 1 < len(words):
            i += 1
            value = words[i]
        if option == "-C" and value is not None and directory is not None:
            directory = None if computed(value) else os.path.normpath(os.path.join(directory, os.path.expanduser(value)))
        elif option in ("-c", "--config-env") and value is not None:
            key = value.split("=", 1)[0]
            by_config = by_config or computed(value) or config_pushes(key)
            aliased = aliased or computed(value) or config_commands(key)
        elif option in OTHER_REPO:
            other_repo = True
        i += 1
    if "config" in env:
        out.append("PUSH @all")  # GIT_CONFIG*: config out of sight can pick any branch, or alias a push
    if aliased:
        out.append("PUSH @unknown")  # -c alias.*: any word can be a push
    if i >= len(words):
        if appended:
            out.append("PUSH @unknown")  # xargs adds the subcommand: push, maybe
        return
    sub, rest = words[i], words[i + 1 :]
    if computed(sub):
        out.append("PUSH @unknown")
        return
    unknown = other_repo or directory is None
    if sub == "commit":
        out.append("COMMIT @unknown" if unknown else "COMMIT " + directory)
    if sub != "push":
        return
    current = "PUSH @unknown" if unknown else "PUSH @current " + directory
    if by_config:
        out.append("PUSH @all")
    # A word bash computes can name any branch, or split into several (B="origin main").
    if appended or any(computed(word) for word in rest):
        out.append("PUSH @unknown")
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
        if computed(spec):
            continue
        dst = spec.split(":")[-1].lstrip("+")
        if dst.startswith("refs/heads/"):
            dst = dst[len("refs/heads/") :]
        out.append(current if dst in ("HEAD", "") else "PUSH " + dst)


def run(words, cwd, out, appended=False, env=frozenset(), stdin=None):
    """One simple command's words: what it commits, pushes or destroys, and the directory after it.
    appended: xargs runs it, or the shell or eval that runs it, and adds words of its own.
    env: what the command sets in git's environment (git_env). stdin: what it reads (Stdin)."""
    w, via_xargs, moved, split = command_word(words)
    appended = appended or via_xargs
    here = None if moved else cwd
    if split is not None:
        wrapper, text = split
        if wrapper == "env":
            # env -S 'git push …': its text, split into words (\_ is a space too), runs with the words after it.
            text = " ".join([text.replace("\\_", " ")] + [shlex.quote(a) for a in words[w:]])
        out.extend(analyse(text, here, appended, env))
        return cwd
    if w >= len(words):
        return cwd
    if moved:
        run(words[w:], None, out, appended, env, stdin)
        return cwd
    argv = words[w:]
    name = os.path.basename(argv[0])
    label = destructive(argv)
    if label:
        out.append("DESTRUCTIVE " + label)
    if name in ("cd", "pushd"):
        target = argv[1] if len(argv) > 1 else "~"
        if target == "-" or cwd is None or computed(target):
            return None
        return os.path.normpath(os.path.join(cwd, os.path.expanduser(target)))
    if computed(argv[0]) and "push" in argv[1:]:
        out.append("PUSH @unknown")  # $G push …: git, maybe
    if name not in ("git", "eval", "find", "echo", "printf"):
        # A wrapper it does not know (flock f git push …): a git push, or a destructive command,
        # later in its words.
        if any((os.path.basename(a) == "git" or computed(a)) and "push" in argv[k + 1 :] for k, a in enumerate(argv[1:], 1)):
            out.append("PUSH @unknown")
        later = next((d for d in (destructive(argv[k:]) for k in range(1, len(argv))) if d), None)
        if later and not label:
            out.append("DESTRUCTIVE " + later)
    if name == "git":
        git_command(argv[1:], cwd, out, appended, env)
    elif name in SHELLS:
        # sh -c '…' (or -lc, -ec) runs its text as a command: read it the same way.
        def runs_text(a, letter="c"):
            return a.startswith("-") and not a.startswith("--") and letter in a

        options, operands = shell_words(argv[1:])
        flag = next((k for k, a in enumerate(argv[1:-1], 1) if runs_text(a)), None)
        if flag is not None:
            out.extend(analyse(argv[flag + 1], cwd, appended, env))
        elif appended and runs_text(argv[-1]):
            out.append("PUSH @unknown")  # xargs sh -c: xargs adds the text it runs
        elif operands and COMPUTED in operands[0]:
            out.append("PUSH @unknown")  # bash <(…): a script the command makes as it runs
        elif not operands or any(runs_text(a, "s") for a in options):
            # No script: it runs its stdin. A heredoc or here-string is text it reads; a pipe, a < file, or -s
            # with neither, it cannot see. Flags alone (bash --version) read nothing.
            given = stdin.texts if stdin else []
            for text in given:
                out.extend(analyse(text, cwd, appended, env))
            fed = stdin is not None and (stdin.piped or stdin.file)
            if not given and (fed or any(runs_text(a, "s") for a in options)):
                out.append("PUSH @unknown")
    elif name == "eval":
        out.extend(analyse(" ".join(argv[1:]), cwd, appended, env))
    elif name == "find":
        # find -exec … ; runs the words after it for each file ({} is the file); -execdir in the file's directory.
        for k, word in enumerate(argv):
            if word in FIND_EXEC:
                command = argv[k + 1 :]
                end = next((j for j, x in enumerate(command) if x in (";", "+")), len(command))
                run(command[:end], None if word.endswith("dir") else cwd, out, appended, env)
    return cwd


def shell_words(args):
    """A shell's words after its name: (its options, its operands). The first operand is the script it runs;
    -o and -O take a value (bash -euo pipefail), as --rcfile does."""
    options, k = [], 0
    while k < len(args):
        a = args[k]
        if a == "--":
            return options, args[k + 1 :]
        if a[:1] not in ("-", "+") or len(a) < 2:
            return options, args[k:]
        options.append(a)
        takes_value = a in SHELL_VALUE_OPTIONS or (not a.startswith("--") and a[-1] in "oO")
        k += 2 if takes_value else 1
    return options, []


def analyse(text, cwd=".", appended=False, env=frozenset()):
    out = []
    texts = command_texts(text)
    parsed = [[(readings(words), stdin) for words, stdin in segments(t, texts.heredocs)] for t in texts]
    # A GIT_CONFIG* or GIT_DIR word anywhere (VAR=x git, env, export) holds for every git the text runs.
    env = env.union(*(git_env(r) for command_segments in parsed for rs, _ in command_segments for r in rs))
    for command_segments in parsed:
        here = cwd
        for (first, *others), stdin in command_segments:
            found = []
            after = run(first, here, found, appended, env, stdin)
            for other in others:
                more = []
                if run(other, here, more, appended, env, stdin) != after:
                    after = None
                found.extend(line for line in more if line not in found)
            out.extend(found)
            here = after
    return out


def main():
    try:
        out = analyse(sys.stdin.read())
    except Unreadable as error:
        raise SystemExit("unreadable: " + str(error))
    # One finding a line: a word that could split a line, or not print, is never one.
    if not all(line.isprintable() for line in out):
        raise SystemExit("unreadable: a word it cannot print")
    print("\n".join(out + ["END"]))


if __name__ == "__main__":
    main()
