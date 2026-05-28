#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "post-self-review" in hooks.enabled[]. Keeps the plugin's hooks dormant in
# projects that don't follow this workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-agent-cwd.sh"
hook_enabled "post-self-review" || exit 0
# Hook: PostToolUse (Task) — captures /self-review iterations into review-memory.
# Non-blocking: this hook MUST never block the agent. Exit 0 on every error.
#
# Closes GH issue #117 (GAP-J Loop 1).
#
# What it does:
#   - When the Task tool returns from a self-reviewer agent, parse the agent
#     output for findings, structure them into a reviews.jsonl row, and append
#     via scripts/append-review-memory.ts.
#   - Best-effort. If parsing fails, log a soft warning to stderr and exit 0.
#     We never want this hook to interrupt the actual review pipeline.
#
# Input: JSON on stdin with tool_input + tool_response.

INPUT=$(cat)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Prefer the agent's actual cwd from the hook payload — both the parse step
# (which reads STATE_FILE) and the append-review-memory.ts call (which keys on
# CLAUDE_PROJECT_DIR for memory path resolution) need the worktree's root, not
# the main checkout's. PR I (#58) fixed only the marker-emit path; this picks
# up the rest of the hook.
AGENT_CWD=$(resolve_agent_cwd "$INPUT")
PROJECT_ROOT="${AGENT_CWD:-${CLAUDE_PROJECT_DIR:-$PWD}}"

# Quick filter: only fire on Task calls to the self-reviewer agent.
# tool_input.subagent_type === "self-reviewer" identifies the call.
SUBAGENT=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('tool_input', {}).get('subagent_type', ''))
except Exception:
    pass
" 2>/dev/null)

# Match both the bare name and the plugin-namespaced form. Claude Code passes
# the fully-qualified `dev-tasks:self-reviewer` when the agent is invoked from
# an installed plugin; the bare form covers project-local definitions.
case "$SUBAGENT" in
  self-reviewer|dev-tasks:self-reviewer) ;;
  *) exit 0 ;;
esac

# Parse the agent output + extract structured findings + append.
# All work delegated to a Python parser to keep the hook fast and the parser
# unit-testable. The parser MUST never raise — it always emits a row (even if
# minimal / mostly-empty) so we capture SOMETHING per review.
PARSED_ROW=$(STATE_FILE="$PROJECT_ROOT/.claude/active-task.json" \
             PROJECT_ROOT="$PROJECT_ROOT" \
             python3 "$SCRIPT_DIR/parse-self-review-output.py" 2>/dev/null <<< "$INPUT")

if [ -z "$PARSED_ROW" ]; then
  echo "post-self-review: parser produced no output, skipping append" >&2
  exit 0
fi

# Append via the plugin's TS validator. The validator exits non-zero on
# schema failure; we capture that and warn but DO NOT block.
#
# We invoke the plugin's local `tsx` binary directly (not `pnpm tsx`). pnpm
# would call `runDepsStatusCheck` → `pnpm install` → potentially fail on
# ERR_PNPM_IGNORED_BUILDS in the consumer repo. The plugin's own
# node_modules ships with tsx pre-installed (declared as a runtime dep in
# plugin/package.json as of v0.9.0).
TSX_BIN="$SCRIPT_DIR/../node_modules/.bin/tsx"
APPEND_SCRIPT="$SCRIPT_DIR/append-review-memory.ts"

if [ -x "$TSX_BIN" ]; then
  APPEND_OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJECT_ROOT" "$TSX_BIN" "$APPEND_SCRIPT" 2>&1 <<< "$PARSED_ROW")
  APPEND_EXIT=$?
else
  # No fallback: tsx is a runtime dep in plugin/package.json, and the plugin's
  # `npm install` at install time populates node_modules/.bin/tsx. If we got
  # here, something is wrong with the install — fail loudly rather than silently
  # masking with an npx download path.
  APPEND_OUTPUT="post-self-review: tsx binary missing at $TSX_BIN — plugin install is incomplete"
  APPEND_EXIT=1
fi

if [ "$APPEND_EXIT" -ne 0 ]; then
  echo "post-self-review: append failed (non-blocking)" >&2
  echo "$APPEND_OUTPUT" >&2
fi

# Marker emission: if the self-reviewer agent's output contains "Self-Review PASSED",
# emit the marker that unlocks `selfReviewPassed=true` in protect-active-task-state.
# Tied to the subagent's actual stdout — an orchestrator that didn't run /self-review
# has nothing to emit unless it explicitly fakes the marker via Bash (visible in
# the transcript).
PASSED=$(echo "$INPUT" | python3 -c "
import sys, json, os
sys.path.insert(0, os.path.join('$SCRIPT_DIR', 'lib'))
from tool_response_helpers import extract_text
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
text = extract_text(data.get('tool_response', ''))
if 'Self-Review PASSED' in text:
    print('YES')
" 2>/dev/null)

if [ "$PASSED" = "YES" ]; then
  EMITTER="$SCRIPT_DIR/../scripts/emit-state-marker.sh"
  if [ -x "$EMITTER" ]; then
    # Emit from the agent's actual cwd (the worktree, when one is in use).
    # AGENT_CWD was already resolved at the top of the hook via the shared
    # lib/resolve-agent-cwd.sh helper; PROJECT_ROOT is the AGENT_CWD-aware
    # fallback chain. The marker is SHA-scoped via `git rev-parse HEAD`
    # from the emit-from directory.
    (cd "$PROJECT_ROOT" && bash "$EMITTER" selfReviewPassed >/dev/null 2>&1) || true
  fi
fi

exit 0
