#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "build-failure-advisor" in hooks.enabled[]. Keeps the plugin's hooks
# dormant in projects that don't follow this workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "build-failure-advisor" || exit 0

# Hook: PostToolUse (Bash)
# Parse build/test/lint failures and provide structured suggestions.
# Universal patterns: TypeScript compiler errors, ESLint, Jest/Vitest, generic
# "Build error / Failed to compile / Module not found". STEP-Network uses pnpm
# (per project-config alignment) so the matcher is pnpm-specific; if STEPhie or
# a future product uses npm/yarn/bun, generalize at that point.
#
# Input: JSON on stdin with tool_input.command and tool_response.
# Always exits 0 — informational, never blocks.

# Read tool input from stdin (consumed once)
INPUT=$(cat)

# Extract command and response from JSON
PARSED=$(echo "$INPUT" | python3 -c "
import sys, json
d = json.load(sys.stdin)
cmd = d.get('tool_input', {}).get('command', '')
resp = d.get('tool_response', '')
if isinstance(resp, dict):
    resp = json.dumps(resp)
print(cmd)
print('---SEPARATOR---')
print(resp)
" 2>/dev/null)

COMMAND=$(echo "$PARSED" | sed -n '1p')
OUTPUT=$(echo "$PARSED" | sed '1,/^---SEPARATOR---$/d')

# Check if it's a build/test/lint command
if ! echo "$COMMAND" | grep -qE "pnpm (build|test|lint|tsc|pre-push|validate-schema)"; then
  exit 0
fi

# Output to stderr so the agent sees it as system context
exec >&2

# Detect if the command succeeded (look for common success patterns)
if echo "$OUTPUT" | grep -qE "✓ Compiled|Lint free|Tests:.*passed.*0 failed|Test Suites:.*passed.*0 failed"; then
  rm -f /tmp/.claude-failure-count
  exit 0
fi

# Detect failure patterns
HAS_FAILURE=false

# Parse TypeScript errors
if echo "$OUTPUT" | grep -q "error TS"; then
  HAS_FAILURE=true
  TS_ERRORS=$(echo "$OUTPUT" | grep -c "error TS" 2>/dev/null || echo "?")
  echo "TypeScript Errors: $TS_ERRORS found"
  echo "Suggestion: Check type annotations, imports, and interface definitions"
  echo ""
fi

# Parse ESLint errors
if echo "$OUTPUT" | grep -qE "@typescript-eslint|eslint"; then
  HAS_FAILURE=true
  echo "ESLint Errors detected"
  echo "Suggestion: Run 'pnpm lint --fix' for auto-fixable issues"
  echo ""
fi

# Parse test failures
if echo "$OUTPUT" | grep -qE "FAIL|Tests:.*failed"; then
  HAS_FAILURE=true
  FAILED=$(echo "$OUTPUT" | grep -c "FAIL" 2>/dev/null || echo "?")
  echo "Test Failures: $FAILED test suite(s)"
  echo "Suggestion: Check test expectations, mocks, and data fixtures"
  echo ""
fi

# Parse build errors (general)
if echo "$OUTPUT" | grep -qE "Build error|Failed to compile|Module not found"; then
  HAS_FAILURE=true
  echo "Build Error detected"
  echo "Suggestion: Check imports, missing modules, and build configuration"
  echo ""
fi

if [ "$HAS_FAILURE" = true ]; then
  # Track consecutive failures
  FAILURE_COUNT_FILE="/tmp/.claude-failure-count"
  if [ -f "$FAILURE_COUNT_FILE" ]; then
    COUNT=$(cat "$FAILURE_COUNT_FILE")
    COUNT=$((COUNT + 1))
  else
    COUNT=1
  fi
  echo "$COUNT" > "$FAILURE_COUNT_FILE"

  if [ "$COUNT" -ge 3 ]; then
    echo "WARNING: $COUNT consecutive failures detected."
    echo "Consider: stepping back to analyze the root cause, or asking the user for help."
    echo "Use /log-progress TASK_STUCK if blocked."
  fi
else
  # No specific failure pattern matched but command may have still failed
  # Reset counter on ambiguous output
  rm -f /tmp/.claude-failure-count
fi

exit 0
