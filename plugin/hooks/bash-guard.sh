#!/bin/bash

# STEP-wide policy: gates (a) destructive commands (incl. --force), (b)
# self-review before commit, (c) pre-push validation marker, and (f) protected-
# branch push block are always-on regardless of project-config.hooks.enabled[].
# The previous opt-in gate was lifted as part of the multi-project alignment
# (Phase 3). Gates (d)(e) — i18n parity — remain conditional on
# project-config.i18n.enabled = true. Gate (f) is configurable via
# project-config.git.protectedBranches[] (empty array disables; default list:
# main staging master production prod).
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"

# Redirect stdout to stderr so block messages (exit 2) reach Claude Code
# correctly. Per Claude Code hooks spec, block reasons must be on stderr.
exec >&2

# Hook: PreToolUse (Bash)
# Six gates:
#   (a) Block destructive commands
#   (b) Block git commit without self-review (Fix 1)
#   (c) SHA-scoped pre-push gate (Fix 5)
#   (d) i18n locale parity — block commit if staged default-locale file has NEW keys
#       missing from other configured locale files. Active only when
#       project-config.i18n.enabled = true.
#   (e) i18n completeness — block commit when project-config.i18n.parityHookMode = "block"
#       and the branch has modified some but not all configured locale files.
#   (f) Protected-branch push block — hard-refuse `git push` to any branch in
#       project-config.git.protectedBranches[] (default: main staging master
#       production prod). No marker bypass. Set list to [] to disable.
# Input: JSON on stdin with tool_input.command

# Read tool input from stdin (consumed once)
INPUT=$(cat)

# Extract the command from JSON
ACTUAL_CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)
if [ -z "$ACTUAL_CMD" ]; then
  exit 0  # Can't parse input, don't block
fi

# Resolve project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

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

STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"

