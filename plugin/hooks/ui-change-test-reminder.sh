#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "ui-change-test-reminder" in hooks.enabled[].
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/ui-globs.sh"
hook_enabled "ui-change-test-reminder" || exit 0

# Hook: PostToolUse (Edit|Write|MultiEdit) — non-blocking nudge.
# Fires when an agent edits a UI source file. Surfaces a reminder that the
# change needs an E2E test + visual-diff before /self-review will mark Check
# #8 / Check #2 PASS. Always exits 0 — never blocks edits.
#
# UI classification (which paths trigger / which are skipped) lives in
# hooks/lib/ui-globs.sh `path_is_ui` — the single source of truth shared with
# scripts/ui-diff-eval.sh and hooks/stop-visual-diff-check.sh.

INPUT=$(cat)
FILE_PATH=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))" 2>/dev/null)

# Classify via the shared UI-glob library (single source of truth shared with
# ui-diff-eval.sh and stop-visual-diff-check.sh). Non-UI files → no reminder.
path_is_ui "$FILE_PATH" || exit 0

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

  And /ship-pr Phase 6.8 (VisualDiff) will capture before/after screenshots of
  the changed routes on staging into the Monday "Visual Changes" doc
  (doc_mm4jkk92) — so a reviewer sees the visual delta on the task itself.
  That capture is deterministic now (ui-diff-eval.sh), and if
  stop-visual-diff-check is enabled it BLOCKS session exit on a UI diff with no
  visualDiff.routes / visualDiff.skipReason recorded. Don't plan to self-skip
  it ("no local build" is not a valid skip — staging is screenshot-reachable).

  Cheaper to write the E2E + visual diff alongside the implementation than
  to discover the gap at review time. See .claude/rules/testing.md and
  .claude/skills/visual-diff/SKILL.md.

  This reminder fires once per session — won't repeat on further UI edits.

EOF

exit 0
