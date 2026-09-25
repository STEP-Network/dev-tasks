#!/bin/bash
# Hook: PreToolUse (the claude.ai Monday, Slack and Linear connectors; Bash, Edit, Write)
# The people-doors guard (STEP-3330): no agent session writes as a person
# through the claude.ai connectors, and none changes the guard's own list.
# Always on, on both profiles, with no hooks.enabled[] gate: it guards
# people, not a project's workflow. The rules are in people-doors-guard.mjs.

INPUT=$(cat)

# Only a connector call, or something that names the guard's list, reaches
# Node: every other Bash, Edit and Write passes at once.
if ! printf '%s' "$INPUT" | grep -qE '"tool_name" *: *"mcp__(claude_ai_monday_com|claude_ai_Slack|linear-server)__|people-doors\.json|\.config/dev-tasks'; then
  exit 0
fi

printf '%s' "$INPUT" | exec node "$(dirname "${BASH_SOURCE[0]}")/people-doors-guard.mjs"