# (b) Pre-commit gate: block git commit if self-review has not passed
if echo "$ACTUAL_CMD" | grep -q "git commit"; then
  if [ -f "$STATE_FILE" ]; then
    SELF_REVIEW_PASSED=$(STATE_FILE_PATH="$STATE_FILE" python3 -c "
import json, os, sys
try:
    with open(os.environ['STATE_FILE_PATH']) as f:
        state = json.load(f)
    print('true' if state.get('selfReviewPassed') else 'false')
except Exception:
    print('false')
" 2>/dev/null)

    if [ "$SELF_REVIEW_PASSED" != "true" ]; then
      echo "BLOCKED: Cannot commit — self-review has NOT passed."
      echo ""
      echo "The post-implementation pipeline requires self-review before committing:"
      echo "  1. Run /self-review (iterative until all 10 checks pass)"
      echo "  2. Self-review sets selfReviewPassed: true in .claude/active-task.json"
      echo "  3. Then you can commit and proceed to /ship-pr"
      echo ""
      echo "This gate prevents shipping unreviewed code."
      exit 2
    fi
  fi
  # No state file = no active task enforcement on commit (task-state-guard handles edits)
fi

# Resolve i18n config once for sections (d) and (e). Both are dormant unless
# project-config.i18n.enabled = true.
I18N_ENABLED=$(read_project_config '.i18n.enabled')
I18N_DEFAULT_LOCALE=$(read_project_config '.i18n.defaultLocale')
[ -z "$I18N_DEFAULT_LOCALE" ] && I18N_DEFAULT_LOCALE="en"
I18N_MESSAGES_GLOB=$(read_project_config '.i18n.messagesGlob')
[ -z "$I18N_MESSAGES_GLOB" ] && I18N_MESSAGES_GLOB="messages/*.json"
I18N_MESSAGES_DIR=$(dirname "$I18N_MESSAGES_GLOB")
I18N_LOCALES_CSV=$(read_project_config '.i18n.locales | join(",")')
I18N_PARITY_MODE=$(read_project_config '.i18n.parityHookMode')
[ -z "$I18N_PARITY_MODE" ] && I18N_PARITY_MODE="block"

# (d) i18n locale parity: if committing and the configured default-locale file is staged
#     with NEW keys, verify those keys exist in ALL other configured locale files.
#     Only checks newly added keys — pre-existing gaps don't block.
if echo "$ACTUAL_CMD" | grep -q "git commit" && [ "$I18N_ENABLED" = "true" ]; then
  DEFAULT_FILE="${I18N_MESSAGES_DIR}/${I18N_DEFAULT_LOCALE}.json"
  EN_STAGED=$(cd "$PROJECT_ROOT" && git diff --cached --name-only -- "$DEFAULT_FILE" 2>/dev/null)
  if [ -n "$EN_STAGED" ]; then
    I18N_RESULT=$(cd "$PROJECT_ROOT" && I18N_MESSAGES_DIR="$I18N_MESSAGES_DIR" I18N_DEFAULT_LOCALE="$I18N_DEFAULT_LOCALE" python3 -c "
import json, glob, os, sys, subprocess, re

messages_dir = os.environ.get('I18N_MESSAGES_DIR', 'messages')
default_locale = os.environ.get('I18N_DEFAULT_LOCALE', 'en')
default_path = os.path.join(messages_dir, default_locale + '.json')
if not os.path.exists(default_path):
    sys.exit(0)

# Get the staged diff for the default-locale file — extract added lines with key patterns
diff = subprocess.run(
    ['git', 'diff', '--cached', '-U0', '--', default_path],
    capture_output=True, text=True
).stdout

# Find keys on added lines (lines starting with +, excluding +++ header)
# Match JSON keys like: \"keyName\": ...
added_keys = set()
for line in diff.split('\n'):
    if line.startswith('+') and not line.startswith('+++'):
        match = re.search(r'\"([^\"]+)\"\s*:', line)
        if match:
            added_keys.add(match.group(1))

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
" 2>/dev/null)

    if echo "$I18N_RESULT" | grep -q "MISSING_KEYS"; then
      LOCALE_COUNT=$(read_project_config '.i18n.locales | length')
      [ -z "$LOCALE_COUNT" ] && LOCALE_COUNT="all configured"
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
  I18N_STAGED=$(cd "$PROJECT_ROOT" && git diff --cached --name-only -- "$I18N_MESSAGES_GLOB" 2>/dev/null)
  if [ -n "$I18N_STAGED" ]; then
    DEFAULT_BASE_BRANCH=$(read_project_config '.git.defaultBase')
    [ -z "$DEFAULT_BASE_BRANCH" ] && DEFAULT_BASE_BRANCH="main"
    I18N_COMPLETENESS=$(cd "$PROJECT_ROOT" && I18N_MESSAGES_DIR="$I18N_MESSAGES_DIR" I18N_LOCALES_CSV="$I18N_LOCALES_CSV" I18N_BASE_BRANCH="$DEFAULT_BASE_BRANCH" python3 -c "
import subprocess, os, sys

messages_dir = os.environ.get('I18N_MESSAGES_DIR', 'messages')
locales_csv = os.environ.get('I18N_LOCALES_CSV', '')
base_branch = os.environ.get('I18N_BASE_BRANCH', 'main')

if not locales_csv:
    # No locales list in project-config — cannot verify completeness
    print('OK')
    sys.exit(0)

all_locales = sorted([l.strip() for l in locales_csv.split(',') if l.strip()])
expected = len(all_locales)

# Branch diff: committed changes since divergence from base
branch_diff = subprocess.run(
    ['git', 'diff', '--name-only', f'{base_branch}...HEAD', '--', messages_dir + '/'],
    capture_output=True, text=True
).stdout.strip().split('\n')

# Staged changes (about to be committed)
staged = subprocess.run(
    ['git', 'diff', '--cached', '--name-only', '--', messages_dir + '/'],
    capture_output=True, text=True
).stdout.strip().split('\n')

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
" 2>/dev/null)

    if echo "$I18N_COMPLETENESS" | grep -q "INCOMPLETE"; then
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

# (f) Protected-branch push block: hard-refuse `git push` whose target ref
# matches any branch in project-config.git.protectedBranches[] (default list:
# main staging master production prod). No marker bypass — direct push to
# these branches must go through a PR. Server-side GitHub branch protection
# is the unforgeable complement; this hook stops bypass at the local layer.
if echo "$ACTUAL_CMD" | grep -q "git push"; then
  # Distinguish three cases:
  #   key absent (or .git absent)        → use default list
  #   key explicitly [] (or [null])      → gate disabled
  #   key set to ["a", "b", ...]         → use that list
  PROTECTED_RAW=$(read_project_config '((.git // {}).protectedBranches // "__DEFAULT__") | if type == "string" then . else join(" ") end')
  if [ "$PROTECTED_RAW" = "__DEFAULT__" ]; then
    PROTECTED_BRANCHES="main staging master production prod"
  else
    PROTECTED_BRANCHES="$PROTECTED_RAW"  # may be empty string → gate disabled
  fi

  # Parse target ref. Forms: `git push`, `git push origin`, `git push origin BRANCH`,
  # `git push -u origin BRANCH`, `git push origin SRC:DST`, `git push origin :DST`,
  # `git push --delete origin BRANCH`, `git push origin HEAD:DST`.
  TARGET_REF=$(echo "$ACTUAL_CMD" | python3 -c "
import sys, shlex
raw = sys.stdin.read().strip()
try:
    parts = shlex.split(raw)
except ValueError:
    parts = raw.split()
try:
    push_idx = parts.index('push')
except ValueError:
    print(''); sys.exit(0)
rest = [p for p in parts[push_idx+1:] if not p.startswith('-')]
target = ''
if len(rest) >= 2:
    refspec = rest[1]
    target = refspec.split(':')[-1] if ':' in refspec else refspec
elif len(rest) == 1 and ':' in rest[0]:
    target = rest[0].split(':')[-1]
if target in ('HEAD', ''):
    target = ''
print(target)
" 2>/dev/null)

  if [ -z "$TARGET_REF" ]; then
    TARGET_REF=$(cd "$PROJECT_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null)
  fi
  TARGET_REF="${TARGET_REF#refs/heads/}"
  # Strip force-push `+` prefix (e.g. `git push origin +main`) — otherwise an
  # agent bypasses gate (f) by prepending `+` to the refspec.
  TARGET_REF="${TARGET_REF#+}"

  for protected in $PROTECTED_BRANCHES; do
    if [ "$TARGET_REF" = "$protected" ]; then
      echo "BLOCKED: Direct push to protected branch '$TARGET_REF' is forbidden."
      echo ""
      echo "Protected branches (from project-config.git.protectedBranches[]):"
      echo "  $PROTECTED_BRANCHES"
      echo ""
      echo "All changes to protected branches must land via a Pull Request:"
      echo "  1. Push to a feature branch: git push origin feat/<slug>"
      echo "  2. Open a PR via /ship-pr (build + lint + test + schema + PR creation)"
      echo "  3. Bot review + CI complete, then merge via the PR"
      echo ""
      echo "Server-side complement: configure GitHub branch protection on '$TARGET_REF'"
      echo "to enforce this at the platform level (prevents bypass via direct git push)."
      exit 2
    fi
  done
fi

# (c) SHA-scoped pre-push gate: if command contains 'git push', check marker + SHA
if echo "$ACTUAL_CMD" | grep -q "git push"; then
  BRANCH=$(cd "$PROJECT_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  SAFE_BRANCH=$(echo "$BRANCH" | tr '/' '-')
  MARKER="/tmp/.claude-prepush-${SAFE_BRANCH}"

  if [ ! -f "$MARKER" ]; then
    echo "BLOCKED: Pre-push gate failed — no validation marker found."
    echo "You must run /ship-pr (which runs build + lint + test + schema check) before pushing."
    echo ""
    echo "Alternatively, run: pnpm build && pnpm lint && pnpm test"
    echo "Then create the marker: echo \$(git rev-parse HEAD) > $MARKER"
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
      echo "Or run /ship-pr to handle this automatically."
      exit 2
    fi
  fi

  echo "Pre-push gate: PASSED (marker valid for branch: $BRANCH, SHA: ${HEAD_SHA:0:7})"
fi

exit 0
