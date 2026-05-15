#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "bash-guard" in hooks.enabled[]. Keeps the plugin's blocking hooks dormant
# in projects that don't follow the Monday task-first workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "bash-guard" || exit 0

# Redirect stdout to stderr so block messages (exit 2) reach Claude Code
# correctly. Per Claude Code hooks spec, block reasons must be on stderr.
exec >&2

# Hook: PreToolUse (Bash)
# Five gates:
#   (a) Block destructive commands
#   (b) Block git commit without self-review (Fix 1)
#   (c) SHA-scoped pre-push gate (Fix 5)
#   (d) i18n locale parity — block commit if staged messages/*.json files have mismatched keys
#   (e) i18n completeness — block commit if only a subset of 24 locale files are modified
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

# (d) i18n locale parity: if committing and messages/en.json is staged with NEW keys,
#     verify those keys exist in ALL other locale files (working tree).
#     Only checks newly added keys — pre-existing gaps don't block.
if echo "$ACTUAL_CMD" | grep -q "git commit"; then
  EN_STAGED=$(cd "$PROJECT_ROOT" && git diff --cached --name-only -- 'messages/en.json' 2>/dev/null)
  if [ -n "$EN_STAGED" ]; then
    I18N_RESULT=$(cd "$PROJECT_ROOT" && python3 -c "
import json, glob, os, sys, subprocess, re

messages_dir = 'messages'
en_path = os.path.join(messages_dir, 'en.json')
if not os.path.exists(en_path):
    sys.exit(0)

# Get the staged diff for en.json — extract added lines with key patterns
diff = subprocess.run(
    ['git', 'diff', '--cached', '-U0', '--', en_path],
    capture_output=True, text=True
).stdout

# Find keys on added lines (lines starting with +, excluding +++ header)
# Match JSON keys like: \"keyName\": ...
added_keys = set()
for line in diff.split('\n'):
    if line.startswith('+') and not line.startswith('+++'):
        # Extract the key name from lines like:  +        \"deletionBlocked\": \"...\"
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
    if locale == 'en':
        continue
    with open(lf) as f:
        content = f.read()
    locale_missing = []
    for key in sorted(added_keys):
        # Simple check: does the key string appear in the file?
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
      echo "BLOCKED: i18n locale parity check failed."
      echo ""
      echo "New keys added to messages/en.json are missing from other locale files:"
      echo "$I18N_RESULT" | tail -n +2
      echo ""
      echo "Every new i18n key MUST be added to ALL 24 locale files in messages/."
      echo "Verify with: grep -r '\"keyName\"' messages/ | wc -l (must equal 24)"
      exit 2
    fi
  fi
fi

# (e) i18n completeness: if committing locale files, verify that ALL 24 locale
#     files have been modified on this branch (staged + already committed).
#     Uses branch diff against main to avoid false positives from multi-commit workflows.
if echo "$ACTUAL_CMD" | grep -q "git commit"; then
  I18N_STAGED=$(cd "$PROJECT_ROOT" && git diff --cached --name-only -- 'messages/*.json' 2>/dev/null)
  if [ -n "$I18N_STAGED" ]; then
    I18N_COMPLETENESS=$(cd "$PROJECT_ROOT" && python3 -c "
import subprocess, os, sys

all_locales = sorted([
    'bg','cs','da','de','el','en','es','et','fi','fr','ga','hr',
    'hu','it','lt','lv','mt','nl','pl','pt','ro','sk','sl','sv'
])

# Check ALL locale files modified on this branch (committed + staged + unstaged)
# Branch diff: committed changes since divergence from main
branch_diff = subprocess.run(
    ['git', 'diff', '--name-only', 'main...HEAD', '--', 'messages/'],
    capture_output=True, text=True
).stdout.strip().split('\n')

# Staged changes (about to be committed)
staged = subprocess.run(
    ['git', 'diff', '--cached', '--name-only', '--', 'messages/'],
    capture_output=True, text=True
).stdout.strip().split('\n')

# Combine: branch diff + staged
all_modified = set()
for f in branch_diff + staged:
    f = f.strip()
    if f and f.startswith('messages/') and f.endswith('.json'):
        locale = os.path.basename(f).replace('.json', '')
        if locale in all_locales:
            all_modified.add(locale)

# If 0 or all 24, no problem
if len(all_modified) == 0 or len(all_modified) >= 24:
    print('OK')
    sys.exit(0)

missing = sorted(set(all_locales) - all_modified)
print('INCOMPLETE')
print(f'Branch has {len(all_modified)}/24 locale files modified (committed + staged)')
print(f'Modified: {', '.join(sorted(all_modified))}')
print(f'Missing ({len(missing)}): {', '.join(missing)}')
" 2>/dev/null)

    if echo "$I18N_COMPLETENESS" | grep -q "INCOMPLETE"; then
      echo "BLOCKED: i18n completeness check failed."
      echo ""
      echo "$I18N_COMPLETENESS" | tail -n +2
      echo ""
      echo "When modifying i18n keys, ALL 24 locale files must be updated."
      echo "Update the missing locale files, then stage them with: git add messages/"
      exit 2
    fi
  fi
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
