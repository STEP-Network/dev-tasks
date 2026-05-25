#!/bin/bash
# .claude/hooks/subtask-progress-gate.sh
#
# Hook: PreToolUse on Bash with `git push *` matcher.
# Refuses push (exit 2) when active task has subtasks AND none are marked Done
# with actualHours > 0.
#
# Rationale: under the UAT 2026-05-22 retro, 4 of 5 agents pushed PRs without
# ever marking subtasks Done — Monday board lost the per-step audit trail.
# This is the mechanical correction: the push refuses until at least one
# subtask shows completion, forcing /log-progress flow.
#
# Pass-through cases (NOT a block):
#   - No active-task.json — task-state-guard already blocks edits in this case.
#   - Active task has zero subtasks — legitimate flat task (small fix, hotfix).
#   - Push command is for an unrelated branch (no detectable subtask context).
#
# Escape hatch: set "allowPushWithoutSubtaskProgress": true in active-task.json
# for sessions that legitimately need to push without per-subtask progress (e.g.
# infrastructure-only commit that pre-dates per-step refinement). Document why
# in the task body when used.

# Redirect stdout to stderr so block messages reach Claude Code.
exec >&2

# Opt-in gate: silent no-op unless the consumer enabled this hook in their
# .claude/project-config.json hooks.enabled[] array.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "subtask-progress-gate" || exit 0

# Read tool input from stdin.
INPUT=$(cat)

# Extract command.
ACTUAL_CMD=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('tool_input', {}).get('command', ''))
except Exception:
    print('')
" 2>/dev/null)

# Only fire on `git push` commands. The matcher should already narrow this,
# but defensive check in case the matcher fires more broadly.
case "$ACTUAL_CMD" in
  *"git push"*) ;;
  *) exit 0 ;;
esac

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"

# No active-task.json — task-state-guard owns the block. Pass-through.
[ ! -f "$STATE_FILE" ] && exit 0

# Evaluate the state file with python (no eval/source on file contents).
VERDICT=$(STATE_FILE_PATH="$STATE_FILE" python3 <<'PY' 2>/dev/null
import json, os, sys

try:
    with open(os.environ['STATE_FILE_PATH']) as f:
        state = json.load(f)
except Exception:
    print("PASS")
    sys.exit(0)

if state.get('allowPushWithoutSubtaskProgress'):
    print("PASS_ESCAPE")
    sys.exit(0)

subtasks = state.get('subtasks') or []
if not subtasks:
    # Flat task (no subtasks) — legitimate small fix. Don't block.
    print("PASS")
    sys.exit(0)

done_with_hours = []
for s in subtasks:
    status = (s.get('status') or '').lower()
    actual = s.get('actualHours') or 0
    try:
        actual_f = float(actual)
    except (TypeError, ValueError):
        actual_f = 0.0
    if status == 'done' and actual_f > 0:
        done_with_hours.append(s.get('name') or '(unnamed)')

if done_with_hours:
    print("PASS")
    sys.exit(0)

# Block: subtasks exist, none done-with-hours.
total = len(subtasks)
print(f"BLOCK:{total}")
PY
)

case "$VERDICT" in
  PASS|PASS_ESCAPE)
    exit 0
    ;;
  BLOCK:*)
    TOTAL="${VERDICT#BLOCK:}"
    TASK_NAME=$(jq -r '.taskName // "(unnamed)"' "$STATE_FILE" 2>/dev/null)
    TASK_ID=$(jq -r '.taskId // "?"' "$STATE_FILE" 2>/dev/null)
    echo "BLOCKED: cannot push — task '#$TASK_ID $TASK_NAME' has $TOTAL subtask(s) but none are marked Done with actualHours > 0."
    echo ""
    echo "Per the UAT 2026-05-22 retro: every claimed task with subtasks must record"
    echo "per-step progress on Monday before code is pushed. The Monday board IS the"
    echo "audit trail; gaps in it are quality debt."
    echo ""
    echo "To unblock:"
    echo "  1. Mark each completed subtask via manageSubtasks(status='Done', actualHours=X)."
    echo "  2. Run /log-progress SUBTASK_COMPLETED so Monday gets the timing signal."
    echo "  3. Retry the push."
    echo ""
    echo "Legitimate flat-task case: if this task genuinely has no per-step work to log"
    echo "(rare — hotfixes only), set \"allowPushWithoutSubtaskProgress\": true in"
    echo ".claude/active-task.json and document why in the task body."
    exit 2
    ;;
  *)
    # Unknown verdict — fail open.
    exit 0
    ;;
esac
