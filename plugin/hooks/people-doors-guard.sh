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

printf '%s' "$INPUT" | exec node "$(dirname "${BASH_SOURCE[0]}")/people-doors-guard.mjs"
