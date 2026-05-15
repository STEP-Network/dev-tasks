#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "branch-task-match" in hooks.enabled[].
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "branch-task-match" || exit 0

# Redirect stdout to stderr so block messages reach Claude Code correctly.
exec >&2

# Hook: PreToolUse (Edit|Write|MultiEdit|NotebookEdit)
# Closes the gap "no MCP-level enforcement that the Monday task's text_mm0pvs3n
# branch column matches the current git branch":
#
#   Compares `git branch --show-current` to the `branch` field stored in
#   .claude/active-task.json (written by /pickup-task). If they diverge, the
#   agent has wandered off the claimed task's branch — block source edits until
#   either the branch is corrected or active-task.json is updated to match.
#
# Fails OPEN (exit 0 silently) on:
#   - missing active-task.json (task-state-guard handles that case)
#   - active-task.json has no `branch` field (legacy file — don't block)
#   - not in a git repo
#   - any unexpected error

PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"

# Skip if no active task — task-state-guard handles that
[ ! -f "$STATE_FILE" ] && exit 0

# Read the claimed branch from active-task.json. Empty/absent → skip.
CLAIMED_BRANCH=$(jq -r '.branch // empty' "$STATE_FILE" 2>/dev/null)
[ -z "$CLAIMED_BRANCH" ] && exit 0

# Read current git branch. If not in a repo, skip.
CURRENT_BRANCH=$(git -C "$PROJECT_ROOT" branch --show-current 2>/dev/null)
[ -z "$CURRENT_BRANCH" ] && exit 0

# Allow exact match.
[ "$CURRENT_BRANCH" = "$CLAIMED_BRANCH" ] && exit 0

# Read input to pull out the file path for a more useful error message
INPUT=$(cat)
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null || printf '')

TASK_ID=$(jq -r '.taskId // "(unknown)"' "$STATE_FILE" 2>/dev/null)
TASK_NAME=$(jq -r '.taskName // "(unnamed)"' "$STATE_FILE" 2>/dev/null)

cat <<EOF
BLOCKED: current git branch does not match the claimed task's branch.

Claimed task : #${TASK_ID} — ${TASK_NAME}
Expected     : ${CLAIMED_BRANCH}
Current      : ${CURRENT_BRANCH}
File         : ${FILE_PATH:-<unknown>}

This guard prevents drift between the Monday task's Branch column and the actual
working branch. Three ways to recover:

  1. Switch back to the claimed branch:
     git -C "${PROJECT_ROOT}" checkout "${CLAIMED_BRANCH}"

  2. If you legitimately want to work on the current branch instead (rare —
     usually means the task was claimed on the wrong branch), update both
     Monday and active-task.json:
       updateTask({ itemId: ${TASK_ID}, branch: "${CURRENT_BRANCH}" })
       jq '.branch = "${CURRENT_BRANCH}"' .claude/active-task.json | sponge

  3. End the session and start fresh from /pickup-task in the right worktree.
EOF
exit 2
