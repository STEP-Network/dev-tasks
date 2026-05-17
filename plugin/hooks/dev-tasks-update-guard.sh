#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "dev-tasks-update-guard" in hooks.enabled[]. Keeps the plugin's hooks
# dormant in projects that don't follow the Monday task-first workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "dev-tasks-update-guard" || exit 0

# Hook: PreToolUse (mcp__plugin_dev-tasks_dev-tasks__updateTask)
# Defense-in-depth validation of task-status transitions BEFORE the MCP call.
# The dev-tasks MCP server is the AUTHORITATIVE gate — this hook surfaces the
# most common gate failures earlier and with clearer messages.
#
# Validations:
#   - status="Waiting for UAT" with any subtask still in_progress/pending → BLOCK
#   - status="Done" on a non-hotfix branch → BLOCK (release ceremony owns Done)
#   - status="Ready to Start" → pass through (MCP validates type/priority/epic/AC/subtask prereqs)
#   - other statuses or non-status updates → pass through
#
# Escape hatch: set `"allowDoneDirectly": true` in .claude/active-task.json to
# permit setting Done from a non-hotfix branch (document why in the task body).
#
# Exit 0 = allow tool call. Exit 2 = block with message shown to agent.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

INPUT=$(cat)

# Extract status + itemId from tool_input JSON
TARGET_STATUS=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('status') or '')" 2>/dev/null)
TARGET_ITEM_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('itemId') or '')" 2>/dev/null)

# If no status is being set, this is a metadata-only update — pass through.
if [ -z "$TARGET_STATUS" ]; then
  exit 0
fi

STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"
# Without a state file we have no subtask context to validate against — the MCP
# gate is the safety net.
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

STATE=$(STATE_FILE_PATH="$STATE_FILE" TARGET_ITEM_ID="$TARGET_ITEM_ID" python3 <<'PY' 2>/dev/null
import json, os, sys

try:
    with open(os.environ['STATE_FILE_PATH']) as f:
        state = json.load(f)
except Exception:
    sys.exit(0)

state_task_id = str(state.get('taskId', '')).strip()
target_id = str(os.environ.get('TARGET_ITEM_ID', '')).strip()

# If the updateTask call targets a different task than the active one, we have no
# subtask state to validate against — pass through silently. Most often this means
# the agent is updating a parent / sibling / unrelated task.
if target_id and state_task_id and target_id != state_task_id:
    print('DIFFERENT_TASK')
    sys.exit(0)

branch = state.get('branch', '') or ''
allow_done_directly = bool(state.get('allowDoneDirectly', False))
subtasks = state.get('subtasks', []) or []
unfinished = [s for s in subtasks if s.get('status') in ('in_progress', 'pending')]

is_hotfix_branch = branch.startswith('hotfix/')

print('IS_HOTFIX:' + ('1' if is_hotfix_branch else '0'))
print('ALLOW_DONE:' + ('1' if allow_done_directly else '0'))
print('UNFINISHED_COUNT:' + str(len(unfinished)))
if unfinished:
    print('UNFINISHED_NAMES:' + ' | '.join(s.get('name', '(unnamed)') for s in unfinished[:5]))
PY
)

# Pass through if the call targets a different task than the active one.
if echo "$STATE" | grep -q "^DIFFERENT_TASK$"; then
  exit 0
fi

IS_HOTFIX=$(echo "$STATE" | sed -n 's/^IS_HOTFIX://p')
ALLOW_DONE=$(echo "$STATE" | sed -n 's/^ALLOW_DONE://p')
UNFINISHED_COUNT=$(echo "$STATE" | sed -n 's/^UNFINISHED_COUNT://p')
UNFINISHED_NAMES=$(echo "$STATE" | sed -n 's/^UNFINISHED_NAMES://p')

# Redirect stdout to stderr so block messages reach Claude Code correctly.
exec >&2

case "$TARGET_STATUS" in
  "Waiting for UAT")
    if [ -n "$UNFINISHED_COUNT" ] && [ "$UNFINISHED_COUNT" != "0" ]; then
      echo "BLOCKED: cannot transition to 'Waiting for UAT' — $UNFINISHED_COUNT subtask(s) not Done."
      echo ""
      echo "Unfinished subtasks (per .claude/active-task.json):"
      echo "  $UNFINISHED_NAMES"
      echo ""
      echo "Resolve via /log-progress SUBTASK_COMPLETED for each, then retry."
      echo "(The dev-tasks MCP server enforces the same gate; this hook surfaces it earlier.)"
      exit 2
    fi
    ;;
  "Done")
    if [ "$IS_HOTFIX" != "1" ] && [ "$ALLOW_DONE" != "1" ]; then
      echo "BLOCKED: setting status to 'Done' on a non-hotfix branch."
      echo ""
      echo "Under the default staging-as-base flow, 'Done' is set by:"
      echo "  - /release-version (after FF \$hotfixBase + prod migrate + tag → GitHub Action)"
      echo "  - /ship-pr Phase 10 (hotfix flow only — branch must start with 'hotfix/')"
      echo ""
      echo "If this IS a genuine hotfix and detection is wrong (e.g. branch is not"
      echo "named hotfix/*): set"
      echo '  "allowDoneDirectly": true'
      echo "in .claude/active-task.json and retry. Document why in the task body."
      exit 2
    fi
    ;;
esac

exit 0
