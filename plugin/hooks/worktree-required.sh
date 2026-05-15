#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "worktree-required" in hooks.enabled[]. Keeps the plugin's blocking hooks dormant
# in projects that don't follow the Monday task-first workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "worktree-required" || exit 0

# Redirect stdout to stderr so block messages (exit 2) reach Claude Code
# correctly. Per Claude Code hooks spec, block reasons must be on stderr.
exec >&2

# Hook: PreToolUse (Edit|Write)
# HARD BLOCK: When a Monday task is claimed, edits MUST happen in a git worktree.
#
# Rationale: claimed work runs in isolation per-task. Worktrees give each task
# its own checkout + .claude/active-task.json + push marker, so two parallel
# Claude sessions don't clobber each other's state. See
# .claude/rules/worktree-discipline.md.
#
# Detection: a session is "in a worktree" when `git rev-parse --git-common-dir`
# differs from `git rev-parse --git-dir`. This catches BOTH `.claude/worktrees/`
# (created by EnterWorktree) and sibling worktrees from `git worktree add ../foo`.
#
# Escape hatch: set `"allowMainCheckout": true` in .claude/active-task.json for
# rare emergencies (in-flight hotfix, exploratory throwaway work). The flag is
# explicit and visible — that's the point.
#
# Exit 2 = block the tool call with message shown to agent.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)

# Allow edits to Claude infra files (matches task-state-guard.sh convention).
# Includes the state file itself, hooks, skills, rules, memory, CLAUDE.md, .gitignore.
case "$FILE_PATH" in
  */.claude/*|*/memory/*|*/CLAUDE.md|*/.gitignore)
    exit 0
    ;;
esac

STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"
# task-state-guard.sh already blocks "no active task". If the state file is
# absent here, defer to that hook — don't double-block.
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

# Explicit escape hatch: allowMainCheckout=true bypasses the worktree requirement.
ALLOW_MAIN=$(jq -r '.allowMainCheckout // false' "$STATE_FILE" 2>/dev/null)
if [ "$ALLOW_MAIN" = "true" ]; then
  exit 0
fi

# Worktree detection via git plumbing — works for both .claude/worktrees/* AND
# sibling worktrees. Both vars must be non-empty AND different.
GIT_COMMON_DIR=$(cd "$PROJECT_ROOT" && git rev-parse --git-common-dir 2>/dev/null)
GIT_DIR=$(cd "$PROJECT_ROOT" && git rev-parse --git-dir 2>/dev/null)
if [ -n "$GIT_COMMON_DIR" ] && [ -n "$GIT_DIR" ] && [ "$GIT_COMMON_DIR" != "$GIT_DIR" ]; then
  exit 0
fi

# Not in a worktree, no opt-out, has active task → block.
TASK_NAME=$(jq -r '.taskName // "(unnamed task)"' "$STATE_FILE" 2>/dev/null)
TASK_ID=$(jq -r '.taskId // "?"' "$STATE_FILE" 2>/dev/null)
echo "BLOCKED: active task '$TASK_NAME' (#$TASK_ID) requires a git worktree."
echo ""
echo "Edits to source files must happen in a worktree, not the main checkout."
echo "This prevents two parallel Claude sessions from clobbering each other's"
echo "state files, push markers, and dirty trees."
echo ""
echo "Three ways to recover:"
echo "  1. Run EnterWorktree({name: 'feat-<short-slug>'}) to create a worktree"
echo "     for this task and continue here. (Recommended.)"
echo ""
echo "  2. Exit this session and start fresh — /pickup-task will enter a"
echo "     worktree automatically per its Phase 0."
echo ""
echo "  3. (Emergency only) Add \"allowMainCheckout\": true to"
echo "     .claude/active-task.json. The flag is explicit + visible so future"
echo "     reviewers can audit the exception. Document why in the task body."
echo ""
echo "See .claude/rules/worktree-discipline.md for the full discipline."
exit 2
