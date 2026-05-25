#!/bin/bash
# .claude/hooks/stop-waiting-for-uat-stage.sh
#
# Hook: Stop (chains AFTER the plugin's stop-task-check + stop-ci-green-check).
#
# Stage 6 of the post-implementation pipeline. After the plugin's existing 5
# stages pass (selfReviewPassed, PR exists, preview URL set, CI green, review
# addressed), this hook ALSO refuses Stop when:
#
#   The active task HAS subtasks AND ALL subtasks are marked Done AND the
#   parent task's local-state status is not "Waiting for UAT" or a later
#   downstream state (Pending Deploy to Prod / Done).
#
# Rationale: UAT 2026-05-22 retro showed 4 of 5 agents stopped at PR-open
# without ever flipping the parent to Waiting for UAT. The plugin's existing
# stop-task-check has a Stage 5 ("review addressed") but no stage for the
# parent-status transition. This closes that gap.
#
# Escape hatch: handoff-to-orchestrator. If active-task.json has
# reviewAddressed=handoff-to-orchestrator, the orchestrator does the parent
# flip after merge — skip this stage. Matches the existing escape hatch in
# stop-task-logic.py Stage 4.
#
# Pass-through cases:
#   - No active-task.json (no active task)
#   - Task has zero subtasks (legitimate flat task)
#   - Subtasks aren't all Done yet (downstream stages handle that)

# Redirect stdout to stderr.
exec >&2

# Opt-in gate: silent no-op unless the consumer enabled this hook in their
# .claude/project-config.json hooks.enabled[] array.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "stop-waiting-for-uat-stage" || exit 0

PROJECT_ROOT=""
# Resolve project root from CWD via git plumbing. Stop hooks don't receive a
# file_path payload; CWD typically reflects the active worktree.
if git_top=$(git rev-parse --show-toplevel 2>/dev/null); then
  PROJECT_ROOT="$git_top"
else
  PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
fi

STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"

# No active task → pass-through.
[ ! -f "$STATE_FILE" ] && exit 0

# Validate JSON parses before doing anything.
if ! STATE_FILE_PATH="$STATE_FILE" python3 -c "import json, os; json.load(open(os.environ['STATE_FILE_PATH']))" 2>/dev/null; then
  exit 0
fi

VERDICT=$(STATE_FILE_PATH="$STATE_FILE" python3 <<'PY' 2>/dev/null
import json, os, sys

with open(os.environ['STATE_FILE_PATH']) as f:
    state = json.load(f)

# Escape hatch: handoff-to-orchestrator means the orchestrator owns the
# parent-status flip. Matches stop-task-logic.py Stage 4 semantics.
if state.get('reviewAddressed') == 'handoff-to-orchestrator':
    print("PASS")
    sys.exit(0)

subtasks = state.get('subtasks') or []
if not subtasks:
    # Flat task — no subtasks to gate on. Pass-through.
    print("PASS")
    sys.exit(0)

# Are all subtasks Done?
non_done = [
    s for s in subtasks
    if (s.get('status') or '').lower() != 'done'
]
if non_done:
    # Subtasks aren't all done yet — earlier pipeline stages handle the gap.
    print("PASS")
    sys.exit(0)

# All subtasks Done. Check local-state mirror of parent status.
parent_status = (state.get('parentStatus') or '').strip().lower()

# Acceptable downstream states: Waiting for UAT, Pending Deploy to Prod, Done.
acceptable = {
    'waiting for uat',
    'pending deploy to prod',
    'done',
}

if parent_status in acceptable:
    print("PASS")
    sys.exit(0)

# Empty parentStatus is the most common failure mode under this retro —
# agents never set it because they never flip the task. Print BLOCK either
# way.
print(f"BLOCK:{state.get('taskId','?')}:{state.get('taskName','?')}:{parent_status or '(unset)'}")
PY
)

case "$VERDICT" in
  PASS)
    exit 0
    ;;
  BLOCK:*)
    # Strip the leading BLOCK: then split on : with python (task name may have colons)
    DETAIL="${VERDICT#BLOCK:}"
    TASK_ID=$(echo "$DETAIL" | python3 -c "import sys; print(sys.stdin.read().split(':',2)[0])" 2>/dev/null)
    TASK_NAME=$(echo "$DETAIL" | python3 -c "import sys; parts=sys.stdin.read().split(':',2); print(parts[1] if len(parts)>1 else '?')" 2>/dev/null)
    CURRENT_STATUS=$(echo "$DETAIL" | python3 -c "import sys; parts=sys.stdin.read().split(':',2); print(parts[2] if len(parts)>2 else '?')" 2>/dev/null)

    echo "BLOCKED: parent task not at Waiting for UAT — task '#$TASK_ID $TASK_NAME' (local status: $CURRENT_STATUS)."
    echo ""
    echo "All subtasks are Done, but the parent task has not transitioned to Waiting"
    echo "for UAT. Under the UAT 2026-05-22 retro, this transition is mandatory:"
    echo ""
    echo "  1. manageSubtasks(parentItemId=$TASK_ID, ...) Done with actualHours (verify in Monday)."
    echo "  2. createTaskUatDoc(itemId=$TASK_ID, ...) with the UAT walk-through."
    echo "  3. updateTask(itemId=$TASK_ID, status='Waiting for UAT', demoUrl=<preview URL>)."
    echo "  4. Update local-state parentStatus mirror in .claude/active-task.json"
    echo "     (the orchestrator-handoff escape hatch is 'reviewAddressed': 'handoff-to-orchestrator')."
    echo ""
    echo "Reference: .claude/rules/agent-coordination.md Orchestrator post-merge checklist."
    exit 2
    ;;
  *)
    # Unknown verdict — fail open.
    exit 0
    ;;
esac
