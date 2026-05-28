#!/bin/bash
# .claude/hooks/refinement-gate.sh
#
# Hook: PreToolUse on mcp__plugin_dev-tasks_dev-tasks__claimTask.
#
# Refuses the claim with exit 2 if:
#   (a) Task lives on the Bugs Queue board (5091706353) — must run convertBugToTask first.
#   (b) Task is missing type / priority / epicId / description (<200 chars) / acceptanceCriteria.
#   (c) Subtasks list is empty OR any subtask lacks type / description / estimatedHours>0.
#   (d) Significant code drift since last refinement (Monday updatedAt < N commits ago on
#       this project's defaultBase). Soft warning only — call /plan-task to reconcile.
#
# Per .claude/rules/autonomous-loop.md hook conventions:
#   - exit 2 + message on STDERR to block.
#   - Block messages start with "BLOCKED:".
#   - Never echo $MONDAY_API_KEY / $MONDAY_API_TOKEN.
#   - Read tool args from stdin (Claude Code hook convention).
#
# Escape hatch: pass --accept-drift in claimTask's planId field, e.g.
# planId="2026-05-24_my-plan --accept-drift" disables gate (d) for legitimately
# stale-but-still-correct refinements. Gates (a)-(c) have NO escape hatch — they
# protect against fundamental refinement failures.

# Redirect stdout to stderr so block messages reach Claude Code per hook spec.
exec >&2

# Opt-in gate: silent no-op unless the consumer enabled this hook in their
# .claude/project-config.json hooks.enabled[] array.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "refinement-gate" || exit 0

# Read tool input from stdin (consumed once).
INPUT=$(cat)

# Extract taskId from tool_input JSON.
TASK_ID=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('tool_input', {}).get('itemId', ''))
except Exception:
    print('')
" 2>/dev/null)

if [ -z "$TASK_ID" ] || ! [[ "$TASK_ID" =~ ^[0-9]+$ ]]; then
  # No taskId in args — pass through. The MCP itself will reject.
  exit 0
fi

# Extract planId optionally for the --accept-drift escape hatch.
PLAN_ID=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('tool_input', {}).get('planId', '') or '')
except Exception:
    print('')
" 2>/dev/null)

ACCEPT_DRIFT=0
if [[ "$PLAN_ID" == *"--accept-drift"* ]]; then
  ACCEPT_DRIFT=1
fi

# Resolve project root via existing helper (worktree-aware).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

# Read the cached board map. If absent, fall back to the canonical Bugs board id.
BUGS_BOARD_ID="5091706353"
CACHE_FILE="$PROJECT_ROOT/.claude/cache/monday-board-map.json"
if [ -f "$CACHE_FILE" ]; then
  CACHED=$(jq -r '.boards.bugs // empty' "$CACHE_FILE" 2>/dev/null)
  if [ -n "$CACHED" ]; then
    BUGS_BOARD_ID="$CACHED"
  fi
fi

# Require a Monday API token to query. Without one, pass through (the MCP itself
# is the authoritative gate; this hook just surfaces failures earlier).
MONDAY_TOKEN="${MONDAY_API_KEY:-${MONDAY_API_TOKEN:-}}"
if [ -z "$MONDAY_TOKEN" ]; then
  exit 0
fi

# Query Monday for the task's board ID, type, priority, epic, description,
# acceptance criteria, and subtask metadata. Column IDs match the dev-tasks
# plugin schema documented in .claude/rules/autonomous-loop.md.
#
# We rely on basic GraphQL with column_values. Subtask data comes from
# subitems.column_values + subitems.name.
QUERY=$(cat <<EOF
{
  "query": "query{items(ids:[$TASK_ID]){id name board{id} column_values{id text value ... on BoardRelationValue{display_value linked_item_ids}} subitems{id name column_values{id text value}}}}"
}
EOF
)

RESPONSE=$(curl -sS --max-time 8 https://api.monday.com/v2 \
  -H "Authorization: $MONDAY_TOKEN" \
  -H "Content-Type: application/json" \
  --data "$QUERY" 2>/dev/null)

# If Monday is unreachable, pass through. The MCP is the authoritative gate.
if [ -z "$RESPONSE" ]; then
  exit 0
fi

