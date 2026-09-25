#!/bin/bash
# Hook: PreToolUse (every Monday, Slack, Linear and dev-tasks server's tools; Bash)
# The people-doors guard (STEP-3330): no agent session writes as a person
# through those tools, or through the Monday, Slack and Linear APIs from the
# shell. Always on, on both profiles, with no hooks.enabled[] gate: it guards
# people, not a project's workflow. The rules are in people-doors-rules.mjs,
# the list and the lookups in people-doors-guard.mjs.

INPUT=$(cat)

# Only a guarded server's call, or a command that names one of the three APIs
# or the guard's list, reaches Node: every other Bash passes at once.
if ! printf '%s' "$INPUT" | grep -qiE '"tool_name" *: *"mcp__[^"]*(monday|slack|linear|dev[-_]?tasks)|api\.monday\.com|api\.linear\.app|slack\.com/api|people-doors|/etc/dev-tasks'; then
  exit 0
fi

# A guard that cannot run refuses: no Node, or Node failing, is never a pass.
deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$1"
  exit 0
}
command -v node >/dev/null 2>&1 || deny "The people-doors guard could not run (no node on PATH), so it refused the call. Put Node on PATH and try again."
OUT=$(printf '%s' "$INPUT" | node "$(dirname "${BASH_SOURCE[0]}")/people-doors-guard.mjs")
CODE=$?
[ "$CODE" -eq 0 ] || deny "The people-doors guard failed (exit $CODE), so it refused the call."
printf '%s' "$OUT"
