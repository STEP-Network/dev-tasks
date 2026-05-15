#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "stop-task-check" in hooks.enabled[]. Keeps the plugin's blocking hooks dormant
# in projects that don't follow the Monday task-first workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "stop-task-check" || exit 0

# Hook: Stop
# ENFORCED post-implementation pipeline — hard blocks (exit 2) when source files
# changed but pipeline is incomplete. Allows stop for infrastructure-only sessions.

# Resolve project root from this script's location (hooks/ -> .claude/ -> project root)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

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

# Derive base branch dynamically (default to main)
BASE_BRANCH=$(cd "$PROJECT_ROOT" && git rev-parse --verify origin/main >/dev/null 2>&1 && echo "origin/main" || echo "main")

# Check for source file changes (exclude .claude/, CLAUDE.md, memory/, .gitignore)
HAS_SOURCE_CHANGES=$(cd "$PROJECT_ROOT" && git diff "$BASE_BRANCH"...HEAD --name-only 2>/dev/null | grep -v '^\.\(claude\|gitignore\)' | grep -v '^CLAUDE\.md$' | grep -v '^memory/' | head -1)
HAS_UNCOMMITTED_CHANGES=$(cd "$PROJECT_ROOT" && git diff HEAD --name-only 2>/dev/null | grep -v '^\.\(claude\|gitignore\)' | grep -v '^CLAUDE\.md$' | grep -v '^memory/' | head -1)

COMBINED_CHANGES="${HAS_SOURCE_CHANGES}${HAS_UNCOMMITTED_CHANGES}"

# Delegate to Python helper script for all JSON-dependent logic
exec python3 "$SCRIPT_DIR/stop-task-logic.py" "$STATE_FILE" "$PROJECT_ROOT" "$COMBINED_CHANGES"
