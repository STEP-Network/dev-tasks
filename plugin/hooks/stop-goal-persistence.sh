#!/bin/bash
#
# Hook: Stop — /goal persistence guard.
#
# The persistent, plugin-registered analogue of Claude Code's built-in `/goal`
# (a session-scoped, prompt-based Stop hook). A `/goal` skill writes a
# natural-language completion CONDITION to .claude/active-goal.json; this hook
# evaluates it on every Stop and REFUSES the stop while it is unmet — killing
# the failure mode where an autonomous-mode agent quits PREMATURELY because it
# *thinks* the session is too long / context-bloated / laggy (invalid: context
# auto-compacts and durable state persists in Monday + memory + PR + git).
#
# Exit-code contract (verified against stop-task-logic.py + the Claude Code
# hooks reference — NOT guessed):
#   exit 0 -> allow the stop (optionally emit advisory text to stderr)
#   exit 2 -> BLOCK the stop; stderr is fed back to the agent as guidance
#             ("keep working — <reason>"). Claude Code continues the conversation.
#
# Safety (this hook must NEVER trap the agent — see stop-goal-persistence-logic.py):
#   - honors the 3 legitimate pause reasons via active-task.json reviewAddressed
#     (handoff-to-orchestrator | stuck:* | timeout:*)
#   - max-consecutive-blocks escape hatch (persistent counter in the marker)
#   - /goal clear or goal-met releases cleanly
#   - fails OPEN on every error path
#
# Opt-in: silent no-op unless the consumer enabled this hook in
# .claude/project-config.json hooks.enabled[]. Mirrors the other workflow Stop
# hooks (stop-waiting-for-uat-stage, stop-monday-reconciled-check).

# Opt-in gate first — keeps the plugin dormant in projects that don't want it.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-agent-cwd.sh"
hook_enabled "stop-goal-persistence" || exit 0

# Per the Claude Code hooks spec, a Stop hook's block reason must be on stderr.
# Redirect stdout to stderr so any echo/print lands there.
exec >&2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Read the Stop-hook payload (JSON on stdin). Prefer the agent's actual cwd —
# CLAUDE_PROJECT_DIR is pinned to the main checkout at session start and never
# follows the agent into a worktree, so the marker + active-task.json we read
# must be resolved from the agent's cwd (the worktree when one is in use).
INPUT=$(cat 2>/dev/null || echo "")
AGENT_CWD=$(resolve_agent_cwd "$INPUT")

PROJECT_ROOT=""
if [ -n "$AGENT_CWD" ] && [ -d "$AGENT_CWD/.claude" ]; then
  PROJECT_ROOT="$AGENT_CWD"
elif [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "$CLAUDE_PROJECT_DIR/.claude" ]; then
  PROJECT_ROOT="$CLAUDE_PROJECT_DIR"
elif git_top=$(git rev-parse --show-toplevel 2>/dev/null); then
  PROJECT_ROOT="$git_top"
else
  PROJECT_ROOT="$PWD"
fi

# Extract stop_hook_active + transcript_path from the payload. Both are standard
# Stop-hook fields; absent on older Claude Code versions, so default safely.
# stop_hook_active is Claude Code's own immediate-loop signal (true when this
# Stop fired as a continuation of a prior Stop-hook block); we pass it through
# as a SECONDARY guard. The python logic's persistent counter is the primary one.
STOP_HOOK_ACTIVE=$(printf '%s' "$INPUT" | python3 -c "
import sys, json
try:
    print('1' if json.load(sys.stdin).get('stop_hook_active') else '')
except Exception:
    print('')
" 2>/dev/null)

TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | python3 -c "
import sys, json
try:
    print(json.load(sys.stdin).get('transcript_path') or '')
except Exception:
    print('')
" 2>/dev/null)

# Detect whether source files changed on this branch (used only to decide
# whether to surface the SELF-CHECK when NO goal is set). Same exclusion set as
# stop-task-check.sh: ignore .claude/, CLAUDE.md, memory/, .gitignore.
BASE_BRANCH=$(cd "$PROJECT_ROOT" && git rev-parse --verify origin/main >/dev/null 2>&1 && echo "origin/main" || echo "main")
HAS_SOURCE_CHANGES=$(cd "$PROJECT_ROOT" && git diff "$BASE_BRANCH"...HEAD --name-only 2>/dev/null \
  | grep -v '^\.\(claude\|gitignore\)' | grep -v '^CLAUDE\.md$' | grep -v '^memory/' | head -1)
HAS_UNCOMMITTED=$(cd "$PROJECT_ROOT" && git diff HEAD --name-only 2>/dev/null \
  | grep -v '^\.\(claude\|gitignore\)' | grep -v '^CLAUDE\.md$' | grep -v '^memory/' | head -1)
SOURCE_CHANGED=""
[ -n "${HAS_SOURCE_CHANGES}${HAS_UNCOMMITTED}" ] && SOURCE_CHANGED="1"

# Delegate all JSON-dependent decision logic to the python helper. It owns the
# exit code (0 allow / 2 block) and all stderr messaging.
exec python3 "$SCRIPT_DIR/stop-goal-persistence-logic.py" \
  "$PROJECT_ROOT" "$SOURCE_CHANGED" "$STOP_HOOK_ACTIVE" "$TRANSCRIPT_PATH"
