#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "post-push-track" in hooks.enabled[]. Keeps the plugin's hooks dormant in
# projects that don't follow this workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "post-push-track" || exit 0
# Hook: PostToolUse on Bash(git push *)
# Records that a push happened so the Stop hook can verify CI reached terminal
# green state before letting the session end. Complements stop-task-check,
# which only enforces CI-green when an active Monday task exists. This marker
# fires for ALL pushes — quickfixes, hotfixes, exploratory pushes — closing
# the gap where a push happens outside the /pickup-task workflow.
#
# Marker format (one JSON object, line-terminated):
#   {"sha":"<HEAD sha after push>","branch":"<branch>","ts":"<ISO 8601 UTC>"}
#
# Marker location: /tmp/.claude-pushed-{branch-with-slashes-as-dashes}
#
# The Stop hook (stop-ci-green-check) reads this marker and refuses session
# exit if CI on the PR is not green. The marker is cleared by the Stop hook
# once CI is verified green, so it doesn't nag on subsequent stops without a
# new push.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

INPUT=$(cat)

# Only mark on a real `git push` (the matcher `if:` already filters this, but
# defense in depth — a future settings.json edit could broaden the matcher).
ACTUAL_CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)
if ! echo "$ACTUAL_CMD" | grep -q "git push"; then
  exit 0
fi

# Detect successful push via stdout — `git push` reliably outputs `* branch -> origin/branch`
# on successful remote-branch updates.
#
# Two correctness traps the self-reviewer caught here:
#   1. Field name is `tool_response`, NOT `tool_result`. Verified against
#      build-failure-advisor.sh, parse-self-review-output.py, and the comment
#      in post-self-review.sh (header).
#   2. `grep -q -- "->"` (note the `--`) is required: BSD grep on macOS AND
#      GNU grep on Linux both treat `->` as a malformed flag and error with
#      exit 2 otherwise, silently skipping the rest of the hook. The same bug
#      was in post-push-review-check.sh and is fixed in this PR.
#
# Defensive: tool_response may be a dict (with .stdout) OR a plain string.
# Match the pattern from build-failure-advisor.sh.
STDOUT=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    r = d.get('tool_response', '')
    if isinstance(r, dict):
        print(r.get('stdout', '') or '')
    else:
        print(r or '')
except Exception:
    pass
" 2>/dev/null)
if ! echo "$STDOUT" | grep -q -- "->"; then
  exit 0
fi

BRANCH=$(cd "$PROJECT_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null)
SHA=$(cd "$PROJECT_ROOT" && git rev-parse HEAD 2>/dev/null)
if [ -z "$BRANCH" ] || [ -z "$SHA" ]; then
  exit 0
fi

# Use `__` (double underscore) instead of `-` to escape slashes in branch
# names. `tr '/' '-'` would collide deterministically: `feat/foo-bar` and
# `feat-foo/bar` both collapse to `feat-foo-bar`. Branch names never contain
# `__` in practice (git refname rules + project conventions), so this is
# collision-free.
SAFE_BRANCH=$(echo "$BRANCH" | sed 's|/|__|g')
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

printf '{"sha":"%s","branch":"%s","ts":"%s"}\n' "$SHA" "$BRANCH" "$TS" > "/tmp/.claude-pushed-${SAFE_BRANCH}"

# Clear any stale ack file from a previous push on this branch — a new push
# means new commits, which need fresh classification of any CI failures.
# Without this, a stale ack from PUSH-1 could silently bypass a real failure
# introduced by PUSH-2 (the genuine-flake-vs-real-bug confusion the gate
# is meant to prevent).
rm -f "/tmp/.claude-ci-ack-${SAFE_BRANCH}"

exit 0
