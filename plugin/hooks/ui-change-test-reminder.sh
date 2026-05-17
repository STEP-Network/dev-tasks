#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "ui-change-test-reminder" in hooks.enabled[].
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "ui-change-test-reminder" || exit 0

# Hook: PostToolUse (Edit|Write|MultiEdit) — non-blocking nudge.
# Fires when an agent edits a UI source file. Surfaces a reminder that the
# change needs an E2E test + visual-diff before /self-review will mark Check
# #8 / Check #2 PASS. Always exits 0 — never blocks edits.
#
# Triggers on:
#   components/**/*.tsx, *.jsx
#   app/**/page.tsx, *.jsx
#   app/**/layout.tsx, *.jsx
#   lib/email/*-templates.tsx
#   *.css / *.scss in component directories
#
# Skips:
#   *.test.tsx, *.spec.tsx (already test files)
#   __tests__/** (tests editing themselves)
#   e2e/** (E2E itself)
#   .claude/** (config / plugin infrastructure)

INPUT=$(cat)
FILE_PATH=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)

# Skip non-applicable files
case "$FILE_PATH" in
  ""|*/.claude/*|*/__tests__/*|*/e2e/*|*/tests/*)
    exit 0
    ;;
  *.test.*|*.spec.*)
    exit 0
    ;;
esac

# Match UI source patterns
case "$FILE_PATH" in
  */components/*.tsx|*/components/*/*.tsx|*/components/*/*/*.tsx|*/components/*/*/*/*.tsx|\
  */components/*.jsx|*/components/*/*.jsx|*/components/*/*/*.jsx|\
  */app/*/page.tsx|*/app/*/*/page.tsx|*/app/*/*/*/page.tsx|*/app/*/*/*/*/page.tsx|\
  */app/*/layout.tsx|*/app/*/*/layout.tsx|*/app/*/*/*/layout.tsx|\
  */app/*/loading.tsx|*/app/*/*/loading.tsx|\
  */app/*/error.tsx|*/app/*/*/error.tsx|\
  */lib/email/*-templates.tsx|*/lib/email/*-templates.jsx)
    ;;
  *)
    exit 0
    ;;
esac

# Emit a one-time-per-session reminder via session-marker dedup.
SESSION_ID="${CLAUDE_SESSION_ID:-default}"
MARKER="${TMPDIR:-/tmp}/dev-tasks-ui-change-reminder-${SESSION_ID}"
if [ -f "$MARKER" ]; then
  exit 0
fi
touch "$MARKER"

cat >&2 <<EOF

  📐 UI EDIT DETECTED — testing discipline reminder (one-time per session)

  When this work is done, /self-review will check:
    • Check #2 (visual): you ran /dev-tasks:visual-diff with before/after
    • Check #6 (UI): no variable-names-as-labels; themed wrappers used
    • Check #8 (tests): E2E test exists in e2e/ for changed user flows

  Cheaper to write the E2E + visual diff alongside the implementation than
  to discover the gap at review time. See .claude/rules/testing.md and
  .claude/skills/visual-diff/SKILL.md.

  This reminder fires once per session — won't repeat on further UI edits.

EOF

exit 0
