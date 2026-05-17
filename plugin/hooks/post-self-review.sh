#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "post-self-review" in hooks.enabled[]. Keeps the plugin's hooks dormant in
# projects that don't follow this workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
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
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

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

if [ "$SUBAGENT" != "self-reviewer" ]; then
  exit 0
fi

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
elif command -v npx >/dev/null 2>&1; then
  # Defensive fallback for dev installs where the plugin's node_modules isn't
  # populated. npx --no-install refuses to fetch tsx — fails fast if it's not
  # already in some node_modules up the tree.
  APPEND_OUTPUT=$(CLAUDE_PROJECT_DIR="$PROJECT_ROOT" npx --no-install tsx "$APPEND_SCRIPT" 2>&1 <<< "$PARSED_ROW")
  APPEND_EXIT=$?
else
  APPEND_OUTPUT="tsx binary unavailable at $TSX_BIN and npx not on PATH — skipping append"
  APPEND_EXIT=1
fi

if [ "$APPEND_EXIT" -ne 0 ]; then
  echo "post-self-review: append failed (non-blocking)" >&2
  echo "$APPEND_OUTPUT" >&2
fi

exit 0
