#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "subtask-reminder" in hooks.enabled[]. Keeps the plugin's hooks dormant in
# projects that don't follow this workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-agent-cwd.sh"
hook_enabled "subtask-reminder" || exit 0
# Hook: PreToolUse (Edit|Write)
# NON-BLOCKING reminder to track subtask progress.
# Replaces the unreliable AI prompt hook that caused false Edit blocks.
# Always exits 0 — never blocks edits.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

# Skip infrastructure files — no subtask tracking needed
INPUT=$(cat)

# Update PROJECT_ROOT with the agent's actual cwd from the hook payload
# (prefer it over CLAUDE_PROJECT_DIR which is pinned to the main checkout).
AGENT_CWD=$(resolve_agent_cwd "$INPUT")
[ -n "$AGENT_CWD" ] && PROJECT_ROOT="$AGENT_CWD"
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)

case "$FILE_PATH" in
  */.claude/*|*/memory/*|*/CLAUDE.md|*/.gitignore)
    exit 0
    ;;
esac

STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"
[ ! -f "$STATE_FILE" ] && exit 0

# Deterministic check: warn if subtasks exist but none are in_progress
STATE_FILE_PATH="$STATE_FILE" python3 -c "
import json, os, sys

try:
    with open(os.environ['STATE_FILE_PATH']) as f:
        state = json.load(f)
except Exception:
    sys.exit(0)

subtasks = state.get('subtasks', [])
if not subtasks:
    sys.exit(0)

in_progress = [s for s in subtasks if s.get('status') == 'in_progress']
pending = [s for s in subtasks if s.get('status') == 'pending']

if not in_progress and pending:
    print('Subtask reminder: No subtask is In Progress but {} are pending.'.format(len(pending)))
    print('Consider running /log-progress SUBTASK_COMPLETED to start the next subtask.')
" 2>/dev/null

exit 0
