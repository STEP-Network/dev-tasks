#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "worktree-path-boundary" in hooks.enabled[]. Keeps the plugin's blocking hooks dormant
# in projects that don't follow the Monday task-first workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "worktree-path-boundary" || exit 0

# Hook: PreToolUse (Edit|Write)
# HARD BLOCK: when the session is in a worktree, edits to paths inside the
# MAIN checkout (but outside this worktree) are almost always an absolute-path
# mistake — the agent meant to edit the worktree's copy.
#
# Why this exists: see "Phase 1G" addition in PR #160 / security-corridor-botid
# branch. We had a session where the agent EnterWorktree'd correctly but then
# kept using main-checkout absolute paths from the session prompt, silently
# editing the wrong working tree. Worktree's git status stayed clean while
# main accumulated dirty state. This hook surfaces that class of error.
#
# Behavior:
#  - If NOT in a worktree → exit 0 (no boundary to enforce).
#  - If file_path is inside the active worktree → exit 0.
#  - If file_path is OUTSIDE the project entirely (e.g. ~/.claude/CLAUDE.md,
#    ~/.corridor/config.env, /tmp/*) → exit 0. Those are legitimate cross-cut edits.
#  - If file_path is inside the main checkout but NOT inside this worktree → exit 2 BLOCK.
#
# Exit 2 = block the tool call with the message shown to the agent.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)

# Empty path → not actionable, let other hooks handle it.
[ -z "$FILE_PATH" ] && exit 0

# Detect worktree state via git plumbing.
GIT_COMMON_DIR=$(cd "$PROJECT_ROOT" && git rev-parse --git-common-dir 2>/dev/null)
GIT_DIR=$(cd "$PROJECT_ROOT" && git rev-parse --git-dir 2>/dev/null)

# Not a worktree (common-dir == git-dir) or git unavailable → no boundary to enforce.
if [ -z "$GIT_COMMON_DIR" ] || [ "$GIT_COMMON_DIR" = "$GIT_DIR" ]; then
  exit 0
fi

WORKTREE_TOPLEVEL=$(cd "$PROJECT_ROOT" && git rev-parse --show-toplevel 2>/dev/null)
# Main checkout toplevel = parent of the common .git directory.
# Resolve common-dir to absolute first (it may be relative when invoked via worktree).
ABS_COMMON_DIR=$(cd "$PROJECT_ROOT" && cd "$GIT_COMMON_DIR" && pwd 2>/dev/null)
MAIN_TOPLEVEL=$(dirname "$ABS_COMMON_DIR")

# Sanity: both paths must be non-empty and distinct.
[ -z "$WORKTREE_TOPLEVEL" ] || [ -z "$MAIN_TOPLEVEL" ] && exit 0
[ "$WORKTREE_TOPLEVEL" = "$MAIN_TOPLEVEL" ] && exit 0

case "$FILE_PATH" in
  "$WORKTREE_TOPLEVEL"/*)
    # Inside the active worktree → OK.
    exit 0
    ;;
  "$MAIN_TOPLEVEL"/*)
    # Inside the main checkout but NOT inside this worktree → BLOCK.
    REL_PATH=${FILE_PATH#$MAIN_TOPLEVEL/}
    SUGGESTED="${WORKTREE_TOPLEVEL}/${REL_PATH}"
    echo "BLOCKED: edit target is in the main checkout, not the active worktree."
    echo ""
    echo "  File:     $FILE_PATH"
    echo "  Worktree: $WORKTREE_TOPLEVEL"
    echo "  Main:     $MAIN_TOPLEVEL"
    echo ""
    echo "Likely cause: an absolute path from session-start context (claudeMd,"
    echo "Read history) points at the main checkout. Edits there bypass the"
    echo "worktree boundary — main collects dirty state, worktree stays clean,"
    echo "and a later push ships nothing."
    echo ""
    echo "Use the worktree-rooted path instead:"
    echo ""
    echo "  $SUGGESTED"
    echo ""
    echo "If you genuinely need to edit the main checkout (rare — only for"
    echo "untracked files outside this branch's scope), exit the worktree first"
    echo "with ExitWorktree({action: \"keep\"})."
    exit 2
    ;;
esac

# Path is outside both the worktree and the main checkout (e.g. ~/.claude/CLAUDE.md,
# ~/.corridor/config.env, /tmp/*). Allow — these are legitimate cross-cut edits.
exit 0
