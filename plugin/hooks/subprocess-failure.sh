#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "subprocess-failure" in hooks.enabled[]. Keeps the plugin's hooks dormant in
# projects that don't follow this workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "subprocess-failure" || exit 0
# Hook: Notification
# Log subprocess/agent failures and suggest escalation after repeated failures
# Input: JSON on stdin with message, title, notification_type

# Read notification from stdin (consumed once)
INPUT=$(cat)

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
MESSAGE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message',''))" 2>/dev/null)

# Log the notification
echo "[$TIMESTAMP] Subprocess notification: $MESSAGE"

# Track failures for escalation
FAILURE_LOG="/tmp/.claude-subprocess-failures"

if echo "$MESSAGE" | grep -qiE "fail|error|crash"; then
  echo "$TIMESTAMP: $MESSAGE" >> "$FAILURE_LOG" 2>/dev/null

  # Count accumulated failures (resets after threshold)
  if [ -f "$FAILURE_LOG" ]; then
    RECENT_COUNT=$(wc -l < "$FAILURE_LOG" 2>/dev/null | tr -d ' ')

    if [ "$RECENT_COUNT" -ge 3 ]; then
      echo "WARNING: $RECENT_COUNT subprocess failures detected."
      echo "Suggestion: Consider escalating — use /log-progress TASK_STUCK"
      echo "Or file a bug via mcp__plugin_dev-tasks_dev-tasks__createBug"
      # Reset counter
      rm -f "$FAILURE_LOG"
    fi
  fi
fi

exit 0
