#!/usr/bin/env bash
# .claude/scripts/find-worktree-for-task.sh
#
# Given a Monday task ID, print the matching worktree path (and branch).
# Uses the convention documented in .claude/rules/worktree-discipline.md:
#
#   Monday Branch column (text_mm0pvs3n) → "feat/foo-bar"
#   Worktree path                        → ".claude/worktrees/feat-foo-bar"
#
# Usage:
#   bash .claude/scripts/find-worktree-for-task.sh <task-id>
#   bash .claude/scripts/find-worktree-for-task.sh 2913546224
#
# Exit codes:
#   0  worktree found (path printed to stdout)
#   1  task has no Branch column populated yet (e.g. /ship-pr hasn't run)
#   2  worktree path derived but doesn't exist on disk (stale Branch column or removed worktree)
#   3  Monday lookup failed (MONDAY_API_KEY not set, network, etc.)
#   4  argument error

set -u

if [ $# -lt 1 ]; then
  echo "Usage: $0 <monday-task-id>" >&2
  echo "       $0 2913546224" >&2
  exit 4
fi

TASK_ID="$1"
if ! [[ "$TASK_ID" =~ ^[0-9]+$ ]]; then
  echo "ERROR: task ID must be numeric, got: $TASK_ID" >&2
  exit 4
fi

# Resolve main checkout (the script may run from a worktree).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_COMMON_DIR=$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --git-common-dir 2>/dev/null)
if [ -z "$GIT_COMMON_DIR" ]; then
  echo "ERROR: not in a git repository" >&2
  exit 4
fi
MAIN_CHECKOUT="$(cd "$GIT_COMMON_DIR/.." && pwd)"

# Read the Branch column directly from Monday.
# Tasks board: 5091706356. Branch column: text_mm0pvs3n.
if [ -z "${MONDAY_API_KEY:-}" ]; then
  echo "ERROR: MONDAY_API_KEY env var not set. Set it in .env / direnv or load .mcp.json." >&2
  exit 3
fi

BRANCH=$(curl -sS https://api.monday.com/v2 \
  -H "Authorization: $MONDAY_API_KEY" \
  -H 'Content-Type: application/json' \
  --data "{\"query\":\"query{items(ids:[$TASK_ID]){column_values(ids:[\\\"text_mm0pvs3n\\\"]){text}}}\"}" 2>/dev/null \
  | jq -r '.data.items[0].column_values[0].text // empty' 2>/dev/null)

if [ -z "$BRANCH" ]; then
  echo "ERROR: task #$TASK_ID has no Branch column populated yet (or task does not exist)" >&2
  echo "Hint: Branch is set by /ship-pr Phase 4. Run /ship-pr from the task's worktree if the branch already exists locally." >&2
  exit 1
fi

# Derive worktree path from branch.
WORKTREE_SLUG="$(echo "$BRANCH" | tr '/' '-')"
WORKTREE_PATH="$MAIN_CHECKOUT/.claude/worktrees/$WORKTREE_SLUG"

# Print findings.
echo "Task #$TASK_ID branch: $BRANCH"
echo "Worktree path: $WORKTREE_PATH"

if [ ! -d "$WORKTREE_PATH" ]; then
  echo "WARNING: derived path does not exist on disk." >&2
  echo "Possible causes: worktree already removed by /ship-pr Phase 10, or Monday Branch column points at a branch never worktree'd locally." >&2
  exit 2
fi

# Verify the worktree is actually registered with git.
if ! git -C "$MAIN_CHECKOUT" worktree list --porcelain | grep -q "^worktree $WORKTREE_PATH$"; then
  echo "WARNING: directory exists but is not a registered git worktree." >&2
  exit 2
fi

# Verify the worktree's checked-out branch matches the Monday Branch column.
CHECKED_OUT=$(git -C "$WORKTREE_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$CHECKED_OUT" != "$BRANCH" ]; then
  echo "WARNING: worktree at this path has branch '$CHECKED_OUT' checked out, not '$BRANCH'." >&2
  echo "The path is correct per convention, but the branch was renamed locally without updating Monday." >&2
  # Not a hard error — still print path; just warn.
fi

exit 0