# Parse the response. All gate logic lives in Python for safety (no eval/source
# on Monday-returned text).
RESULT=$(MONDAY_RESPONSE="$RESPONSE" BUGS_BOARD_ID="$BUGS_BOARD_ID" TASK_ID="$TASK_ID" ACCEPT_DRIFT="$ACCEPT_DRIFT" python3 <<'PY'
import json, os, sys

resp = json.loads(os.environ.get("MONDAY_RESPONSE", "{}") or "{}")
bugs_board_id = os.environ.get("BUGS_BOARD_ID", "5091706353")
task_id = os.environ.get("TASK_ID", "?")
accept_drift = os.environ.get("ACCEPT_DRIFT", "0") == "1"

items = (resp.get("data") or {}).get("items") or []
if not items:
    # Task not found — pass through, MCP is authoritative.
    print("PASS")
    sys.exit(0)

item = items[0]
board_id = str((item.get("board") or {}).get("id") or "")
col_vals = item.get("column_values") or []
subitems = item.get("subitems") or []


def col_text(col_id: str) -> str:
    for cv in col_vals:
        if cv.get("id") == col_id:
            return (cv.get("text") or "").strip()
    return ""


def subitem_col_text(sub_cv, col_id: str) -> str:
    for cv in sub_cv:
        if cv.get("id") == col_id:
            return (cv.get("text") or "").strip()
    return ""


# (a) Bugs board guard.
if board_id == bugs_board_id:
    print("BLOCK_BUG")
    sys.exit(0)

# (b) Refinement metadata. Column IDs match the current TASK_COLUMNS in
# plugin/src/constants.ts; legacy IDs are kept as fallbacks for older boards
# that pre-date the v0.x column renames.
#   Type:        task_type            (legacy: color_mksbm5er, status_1__1)
#   Priority:    task_priority        (legacy: priority)
#   Description: long_text_mm0mcp77   (legacy: long_text, long_text__1, long_text_mkqnezpz)
#   AC:          long_text_mm0pqaxy   (legacy: long_text_mkqnf3aw, long_text_mkqnf2tk)
#   Epic:        task_epic            (legacy: any board_relation_* column)
TYPE = col_text("task_type") or col_text("color_mksbm5er") or col_text("status_1__1")
PRIORITY = col_text("task_priority") or col_text("priority")
DESCRIPTION = col_text("long_text_mm0mcp77") or col_text("long_text") or col_text("long_text__1") or col_text("long_text_mkqnezpz")
AC = col_text("long_text_mm0pqaxy") or col_text("long_text_mkqnf3aw") or col_text("long_text_mkqnf2tk")

# Description doc column (doc_mm3sg1kr): when a Monday doc is attached, the
# `value` JSON contains a non-empty `files` array. Reading the doc content
# would cost 2 extra API calls per hook invocation — skip the length check
# in that case and treat "doc attached" as evidence of refinement. The MCP
# server-side validator (validateReadyToStart) applies the same rule.
DESCRIPTION_DOC_ATTACHED = False
for cv in col_vals:
    if cv.get("id") != "doc_mm3sg1kr":
        continue
    value_str = (cv.get("value") or "").strip()
    if not value_str:
        break
    try:
        vdata = json.loads(value_str)
        files = vdata.get("files") or []
        if isinstance(files, list) and len(files) > 0:
            DESCRIPTION_DOC_ATTACHED = True
    except (json.JSONDecodeError, AttributeError, TypeError):
        pass
    break

# Epic detection: match `task_epic` explicitly OR any `board_relation_*` column.
# board_relation columns return empty `text` via the basic GraphQL query, so we
# also check the BoardRelationValue typed fragment fields (display_value,
# linked_item_ids) added to the query above.
EPIC_LINKED = False
for cv in col_vals:
    cid = cv.get("id") or ""
    if cid != "task_epic" and not cid.startswith("board_relation"):
        continue
    if (cv.get("text") or "").strip():
        EPIC_LINKED = True
        break
    if (cv.get("display_value") or "").strip():
        EPIC_LINKED = True
        break
    linked = cv.get("linked_item_ids") or []
    if isinstance(linked, list) and linked:
        EPIC_LINKED = True
        break


missing = []
if not TYPE:
    missing.append("type")
if not PRIORITY:
    missing.append("priority")
if not EPIC_LINKED:
    missing.append("epicId")
# Description: accept either >=200 chars on the legacy long_text column OR a
# doc attached on the new descriptionDoc column (content quality enforced
# server-side by the MCP createTask/updateTask gates).
if not DESCRIPTION_DOC_ATTACHED and len(DESCRIPTION) < 200:
    missing.append(f"description (got {len(DESCRIPTION)} chars, need 200+ or a description doc attached)")
if not AC:
    missing.append("acceptanceCriteria")

if missing:
    print("BLOCK_REFINEMENT")
    print(",".join(missing))
    sys.exit(0)

# (c) Subtask refinement metadata. Each subtask must have type + description + estimatedHours > 0.
# Column IDs:
#   Subtask type:     "color_mksb..." (status-like color column on subitems board)
#   Subtask hours:    "numeric_*" (estimated hours numeric column)
#   Subtask desc:     "long_text" on subitems
sub_problems = []
if not subitems:
    print("BLOCK_NO_SUBTASKS")
    sys.exit(0)

for s in subitems:
    sname = s.get("name") or "(unnamed)"
    scv = s.get("column_values") or []
    stype = ""
    sdesc = ""
    shours_raw = ""
    for cv in scv:
        cid = cv.get("id") or ""
        text = (cv.get("text") or "").strip()
        if cid.startswith("color_") and not stype:
            stype = text
        if cid.startswith("long_text") and not sdesc:
            sdesc = text
        if cid.startswith("numeric") or cid.startswith("numbers") or cid == "numbers_1__1":
            if not shours_raw:
                shours_raw = text

    miss = []
    if not stype:
        miss.append("type")
    if not sdesc:
        miss.append("description")
    try:
        hours_val = float(shours_raw) if shours_raw else 0.0
    except ValueError:
        hours_val = 0.0
    if hours_val <= 0:
        miss.append("estimatedHours")

    if miss:
        sub_problems.append(f"'{sname}': missing {', '.join(miss)}")

if sub_problems:
    print("BLOCK_SUBTASKS")
    # Limit to first 5 subtask problems for readability.
    for p in sub_problems[:5]:
        print(p)
    sys.exit(0)

# (d) Code drift — soft warning only when --accept-drift not passed AND there are
# many commits since refinement. We don't have the refinement timestamp here, so
# this gate is currently a no-op stub (it can be tightened in a follow-up by
# fetching the task's updated_at and comparing against `git log --since`).
# Per task description, drift is "verified by /plan-task" — that runs separately.

print("PASS")
PY
)

