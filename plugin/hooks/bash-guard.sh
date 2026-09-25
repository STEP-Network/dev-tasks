#!/bin/bash

# STEP-wide policy: gates (a) destructive commands (incl. --force), (c)
# pre-push validation marker, and (f) protected-branch push block are always-on
# regardless of project-config.hooks.enabled[]. Gate (b), which refused a
# commit until self-review had passed, was RETIRED in 1.0: review moved to the
# CI `Claude review` required check (spec sections 4 and 10). The letters of
# the surviving gates are deliberately NOT renumbered — the hook tests, the
# plugin README and PolAds's .claude/hooks/README.md all name them by letter.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-agent-cwd.sh"

# Redirect stdout to stderr so block messages (exit 2) reach Claude Code
# correctly. Per Claude Code hooks spec, block reasons must be on stderr.
exec >&2

# Hook: PreToolUse (Bash)
# Five gates:
#   (a) Block destructive commands
#   (c) SHA-scoped pre-push gate (Fix 5)
#   (d) i18n locale parity — block commit if staged default-locale file has NEW keys
#       missing from other configured locale files. Active only when
#       project-config.i18n.enabled = true.
#   (e) i18n completeness — block commit when project-config.i18n.parityHookMode = "block"
#       and the branch has modified some but not all configured locale files.
#   At a merge commit, (d) and (e) read only what is new over both parents
#   (STEP-3348): what the branch merged in brought was checked where it was made.
#   (f) Protected-branch push block — hard-refuse `git push` to any branch in
#       project-config.git.protectedBranches[] (default: main staging master
#       production prod). No marker bypass. Set list to [] to disable.
# Input: JSON on stdin with tool_input.command
#
# Fail closed (STEP-3354): a check that cannot run blocks the command, never
# lets it through. No python3 or jq, input that is not the payload, a project
# config that is there but unreadable, a git error, a snippet that fails or
# prints no verdict: each blocks, saying why. Each Python snippet prints an
# explicit verdict (OK, MISSING_KEYS, INCOMPLETE, END), and anything else is
# a failure. Only a config file that is absent means "not configured".

# Blocks the command, from the hook's own shell or from a $(...) inside it,
# whose caller then ends with `|| exit 2`: the reason goes to stderr either way.
fail_closed() {
  echo "BLOCKED: bash-guard could not check this command: $1" >&2
  echo "Nothing was run. A person needs to fix what the check needs (python3, jq, git, the project config) first." >&2
  exit 2
}

# The value at a jq path of project-config.json, or nothing when the file is
# absent. A file that is there but cannot be read (no jq, bad JSON) blocks:
# a gate it configures must not quietly turn off.
guard_config() {
  local path out
  path="$(_project_config_path)"
  [ -f "$path" ] || return 0
  command -v jq >/dev/null 2>&1 || fail_closed "jq is not on PATH, so it cannot read $path"
  out=$(jq -r "($1) // empty" "$path" 2>&1) || fail_closed "it cannot read $path: $(printf '%s' "$out" | head -n 1)"
  printf '%s' "$out"
}

# Read tool input from stdin (consumed once)
INPUT=$(cat)

