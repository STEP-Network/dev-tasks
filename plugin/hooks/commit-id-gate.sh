#!/bin/bash

# Hook: PreToolUse (Bash) — commit-id-gate
#
# Enforces that every `git commit` references a Monday Tasks-board item id in
# the form #123456789. Progress is tracked in git history (the plugin no longer
# posts narrative Monday Updates), so the commit↔task link is the audit trail —
# it must always be present.
#
# Two-layer enforcement:
#   1. FORMAT (always, offline-safe): the commit command must contain a token
#      matching #[0-9]{7,}. The 7-digit floor avoids mistaking GitHub PR/issue
#      refs (#60, #123) for Monday ids (which are 8–10 digits). No #id → block.
#   2. BOARD (best-effort, API-backed): when MONDAY_API_KEY + curl + jq are
#      available, resolve the id via the Monday API and confirm it lives on the
#      Tasks board (default 5091706356; override via project-config
#      monday.tasksBoardId). Wrong board / not found → block. API unreachable or
#      creds absent → WARN + allow (format was already validated; we never brick
#      an offline commit on a network hiccup).
#
# Opt-in: dormant unless project-config.json hooks.enabled[] lists
# "commit-id-gate". PreToolUse-only — catches commits the agent runs through
# Claude Code. Commits typed directly in a terminal are out of scope this round
# (no commit-msg git hook installed).
#
# Input: JSON on stdin with tool_input.command.

source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-agent-cwd.sh"
hook_enabled "commit-id-gate" || exit 0

# Block messages (exit 2) must reach Claude Code on stderr.
exec >&2

INPUT=$(cat)

ACTUAL_CMD=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)
[ -z "$ACTUAL_CMD" ] && exit 0  # Can't parse input — don't block.

# Only act on `git commit`. Substring match mirrors bash-guard gate (b).
case "$ACTUAL_CMD" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

# Skip amend/no-edit and reword-less amends — they reuse the existing message,
# which already passed this gate when first written.
case "$ACTUAL_CMD" in
  *"--no-edit"*) exit 0 ;;
esac

# Resolve project root (worktree-aware) for project-config lookups.
AGENT_CWD=$(resolve_agent_cwd "$INPUT")
PROJECT_ROOT="${AGENT_CWD:-${CLAUDE_PROJECT_DIR:-$PWD}}"

# ---- Layer 1: format (always) -------------------------------------------------
# Extract every #<7+ digits> token from the command string. The commit message
# travels inside the command (whether via -m "..." or a heredoc), so scanning
# the whole command is sufficient and avoids fragile arg parsing.
IDS=$(printf '%s' "$ACTUAL_CMD" | grep -oE '#[0-9]{7,}' | tr -d '#' | sort -u)

if [ -z "$IDS" ]; then
  echo "BLOCKED: commit message must reference a Monday Tasks-board id like #123456789."
  echo ""
  echo "Every commit needs a task link (progress is tracked in git, not Monday Updates)."
  echo "  • Feature/fix work → the task you're on (see .claude/active-task.json taskId)."
  echo "  • Infra/docs work  → the catch-all maintenance task for this product."
  echo ""
  echo "Add a line to the commit message, e.g.:  Monday: #123456789"
  echo "(PR/issue refs like #60 don't count — Monday ids are 8–10 digits.)"
  exit 2
fi

# ---- Layer 2: board membership (best-effort) ----------------------------------
# Need MONDAY_API_KEY + curl + jq to validate. Absent any of them → format-only
# pass with a soft warning (don't brick offline commits).
if [ -z "$MONDAY_API_KEY" ]; then
  echo "commit-id-gate: MONDAY_API_KEY unset — accepted on format only (board membership unverified)."
  exit 0
fi
if ! command -v curl >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  echo "commit-id-gate: curl/jq unavailable — accepted on format only (board membership unverified)."
  exit 0
fi

# Tasks board id: project-config override, else the STEP-internal default.
TASKS_BOARD_ID=$(read_project_config '.monday.tasksBoardId')
[ -z "$TASKS_BOARD_ID" ] && TASKS_BOARD_ID="5091706356"

CACHE_TTL=600  # seconds — skip re-validating an id seen recently.

# Validate at least ONE referenced id resolves to a Tasks-board item.
MATCHED_TASK=""
WRONG_BOARD_INFO=""
API_ERRORED=false

for ID in $IDS; do
  CACHE_FILE="/tmp/.claude-commit-id-ok-${ID}"
  if [ -f "$CACHE_FILE" ]; then
    # Fresh cache hit → treat as validated Tasks-board id.
    NOW=$(date +%s 2>/dev/null || echo 0)
    MTIME=$(stat -f %m "$CACHE_FILE" 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0)
    if [ "$NOW" -ne 0 ] && [ "$MTIME" -ne 0 ] && [ $((NOW - MTIME)) -lt "$CACHE_TTL" ]; then
      MATCHED_TASK="$ID"
      break
    fi
  fi

  QUERY="{\"query\":\"query { items(ids: [${ID}]) { id board { id } } }\"}"
  RESP=$(curl -s -m 10 -w '\n%{http_code}' -X POST https://api.monday.com/v2 \
    -H "Authorization: ${MONDAY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$QUERY" 2>/dev/null)
  HTTP_CODE=$(printf '%s' "$RESP" | tail -n1)
  BODY=$(printf '%s' "$RESP" | sed '$d')

  if [ "$HTTP_CODE" != "200" ] || [ -z "$BODY" ]; then
    API_ERRORED=true
    continue
  fi

  BOARD_ID=$(printf '%s' "$BODY" | jq -r '.data.items[0].board.id // empty' 2>/dev/null)
  if [ -z "$BOARD_ID" ]; then
    # Item id not found on any board the token can see.
    WRONG_BOARD_INFO="${WRONG_BOARD_INFO}  #${ID}: not found\n"
    continue
  fi

  if [ "$BOARD_ID" = "$TASKS_BOARD_ID" ]; then
    MATCHED_TASK="$ID"
    touch "$CACHE_FILE" 2>/dev/null || true
    break
  else
    WRONG_BOARD_INFO="${WRONG_BOARD_INFO}  #${ID}: on board ${BOARD_ID}, not Tasks (${TASKS_BOARD_ID})\n"
  fi
done

if [ -n "$MATCHED_TASK" ]; then
  exit 0
fi

# No id matched the Tasks board. If the API errored on every attempt, degrade to
# format-only pass (we couldn't verify — don't block on network). Otherwise the
# ids resolved but none were Tasks-board items → hard block.
if [ "$API_ERRORED" = true ] && [ -z "$WRONG_BOARD_INFO" ]; then
  echo "commit-id-gate: Monday API unreachable — accepted on format only (board membership unverified)."
  exit 0
fi

echo "BLOCKED: commit references a Monday id, but none of them are on the Tasks board (${TASKS_BOARD_ID})."
echo ""
printf '%b' "$WRONG_BOARD_INFO"
echo ""
echo "Dev work is tracked on the Tasks board. Bugs/Feedback are intake-only —"
echo "convert them to a Task first (convertBugToTask / convertFeedbackToTask),"
echo "then reference the resulting task id. Infra/docs → the maintenance task."
exit 2
