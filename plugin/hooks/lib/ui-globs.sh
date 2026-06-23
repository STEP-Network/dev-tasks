#!/usr/bin/env bash
# dev-tasks plugin — UI-file glob classifier (single source of truth)
#
# Defines `path_is_ui <path>` — returns 0 (true) when the path is a UI source
# file whose change should trigger visual-diff capture / UI testing discipline,
# 1 (false) otherwise. Extracted from ui-change-test-reminder.sh so the
# PostToolUse nudge, the deterministic /ship-pr classifier (ui-diff-eval.sh),
# and the stop-visual-diff-check Stop gate all agree on what "UI work" means.
#
# Matched UI source patterns:
#   components/**/*.tsx, *.jsx (any depth)
#   app/**/page.tsx | layout.tsx | loading.tsx | error.tsx (.jsx too)
#   lib/email/*-templates.tsx | *.jsx
#   *.css / *.scss (any path — stylesheet changes are visual by definition)
#
# Skipped (never UI for this purpose):
#   *.test.* / *.spec.*   (test files)
#   __tests__/**          (tests editing themselves)
#   e2e/**                (E2E specs)
#   tests/**              (test dirs)
#   .claude/**            (config / plugin infrastructure)
#
# Pure string matching against the path — never opens or executes the file.

path_is_ui() {
  local file_path="$1"

  # Skip non-applicable files first.
  case "$file_path" in
    ""|*/.claude/*|.claude/*|*/__tests__/*|*/e2e/*|e2e/*|*/tests/*|tests/*)
      return 1
      ;;
    *.test.*|*.spec.*)
      return 1
      ;;
  esac

  # Match UI source patterns.
  case "$file_path" in
    */components/*.tsx|*/components/*/*.tsx|*/components/*/*/*.tsx|*/components/*/*/*/*.tsx|\
    components/*.tsx|components/*/*.tsx|components/*/*/*.tsx|\
    */components/*.jsx|*/components/*/*.jsx|*/components/*/*/*.jsx|\
    components/*.jsx|components/*/*.jsx|components/*/*/*.jsx|\
    */app/*/page.tsx|*/app/*/*/page.tsx|*/app/*/*/*/page.tsx|*/app/*/*/*/*/page.tsx|\
    app/*/page.tsx|app/*/*/page.tsx|app/*/*/*/page.tsx|app/*/*/*/*/page.tsx|\
    */app/*/layout.tsx|*/app/*/*/layout.tsx|*/app/*/*/*/layout.tsx|\
    app/*/layout.tsx|app/*/*/layout.tsx|app/*/*/*/layout.tsx|\
    */app/*/loading.tsx|*/app/*/*/loading.tsx|app/*/loading.tsx|app/*/*/loading.tsx|\
    */app/*/error.tsx|*/app/*/*/error.tsx|app/*/error.tsx|app/*/*/error.tsx|\
    */lib/email/*-templates.tsx|*/lib/email/*-templates.jsx|\
    lib/email/*-templates.tsx|lib/email/*-templates.jsx|\
    *.css|*.scss)
      return 0
      ;;
  esac

  return 1
}