# Branch on the verdict.
case "$RESULT" in
  PASS)
    exit 0
    ;;
  BLOCK_BUG)
    echo "BLOCKED: Bug items cannot be claimed directly."
    echo ""
    echo "Task #$TASK_ID lives on the Bugs Queue board ($BUGS_BOARD_ID). Bugs must be"
    echo "promoted to a proper Task before claiming, so the refinement-quality gate"
    echo "(type, priority, epic, description, acceptance criteria, subtasks) applies."
    echo ""
    echo "Run convertBugToTask first, then claimTask on the resulting task ID."
    exit 2
    ;;
  BLOCK_REFINEMENT*)
    DETAIL=$(echo "$RESULT" | sed -n '2p')
    echo "BLOCKED: Task #$TASK_ID is not refined."
    echo ""
    echo "Missing required refinement fields: $DETAIL"
    echo ""
    echo "Run /refine-task $TASK_ID before /pickup-task. Every claimed task must have"
    echo "type + priority + epicId + description (>=200 chars) + acceptanceCriteria."
    exit 2
    ;;
  BLOCK_NO_SUBTASKS)
    echo "BLOCKED: Task #$TASK_ID has zero subtasks."
    echo ""
    echo "Every claimed task needs at least one subtask with type + description +"
    echo "estimatedHours so the Monday board is the audit trail."
    echo ""
    echo "Run /refine-task $TASK_ID to break the work down before /pickup-task."
    exit 2
    ;;
  BLOCK_SUBTASKS*)
    PROBLEMS=$(echo "$RESULT" | tail -n +2)
    PROBLEM_COUNT=$(echo "$PROBLEMS" | wc -l | tr -d ' ')
    echo "BLOCKED: $PROBLEM_COUNT subtask(s) on task #$TASK_ID lack refinement metadata."
    echo ""
    echo "Each subtask must have type + description + estimatedHours > 0."
    echo ""
    echo "Problems:"
    echo "$PROBLEMS" | sed 's/^/  /'
    echo ""
    echo "Run /refine-task $TASK_ID and ensure every subtask has type, description, and estimated hours."
    exit 2
    ;;
  *)
    # Unknown verdict — pass through, MCP is authoritative.
    exit 0
    ;;
esac
