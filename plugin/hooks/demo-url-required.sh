#!/bin/bash
# plugin/hooks/demo-url-required.sh
#
# Hook: PreToolUse on mcp__plugin_dev-tasks_dev-tasks__updateTask.
#
# Refuses (exit 2) any updateTask call that sets status='Waiting for UAT'
# WITHOUT a valid demoUrl. "Valid" means: matches the consumer's configured
# preview-URL regex (project-config.ci.previewUrlPattern). Default pattern
# `^https://` permits any HTTPS URL.
#
# Rationale: transitions to Waiting for UAT without a clickable preview URL
# leave UAT reviewers with nothing actionable.
#
# The plugin is auth/platform-agnostic. Consumers set
# `ci.previewUrlPattern` in .claude/project-config.json to tighten validation
# to their deploy platform (e.g. `^https://.*\.vercel\.app(/.*)?$`,
# `^https://test\.example\.com`).
#
# If the task already has a demoUrl set in Monday (i.e. updateTask omits the
# demoUrl param but the task already has one), this hook can't see it without
# a Monday round-trip. Cheap shortcut: read the previewUrl mirror from
# .claude/active-task.json — if set, accept the transition. Otherwise block.

# Redirect stdout to stderr.
exec >&2

# Opt-in gate.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "demo-url-required" || exit 0

INPUT=$(cat)

# Extract status + demoUrl + itemId from tool_input.
PARSED=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    ti = data.get('tool_input') or {}
    print(ti.get('status') or '')
    print(ti.get('demoUrl') or '')
    print(ti.get('itemId') or '')
except Exception:
    print('')
    print('')
    print('')
" 2>/dev/null)

TARGET_STATUS=$(echo "$PARSED" | sed -n '1p')
DEMO_URL=$(echo "$PARSED" | sed -n '2p')
ITEM_ID=$(echo "$PARSED" | sed -n '3p')

# Only fire when transitioning to Waiting for UAT.
if [ "$TARGET_STATUS" != "Waiting for UAT" ]; then
  exit 0
fi

# Resolve project root.
PROJECT_ROOT=""
# Prefer $CLAUDE_PROJECT_DIR (Claude Code session-level, authoritative). Fall
# back to git rev-parse + $PWD for CLI usage outside Claude Code.
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "$CLAUDE_PROJECT_DIR/.claude" ]; then
  PROJECT_ROOT="$CLAUDE_PROJECT_DIR"
elif git_top=$(git rev-parse --show-toplevel 2>/dev/null); then
  PROJECT_ROOT="$git_top"
else
  PROJECT_ROOT="$PWD"
fi

STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"

# Determine effective demoUrl. Priority: argument > active-task.json mirror.
EFFECTIVE_URL="$DEMO_URL"
if [ -z "$EFFECTIVE_URL" ] && [ -f "$STATE_FILE" ]; then
  EFFECTIVE_URL=$(jq -r '.previewUrl // .demoUrl // ""' "$STATE_FILE" 2>/dev/null)
fi

# Read configured pattern (default permits any HTTPS URL).
URL_PATTERN=$(read_project_config '.ci.previewUrlPattern')
if [ -z "$URL_PATTERN" ]; then
  URL_PATTERN='^https://'
fi

# Empty → block.
if [ -z "$EFFECTIVE_URL" ]; then
  echo "BLOCKED: demoUrl is required when transitioning task #$ITEM_ID to 'Waiting for UAT'."
  echo ""
  echo "UAT reviewers need a clickable preview URL to validate the change."
  echo ""
  echo "Set the demoUrl in this updateTask call:"
  echo "  updateTask(itemId=$ITEM_ID, status='Waiting for UAT', demoUrl=<preview URL>)"
  echo ""
  echo "Configured pattern: $URL_PATTERN (project-config.ci.previewUrlPattern)"
  echo ""
  echo "If your project uses Vercel previews, get the URL via"
  echo "mcp__plugin_vercel_vercel__list_deployments after the PR's first push"
  echo "(/ship-pr Phase 4 already does this; the previewUrl mirror in"
  echo "active-task.json should be set automatically)."
  exit 2
fi

# Validate URL against configured regex using python3 (portable + reliable).
VALID=$(URL_PATTERN_VAR="$URL_PATTERN" EFFECTIVE_URL_VAR="$EFFECTIVE_URL" python3 -c "
import os, re, sys
pattern = os.environ.get('URL_PATTERN_VAR', '')
url = os.environ.get('EFFECTIVE_URL_VAR', '')
try:
    print('1' if re.match(pattern, url) else '0')
except re.error:
    print('PATTERN_ERROR')
" 2>/dev/null)

if [ "$VALID" = "PATTERN_ERROR" ]; then
  echo "BLOCKED: demo-url-required hook misconfigured."
  echo ""
  echo "project-config.ci.previewUrlPattern is not a valid Python regex: $URL_PATTERN"
  echo ""
  echo "Fix the pattern in .claude/project-config.json and retry, OR remove the"
  echo "field to fall back to the default (any HTTPS URL: '^https://')."
  exit 2
fi

if [ "$VALID" != "1" ]; then
  echo "BLOCKED: demoUrl '$EFFECTIVE_URL' does not match the configured preview-URL pattern."
  echo ""
  echo "Pattern (from project-config.ci.previewUrlPattern): $URL_PATTERN"
  echo "Got: $EFFECTIVE_URL"
  echo ""
  echo "Pass a matching URL via updateTask(demoUrl=...). If the pattern is wrong,"
  echo "update .claude/project-config.json (or remove the field to fall back to"
  echo "the default '^https://' which permits any HTTPS URL)."
  exit 2
fi

exit 0