# Extract the command from JSON. An empty command runs nothing; input that is
# not a Bash payload, or no python3, blocks.
command -v python3 >/dev/null 2>&1 || fail_closed "python3 is not on PATH, so it cannot read the command"
ACTUAL_CMD=$(printf '%s' "$INPUT" | python3 -c "
import sys, json
command = json.load(sys.stdin)['tool_input']['command']
if not isinstance(command, str):
    raise SystemExit('the command is not text')
sys.stdout.write(command)
" 2>/dev/null) || fail_closed "the hook's input is not a Bash command it can read"
if [ -z "$ACTUAL_CMD" ]; then
  exit 0
fi

# Resolve project root. Prefer the agent's actual cwd from the hook payload —
# CLAUDE_PROJECT_DIR is pinned to the main checkout at session start and is
# wrong when the agent is in a worktree. See lib/resolve-agent-cwd.sh.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_CWD=$(resolve_agent_cwd "$INPUT")
PROJECT_ROOT="${AGENT_CWD:-${CLAUDE_PROJECT_DIR:-$PWD}}"

# (a) Block destructive commands
DESTRUCTIVE_PATTERNS=(
  "rm -rf"
  "git push --force"
  "git push -f"
  "git reset --hard"
  "git checkout \."
  "git clean -f"
  "git branch -D"
)
# Note: SQL DDL keywords (DROP TABLE, TRUNCATE, DROP DATABASE) removed —
# SQL operations run through Neon MCP tools, not bash. Matching against
# the full command string caused false positives on gh pr comment bodies.

for pattern in "${DESTRUCTIVE_PATTERNS[@]}"; do
  if echo "$ACTUAL_CMD" | grep -qi "$pattern"; then
    echo "BLOCKED: Destructive command detected: '$pattern'"
    echo "If this is intentional, ask the user for explicit confirmation first."
    exit 2
  fi
done

# Gates (d) and (e) are agent-only (spec section 4). A human's parity miss is
# caught by the CI `i18n` job within a minute of the push; an agent has no
# equivalent feedback inside its own session, so the commit-time gate stays.
# Resolving the profile BEFORE reading the i18n config also means a human
# laptop pays no jq calls for a feature that cannot fire.
source "$(dirname "${BASH_SOURCE[0]}")/lib/profile.sh"
if profile_is agent; then

# Resolve i18n config once for sections (d) and (e). Both are dormant unless
# project-config.i18n.enabled = true.
I18N_ENABLED=$(guard_config '.i18n.enabled') || exit 2
I18N_DEFAULT_LOCALE=$(guard_config '.i18n.defaultLocale') || exit 2
[ -z "$I18N_DEFAULT_LOCALE" ] && I18N_DEFAULT_LOCALE="en"
I18N_MESSAGES_GLOB=$(guard_config '.i18n.messagesGlob') || exit 2
[ -z "$I18N_MESSAGES_GLOB" ] && I18N_MESSAGES_GLOB="messages/*.json"
I18N_MESSAGES_DIR=$(dirname "$I18N_MESSAGES_GLOB")
I18N_LOCALES_CSV=$(guard_config '(.i18n.locales // []) | join(",")') || exit 2
I18N_PARITY_MODE=$(guard_config '.i18n.parityHookMode') || exit 2
[ -z "$I18N_PARITY_MODE" ] && I18N_PARITY_MODE="block"

# (d) i18n locale parity: if committing and the configured default-locale file is staged
#     with NEW keys, verify those keys exist in ALL other configured locale files.
#     Only checks newly added keys — pre-existing gaps don't block.
if echo "$ACTUAL_CMD" | grep -q "git commit" && [ "$I18N_ENABLED" = "true" ]; then
  DEFAULT_FILE="${I18N_MESSAGES_DIR}/${I18N_DEFAULT_LOCALE}.json"
  EN_STAGED=$(cd "$PROJECT_ROOT" && git diff --cached --name-only -- "$DEFAULT_FILE" 2>&1) \
    || fail_closed "git could not list the staged files: $(printf '%s' "$EN_STAGED" | head -n 1)"
  if [ -n "$EN_STAGED" ]; then
    # Python's own errors join its output: anything but a verdict on the first line blocks.
    I18N_RESULT=$(cd "$PROJECT_ROOT" && I18N_MESSAGES_DIR="$I18N_MESSAGES_DIR" I18N_DEFAULT_LOCALE="$I18N_DEFAULT_LOCALE" python3 -c "
import json, glob, os, sys, subprocess, re

messages_dir = os.environ.get('I18N_MESSAGES_DIR', 'messages')
default_locale = os.environ.get('I18N_DEFAULT_LOCALE', 'en')
default_path = os.path.join(messages_dir, default_locale + '.json')
if not os.path.exists(default_path):
    # Staged as deleted: no key is added.
    print('OK')
    sys.exit(0)

# A git command that fails stops the check: its error is the output, and no verdict.
def git(*args):
    r = subprocess.run(['git', *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit('git ' + ' '.join(args) + ' failed: ' + r.stderr.strip())
    return r.stdout

# Keys on the added lines of the staged diff of the default-locale file
# (lines starting with +, excluding the +++ header), against HEAD or the given commit.
# Match JSON keys like: \"keyName\": ...
def added(*against):
    diff = git('diff', '--cached', '-U0', '--end-of-options', *against, '--', default_path)
    keys = set()
    for line in diff.split('\n'):
        if line.startswith('+') and not line.startswith('+++'):
            match = re.search(r'\"([^\"]+)\"\s*:', line)
            if match:
                keys.add(match.group(1))
    return keys

# The commit a merge in progress merges in, from the file git writes for one,
# or None. Never the name: a branch called MERGE_HEAD is no merge (STEP-3351).
# Only a commit id (sha1 or sha256): any other line is no merge, as one that
# starts with a dash would reach git diff as an option (--output= writes a file).
def merged_in():
    path = git('rev-parse', '--git-path', 'MERGE_HEAD').strip()
    try:
        with open(path) as f:
            line = f.readline().strip()
    except FileNotFoundError:
        return None
    return line if re.fullmatch(r'[0-9a-f]{40}([0-9a-f]{24})?', line) else None

added_keys = added()
# A merge commit's own keys are new over both parents (STEP-3348): a key the
# branch merged in already has came with it, checked where it was added.
merge_head = merged_in()
if merge_head:
    added_keys &= added(merge_head)

if not added_keys:
    print('OK')
    sys.exit(0)

# Check each locale file for the added keys
locale_files = sorted(glob.glob(os.path.join(messages_dir, '*.json')))
missing = []
for lf in locale_files:
    locale = os.path.basename(lf).replace('.json', '')
    if locale == default_locale:
        continue
    with open(lf) as f:
        content = f.read()
    locale_missing = []
    for key in sorted(added_keys):
        if '\"' + key + '\"' not in content:
            locale_missing.append(key)
    if locale_missing:
        missing.append(f'  {locale}.json: missing {len(locale_missing)} key(s): {\", \".join(locale_missing)}')

if missing:
    print('MISSING_KEYS')
    print('\n'.join(missing))
else:
    print('OK')
" 2>&1)
    I18N_VERDICT=$(printf '%s\n' "$I18N_RESULT" | head -n 1)
    if [ "$I18N_VERDICT" != "OK" ] && [ "$I18N_VERDICT" != "MISSING_KEYS" ]; then
      fail_closed "the i18n locale parity check did not finish: $(printf '%s\n' "$I18N_RESULT" | tail -n 1)"
    fi

    if [ "$I18N_VERDICT" = "MISSING_KEYS" ]; then
      LOCALE_COUNT=$(guard_config '(.i18n.locales // []) | length') || exit 2
      { [ -z "$LOCALE_COUNT" ] || [ "$LOCALE_COUNT" = "0" ]; } && LOCALE_COUNT="all configured"
      echo "BLOCKED: i18n locale parity check failed."
      echo ""
      echo "New keys added to ${I18N_MESSAGES_DIR}/${I18N_DEFAULT_LOCALE}.json are missing from other locale files:"
      echo "$I18N_RESULT" | tail -n +2
      echo ""
      echo "Every new i18n key MUST be added to ALL ${LOCALE_COUNT} locale files in ${I18N_MESSAGES_DIR}/."
      echo "Verify with: grep -r '\"keyName\"' ${I18N_MESSAGES_DIR}/ | wc -l (must equal ${LOCALE_COUNT})"
      exit 2
    fi
  fi
fi

# (e) i18n completeness: if committing locale files, verify that ALL configured locale
#     files have been modified on this branch (staged + already committed).
#     parityHookMode controls behavior: "block" exits 2, "warn" prints to stderr,
#     "off" skips entirely. Default "block".
if echo "$ACTUAL_CMD" | grep -q "git commit" && [ "$I18N_ENABLED" = "true" ] && [ "$I18N_PARITY_MODE" != "off" ]; then
  I18N_STAGED=$(cd "$PROJECT_ROOT" && git diff --cached --name-only -- "$I18N_MESSAGES_GLOB" 2>&1) \
    || fail_closed "git could not list the staged locale files: $(printf '%s' "$I18N_STAGED" | head -n 1)"
  if [ -n "$I18N_STAGED" ]; then
    DEFAULT_BASE_BRANCH=$(guard_config '.git.defaultBase') || exit 2
    [ -z "$DEFAULT_BASE_BRANCH" ] && DEFAULT_BASE_BRANCH="main"
    I18N_COMPLETENESS=$(cd "$PROJECT_ROOT" && I18N_MESSAGES_DIR="$I18N_MESSAGES_DIR" I18N_LOCALES_CSV="$I18N_LOCALES_CSV" I18N_BASE_BRANCH="$DEFAULT_BASE_BRANCH" python3 -c "
import subprocess, os, sys, re

messages_dir = os.environ.get('I18N_MESSAGES_DIR', 'messages')
locales_csv = os.environ.get('I18N_LOCALES_CSV', '')
base_branch = os.environ.get('I18N_BASE_BRANCH', 'main')

if not locales_csv:
    # No locales list in project-config — cannot verify completeness
    print('OK')
    sys.exit(0)

all_locales = sorted([l.strip() for l in locales_csv.split(',') if l.strip()])
expected = len(all_locales)

# A git command that fails stops the check: its error is the output, and no verdict.
def git(*args):
    r = subprocess.run(['git', *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit('git ' + ' '.join(args) + ' failed: ' + r.stderr.strip())
    return r.stdout

# The base as this checkout has it: the local branch, else origin's copy.
# Neither is no base to compare with, and stops the check.
def base_ref():
    for ref in (base_branch, 'origin/' + base_branch):
        if subprocess.run(['git', 'rev-parse', '-q', '--verify', '--end-of-options', ref + '^{commit}'], capture_output=True).returncode == 0:
            return ref
    raise SystemExit('the base branch ' + base_branch + ' is not in this checkout, locally or on origin')

# Branch diff: committed changes since divergence from base
branch_diff = git('diff', '--name-only', base_ref() + '...HEAD', '--', messages_dir + '/').strip().split('\n')

# Staged changes (about to be committed). A merge commit's own are the files
# that differ from both parents (STEP-3348).
def staged_names(*against):
    return git('diff', '--cached', '--name-only', '--end-of-options', *against, '--', messages_dir + '/').strip().split('\n')

# The commit a merge in progress merges in, from the file git writes for one:
# never the name, which a branch can take (STEP-3351). Only a commit id: any
# other line is no merge, as one that starts with a dash would be an option.
def merged_in():
    path = git('rev-parse', '--git-path', 'MERGE_HEAD').strip()
    try:
        with open(path) as f:
            line = f.readline().strip()
    except FileNotFoundError:
        return None
    return line if re.fullmatch(r'[0-9a-f]{40}([0-9a-f]{24})?', line) else None

staged = staged_names()
merge_head = merged_in()
if merge_head:
    merged = set(staged_names(merge_head))
    staged = [f for f in staged if f in merged]

# Combine: branch diff + staged
all_modified = set()
for f in branch_diff + staged:
    f = f.strip()
    if f and f.startswith(messages_dir + '/') and f.endswith('.json'):
        locale = os.path.basename(f).replace('.json', '')
        if locale in all_locales:
            all_modified.add(locale)

# 0 modified = nothing to validate; all modified = complete; in between = incomplete
if len(all_modified) == 0 or len(all_modified) >= expected:
    print('OK')
    sys.exit(0)

missing = sorted(set(all_locales) - all_modified)
print('INCOMPLETE')
print(f'Branch has {len(all_modified)}/{expected} locale files modified (committed + staged)')
print(f'Modified: {\", \".join(sorted(all_modified))}')
print(f'Missing ({len(missing)}): {\", \".join(missing)}')
" 2>&1)
    I18N_VERDICT=$(printf '%s\n' "$I18N_COMPLETENESS" | head -n 1)
    if [ "$I18N_VERDICT" != "OK" ] && [ "$I18N_VERDICT" != "INCOMPLETE" ]; then
      fail_closed "the i18n completeness check did not finish: $(printf '%s\n' "$I18N_COMPLETENESS" | tail -n 1)"
    fi

    if [ "$I18N_VERDICT" = "INCOMPLETE" ]; then
      if [ "$I18N_PARITY_MODE" = "block" ]; then
        echo "BLOCKED: i18n completeness check failed."
        echo ""
        echo "$I18N_COMPLETENESS" | tail -n +2
        echo ""
        echo "When modifying i18n keys, ALL configured locale files must be updated."
        echo "Update the missing locale files, then stage them with: git add ${I18N_MESSAGES_DIR}/"
        exit 2
      else
        # warn mode
        echo "WARNING: i18n completeness check — partial locale coverage."
        echo "$I18N_COMPLETENESS" | tail -n +2
        echo ""
        echo "(parityHookMode = \"warn\" — proceeding without blocking; set to \"block\" to enforce)"
      fi
    fi
  fi
fi
fi
# end of gates (d) and (e)

# (f) Protected-branch push block: hard-refuse `git push` whose target ref
# matches any branch in project-config.git.protectedBranches[] (default list:
# main staging master production prod). No marker bypass — direct push to
# these branches must go through a PR. Server-side GitHub branch protection
# is the unforgeable complement; this hook stops bypass at the local layer.
# Any command with the words git and push: the parse below finds each real push, behind global options (git -C dir push) too.
if printf '%s' "$ACTUAL_CMD" | grep -qw git && printf '%s' "$ACTUAL_CMD" | grep -qw push; then
  # The list:
  #   no project config at all            → default list
  #   key absent (or .git absent)         → default list
  #   key explicitly [] (or [null])       → gate disabled
  #   key set to ["a", "b", ...]          → that list
  #   a config there but unreadable       → blocked (fail closed)
  if [ -f "$(_project_config_path)" ]; then
    PROTECTED_RAW=$(guard_config '((.git // {}).protectedBranches // "__DEFAULT__") | if type == "string" then . else join(" ") end') || exit 2
  else
    PROTECTED_RAW="__DEFAULT__"
  fi
  if [ "$PROTECTED_RAW" = "__DEFAULT__" ]; then
    PROTECTED_BRANCHES="main staging master production prod"
  else
    PROTECTED_BRANCHES="$PROTECTED_RAW"  # may be empty string → gate disabled
  fi

  # Every branch the command pushes to, one per line, then END (STEP-3354):
  # every git push in it, every refspec of each (SRC:DST, :DST, +DST,
  # refs/heads/DST), and the remote's word too, since an option's value can
  # shift it. @current is the branch checked out (no refspec, or HEAD), @all a
  # push of every branch (--all, --mirror, --branches). A command it cannot
  # read (an unclosed quote, no python3) gives no END, and the push is refused.
  PUSH_TARGETS=$(printf '%s' "$ACTUAL_CMD" | python3 -c "
import sys, os, shlex
lexer = shlex.shlex(sys.stdin.read(), posix=True, punctuation_chars=True)
lexer.whitespace_split = True
tokens = list(lexer)
VALUE_OPTIONS = {'-o', '--push-option', '--repo', '--receive-pack', '--exec'}
GLOBAL_VALUE_OPTIONS = {'-C', '-c'}
segments, segment = [], []
for t in tokens:
    if set(t) <= set(';&|()'):
        segments.append(segment)
        segment = []
    else:
        segment.append(t)
segments.append(segment)
targets = []
for seg in segments:
    for g, word in enumerate(seg):
        if os.path.basename(word) != 'git':
            continue
        i, skip = g + 1, False
        while i < len(seg) and (skip or seg[i].startswith('-')):
            skip = not skip and seg[i] in GLOBAL_VALUE_OPTIONS
            i += 1
        if i >= len(seg) or seg[i] != 'push':
            continue
        args, skip = [], False
        for t in seg[i + 1:]:
            if skip:
                skip = False
            elif t in VALUE_OPTIONS:
                skip = True
            elif t in ('--all', '--mirror', '--branches'):
                targets.append('@all')
            elif not t.startswith('-'):
                args.append(t)
        if len(args) < 2:
            targets.append('@current')
        for spec in args:
            dst = spec.split(':')[-1].lstrip('+')
            if dst.startswith('refs/heads/'):
                dst = dst[len('refs/heads/'):]
            targets.append('@current' if dst in ('HEAD', '') else dst)
print('\n'.join(targets + ['END']))
" 2>&1)
  [ "$(printf '%s\n' "$PUSH_TARGETS" | tail -n 1)" = "END" ] \
    || fail_closed "it cannot tell which branches this push goes to: $(printf '%s\n' "$PUSH_TARGETS" | tail -n 1)"

  TARGET_REF=""
  while IFS= read -r target; do
    case "$target" in
      END|"") continue ;;
      @all)
        if [ -n "$PROTECTED_BRANCHES" ]; then
          echo "BLOCKED: A push of every branch includes the protected ones ($PROTECTED_BRANCHES)."
          echo "Push the one feature branch by name, and open a PR for it."
          exit 2
        fi
        continue
        ;;
      @current)
        target=$(cd "$PROJECT_ROOT" && git rev-parse --abbrev-ref HEAD 2>&1) \
          || fail_closed "git could not name the branch this push goes to: $target"
        ;;
    esac
    for protected in $PROTECTED_BRANCHES; do
      [ "$target" = "$protected" ] && TARGET_REF="$target" && break 2
    done
  done <<EOF
$PUSH_TARGETS
EOF

  if [ -n "$TARGET_REF" ]; then
    echo "BLOCKED: Direct push to protected branch '$TARGET_REF' is forbidden."
    echo ""
    echo "Protected branches (from project-config.git.protectedBranches[]):"
    echo "  $PROTECTED_BRANCHES"
    echo ""
    echo "All changes to protected branches must land via a Pull Request:"
    echo "  1. Push to a feature branch: git push origin feat/<slug>"
    echo "  2. Open a PR with /ship (typecheck + traceable PR + auto-merge)"
    echo "  3. Bot review + CI complete, then merge via the PR"
    echo ""
    echo "Server-side complement: configure GitHub branch protection on '$TARGET_REF'"
    echo "to enforce this at the platform level (prevents bypass via direct git push)."
    exit 2
  fi
fi

# (c) SHA-scoped pre-push gate: if command contains 'git push', check marker + SHA.
# Opt-out: project-config.git.prePushMarker = false, for consumers whose CI is
# the validation authority (the PR runs the same build/lint/test within a
# minute of the push). Default true keeps today's behaviour for everyone else.
# The config read stays INSIDE the git-push branch so a non-push command keeps
# the original cheap grep short-circuit and never spawns jq.
if echo "$ACTUAL_CMD" | grep -q "git push"; then
  # NOTE: deliberately NOT `.git.prePushMarker // true` — jq's `//` treats a
  # literal `false` the same as `null`/absent, so that form always evaluates to
  # `true` and the opt-out could never fire. Use an explicit null check instead.
  PREPUSH_MARKER=$(guard_config '(.git.prePushMarker | if . == null then true else . end) | tostring') || exit 2
  if [ "$PREPUSH_MARKER" != "false" ]; then
    BRANCH=$(cd "$PROJECT_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    SAFE_BRANCH=$(echo "$BRANCH" | tr '/' '-')
    MARKER="/tmp/.claude-prepush-${SAFE_BRANCH}"

    if [ ! -f "$MARKER" ]; then
      echo "BLOCKED: Pre-push gate failed — no validation marker found."
      echo "You must run /ship (which runs typecheck before pushing) before pushing."
      echo ""
      echo "Alternatively, run: pnpm build && pnpm lint && pnpm test"
      echo "Then create the marker: echo \$(git rev-parse HEAD) > $MARKER"
      echo ""
      echo "Opt out entirely (CI as the validation authority instead): set"
      echo "  git.prePushMarker: false"
      echo "in .claude/project-config.json."
      exit 2
    fi

    # Fix 5: Verify the marker SHA matches current HEAD
    MARKER_SHA=$(cat "$MARKER" 2>/dev/null | tr -d '[:space:]')
    HEAD_SHA=$(cd "$PROJECT_ROOT" && git rev-parse HEAD 2>/dev/null)

    # If the marker contains a SHA (not empty, not just "touched"), verify it matches
    if [ -n "$MARKER_SHA" ] && [ ${#MARKER_SHA} -ge 7 ]; then
      if [ "$MARKER_SHA" != "$HEAD_SHA" ]; then
        echo "BLOCKED: Pre-push gate failed — validation marker is STALE."
        echo ""
        echo "Marker was created for commit: ${MARKER_SHA:0:7}"
        echo "Current HEAD is:               ${HEAD_SHA:0:7}"
        echo ""
        echo "New commits were made after the last validation. Re-run:"
        echo "  pnpm build && pnpm lint && pnpm test"
        echo "  echo \$(git rev-parse HEAD) > $MARKER"
        echo ""
        echo "Or run /ship, which typechecks before it pushes. Opt out entirely"
        echo "with git.prePushMarker: false in .claude/project-config.json."
        exit 2
      fi
    fi

    echo "Pre-push gate: PASSED (marker valid for branch: $BRANCH, SHA: ${HEAD_SHA:0:7})"
  fi
fi

exit 0
