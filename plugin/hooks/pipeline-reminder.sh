#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "pipeline-reminder" in hooks.enabled[]. Keeps the plugin's hooks
# dormant in projects that don't follow this workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-agent-cwd.sh"
hook_enabled "pipeline-reminder" || exit 0

# Hook: PostToolUse (Edit|Write)
# Soft, non-blocking nudge when the agent edits source files but
# `selfReviewPassed: false` in .claude/active-task.json — i.e. the
# implementation drifted since the last self-review and needs another pass.
#
# Excludes config / docs paths (.claude/, memory/, CLAUDE.md, .gitignore) so
# routine plumbing edits don't trigger the reminder.
# Always exits 0 — never blocks.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

# Only trigger for source file edits (skip .claude/, memory, config)
INPUT=$(cat)

# Update PROJECT_ROOT with the agent's actual cwd from the hook payload
# (prefer it over CLAUDE_PROJECT_DIR which is pinned to the main checkout).
AGENT_CWD=$(resolve_agent_cwd "$INPUT")
[ -n "$AGENT_CWD" ] && PROJECT_ROOT="$AGENT_CWD"
# STATE_FILE must be computed AFTER the AGENT_CWD override so it points at the
# worktree's active-task.json, not the main checkout's.
STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)

case "$FILE_PATH" in
  */.claude/*|*/memory/*|*/CLAUDE.md|*/.gitignore|*/AGENTS.md)
    exit 0
    ;;
esac

# Show current pipeline state on stderr (non-blocking)
if [ -f "$STATE_FILE" ]; then
  REVIEW=$(STATE_FILE_PATH="$STATE_FILE" python3 -c "
import json, os
with open(os.environ['STATE_FILE_PATH']) as f:
    s = json.load(f)
print('yes' if s.get('selfReviewPassed') else 'no')
" 2>/dev/null)

  if [ "$REVIEW" = "no" ]; then
    echo "Pipeline state: selfReviewPassed=false. Run /self-review when implementation is complete." >&2
  fi
fi

exit 0
