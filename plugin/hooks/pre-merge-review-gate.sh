#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "pre-merge-review-gate" in hooks.enabled[].
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-agent-cwd.sh"
hook_enabled "pre-merge-review-gate" || exit 0

exec >&2

# Hook: PreToolUse (Bash) — gates `gh pr merge` on reviewAddressed state.
#
# Prevents auto-merge when review triage hasn't completed. Enforces:
#   1. reviewAddressed.status must be "fixed" or "accepted"
#   2. reviewAddressed.triagedAt must be newer than latest review comment createdAt
#   3. Every configured source with polish > 0 must have non-empty replies array
#
# Evidence: PR #330 in v0-politiske-annoncer merged 4 minutes after Claude bot
# posted a structured review with a near-blocker — zero triage, zero PR replies.
# This hook prevents that class of quality-gate skip.

INPUT=$(cat)

ACTUAL_CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)
if [ -z "$ACTUAL_CMD" ]; then
  exit 0
fi

# Only gate gh pr merge commands
case "$ACTUAL_CMD" in
  *"gh pr merge"*) ;;
  *) exit 0 ;;
esac

AGENT_CWD=$(resolve_agent_cwd "$INPUT")
PROJECT_ROOT="${AGENT_CWD:-${CLAUDE_PROJECT_DIR:-$PWD}}"
STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"

# No state file → no enforcement (non-task-driven merges are allowed)
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

# Extract PR number from the command
PR_NUMBER=$(echo "$ACTUAL_CMD" | sed -nE 's/.*gh pr merge[^0-9]*([0-9]+).*/\1/p' | head -1)
if [ -z "$PR_NUMBER" ]; then
  PR_NUMBER=""
fi

# Read configured review sources (default: claudeBot, corridor, selfReview)
CONFIGURED_SOURCES=$(read_project_config '.review.sources | join(",")')
if [ -z "$CONFIGURED_SOURCES" ]; then
  CONFIGURED_SOURCES="claudeBot,corridor,selfReview"
fi

# Delegate to Python for all JSON parsing and validation logic
exec python3 "$(dirname "${BASH_SOURCE[0]}")/pre-merge-review-gate.py" \
  "$STATE_FILE" \
  "$PROJECT_ROOT" \
  "$PR_NUMBER" \
  "$CONFIGURED_SOURCES"
