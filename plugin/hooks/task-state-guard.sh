#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "task-state-guard" in hooks.enabled[]. Keeps the plugin's blocking hooks dormant
# in projects that don't follow the Monday task-first workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "task-state-guard" || exit 0

# Redirect stdout to stderr so block messages (exit 2) reach Claude Code
# correctly. Per Claude Code hooks spec, block reasons must be on stderr.
exec >&2

# Hook: PreToolUse (Edit|Write)
# HARD BLOCK: No edits allowed without an active Monday.com task
# SIDE EFFECTS on source file edits (Fix 2 + Fix 3):
#   - Invalidate stale push marker (forces re-validation before push)
#   - Reset selfReviewPassed to false (forces re-review before commit)
# Exit 2 = block the tool call with message shown to agent

# Resolve project root from this script's location (hooks/ -> .claude/ -> project root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)

# Allow edits to Claude config files (hooks, settings, skills, rules, memory)
# These are infrastructure changes, not product code
# Note: bash case glob '*' matches '/' so these patterns work with absolute paths
case "$FILE_PATH" in
  */.claude/*|*/memory/*|*/CLAUDE.md|*/.gitignore)
    exit 0
    ;;
esac

STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"
if [ ! -f "$STATE_FILE" ]; then
  echo "BLOCKED: No active Monday.com task."
  echo ""
  echo "You MUST claim a task before editing ANY project file:"
  echo "  1. Run /pickup-task to claim a Monday.com task"
  echo "  2. This creates .claude/active-task.json"
  echo "  3. Then you can edit files"
  echo ""
  echo "NO EXCEPTIONS. Every code change must trace to a Monday.com task."
  exit 2
fi

# Validate the state file has required fields AND a claimToken from /pickup-task
# The claimToken is the Monday.com update ID returned by mcp__plugin_dev-tasks_dev-tasks__createUpdate
# when posting the TASK_CLAIMED event. This prevents agents from bypassing /pickup-task
# by writing active-task.json directly (the token requires an actual MCP call).
VALIDATION_RESULT=$(STATE_FILE_PATH="$STATE_FILE" python3 -c "
import json, os, sys
try:
    with open(os.environ['STATE_FILE_PATH']) as f:
        data = json.load(f)
    if 'taskId' not in data:
        print('BLOCK:missing taskId')
        sys.exit(0)
    if not data.get('claimToken'):
        print('BLOCK:missing claimToken')
        sys.exit(0)
    print('OK')
except Exception as e:
    print(f'BLOCK:invalid JSON: {e}')
" 2>/dev/null)

case "$VALIDATION_RESULT" in
  BLOCK:missing\ claimToken)
    echo "BLOCKED: active-task.json has no claimToken."
    echo ""
    echo "The claimToken is set by /pickup-task when it posts a TASK_CLAIMED event"
    echo "to Monday.com. Writing active-task.json manually does NOT satisfy this check."
    echo ""
    echo "Run /pickup-task to properly claim a Monday.com task."
    exit 2
    ;;
  BLOCK:*)
    echo "BLOCKED: active-task.json is invalid (${VALIDATION_RESULT#BLOCK:})"
    echo "Run /pickup-task to recreate it."
    exit 2
    ;;
esac

# --- Fix 2: Invalidate push marker when source files are edited ---
# This prevents pushing code that hasn't been re-validated after new edits.
BRANCH=$(cd "$PROJECT_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
SAFE_BRANCH=$(echo "$BRANCH" | tr '/' '-')
MARKER="/tmp/.claude-prepush-${SAFE_BRANCH}"

if [ -f "$MARKER" ]; then
  rm -f "$MARKER"
  echo "Push marker invalidated — source file edited. Re-validation required before push."
fi

# --- Fix 3: Reset selfReviewPassed when source files are edited ---
# This prevents committing with a stale self-review from a previous round of edits.
# NOTE TO AGENT: This modifies .claude/active-task.json silently. Always re-read
# the state file BEFORE editing it, especially after source file edits.
STATE_FILE_PATH="$STATE_FILE" python3 -c "
import json, os

state_file = os.environ['STATE_FILE_PATH']
try:
    with open(state_file) as f:
        state = json.load(f)

    if state.get('selfReviewPassed'):
        state['selfReviewPassed'] = False
        # Remove the timestamp too so it's clearly reset
        state.pop('selfReviewPassedAt', None)
        with open(state_file, 'w') as f:
            json.dump(state, f, indent=2)
            f.write('\n')
        print('Self-review invalidated — source file edited. Run /self-review after implementation.')
except Exception:
    pass  # Don't block edits if state file is corrupt
" 2>/dev/null

# --- Soft warning: epic assignment ---
STATE_FILE_PATH="$STATE_FILE" python3 -c "
import json, os
try:
    with open(os.environ['STATE_FILE_PATH']) as f:
        state = json.load(f)
    if not state.get('epicId'):
        print('WARNING: Active task has no epicId. All tasks should belong to an epic.')
        print('Use listEpics() to find the right epic and update the task.')
except Exception:
    pass
" 2>/dev/null

exit 0
