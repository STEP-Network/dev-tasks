#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "stop-task-check" in hooks.enabled[]. Keeps the plugin's blocking hooks dormant
# in projects that don't follow the Monday task-first workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "stop-task-check" || exit 0

# Redirect stdout to stderr so block messages (exit 2) reach Claude Code
# correctly. Per Claude Code hooks spec, block reasons must be on stderr.
exec >&2

# Hook: Stop
# ENFORCED post-implementation pipeline — hard blocks (exit 2) when source files
# changed but pipeline is incomplete. Allows stop for infrastructure-only sessions.

# Resolve project root from CWD-based git plumbing — Stop hooks don't carry
# a file_path payload, but CWD typically reflects the active worktree.
# CLAUDE_PROJECT_DIR is set at session start and doesn't follow EnterWorktree.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-project-root.sh"
PROJECT_ROOT=$(resolve_project_root "")

STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"

# No state file → allow stop (no active task)
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

# Pre-validate JSON before doing anything else
if ! STATE_FILE_PATH="$STATE_FILE" python3 -c "import json, os; json.load(open(os.environ['STATE_FILE_PATH']))" 2>/dev/null; then
  echo "WARNING: .claude/active-task.json contains invalid JSON. Run /pickup-task to recreate it." >&2
  exit 0
fi

# Resolve the base branch from project-config git.defaultBase (default "main").
# NEVER hardcode origin/main: on a project whose defaultBase is "staging",
# origin/staging carries every merged-but-unreleased task, so diffing against
# origin/main attributes that entire delta to a freshly claimed branch and blocks
# the very first stop of every session. Prefer $PROJECT_ROOT's own config —
# CLAUDE_PROJECT_DIR (what read_project_config reads) does not follow
# EnterWorktree, and PROJECT_ROOT does.
BASE_BRANCH_NAME=""
PROJECT_CONFIG="$PROJECT_ROOT/.claude/project-config.json"
if [ -f "$PROJECT_CONFIG" ]; then
  BASE_BRANCH_NAME=$(jq -r '.git.defaultBase // empty' "$PROJECT_CONFIG" 2>/dev/null)
fi
[ -z "$BASE_BRANCH_NAME" ] && BASE_BRANCH_NAME=$(read_project_config '.git.defaultBase')

# The value is interpolated into git commands, so constrain it to a branch-name
# charset and reject a leading dash (git option injection). Anything else falls
# back to "main" rather than reaching git.
if ! printf '%s' "$BASE_BRANCH_NAME" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*$'; then
  BASE_BRANCH_NAME="main"
fi

# Prefer the remote-tracking ref so a stale local base branch can't shrink the diff.
if (cd "$PROJECT_ROOT" && git rev-parse --verify "origin/$BASE_BRANCH_NAME" >/dev/null 2>&1); then
  BASE_BRANCH="origin/$BASE_BRANCH_NAME"
else
  BASE_BRANCH="$BASE_BRANCH_NAME"
fi

# Check for source file changes (exclude .claude/, CLAUDE.md, memory/, .gitignore)
HAS_SOURCE_CHANGES=$(cd "$PROJECT_ROOT" && git diff "$BASE_BRANCH"...HEAD --name-only 2>/dev/null | grep -v '^\.\(claude\|gitignore\)' | grep -v '^CLAUDE\.md$' | grep -v '^memory/' | head -1)
HAS_UNCOMMITTED_CHANGES=$(cd "$PROJECT_ROOT" && git diff HEAD --name-only 2>/dev/null | grep -v '^\.\(claude\|gitignore\)' | grep -v '^CLAUDE\.md$' | grep -v '^memory/' | head -1)

COMBINED_CHANGES="${HAS_SOURCE_CHANGES}${HAS_UNCOMMITTED_CHANGES}"

# Delegate to Python helper script for all JSON-dependent logic
exec python3 "$SCRIPT_DIR/stop-task-logic.py" "$STATE_FILE" "$PROJECT_ROOT" "$COMBINED_CHANGES"
