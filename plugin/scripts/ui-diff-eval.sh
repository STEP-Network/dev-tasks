#!/bin/bash

# ui-diff-eval.sh [--base <ref>]
#
# Deterministic "is this UI work?" classifier for the committed branch diff.
# Replaces the per-agent LLM self-classification that gated /ship-pr's
# VisualDiff capture (Phase 6.8) — "touches components/**, app routes, *.css,
# email templates, OR has a UX-UI subtask" was a judgment call with no code
# behind it, so an agent could (and did) silently decide "not UI" and skip.
#
# Evaluates the COMMITTED diff (merge-base of <base>...HEAD) and runs every
# changed path through path_is_ui (hooks/lib/ui-globs.sh — the same globs the
# ui-change-test-reminder nudge and the stop-visual-diff-check gate use).
#
# Output contract (stdout, first line is the verdict):
#   UI                            → exit 0   (≥1 changed path is a UI source file)
#   NON_UI                        → exit 1   (no UI source files changed)
#   NON_UI: <reason>              → exit 1   (could not evaluate — treated as non-UI)
# Detail lines (matched UI files, base ref) follow the verdict.
#
# --force-ui: additive override for UX-UI work. When passed, the script still
# runs every changed path through path_is_ui (the matched-files list is kept for
# info) but emits the UI verdict + exit 0 even when no path matched. This is how
# /ship-pr enforces "a UX-UI subtask forces UI even if the path classifier says
# otherwise" (e.g. an i18n-only diff under messages/*.json). Path-based
# classification stays the default; this only ever turns a NON_UI verdict into UI.
#
# ONE exception, and it is the point of the override (#3173683437): an EMPTY diff
# is NON_UI even under --force-ui. The override exists to force a UI verdict for a
# NON-EMPTY diff the path classifier would call NON_UI. It must not manufacture a
# UI verdict where nothing changed at all -- a freshly claimed UX-UI task carries
# the override from the moment /pickup-task records its subtask types, so without
# this a session that has written no code is asked to capture a before-pass of a
# branch byte-identical to base.
#
# Renames are evaluated with --no-renames (full add+delete) so a moved
# component still classifies as UI. Mirrors ci-skip-eval.sh's diff handling.

set -u

BASE_OVERRIDE=""
FORCE_UI=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_OVERRIDE="${2:-}"; shift 2 ;;
    --force-ui) FORCE_UI=1; shift ;;
    *) echo "NON_UI: unknown argument '$1' (usage: ui-diff-eval.sh [--base <ref>] [--force-ui])"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../hooks/lib/ui-globs.sh
source "$SCRIPT_DIR/../hooks/lib/ui-globs.sh"

ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$ROOT" ]; then
  echo "NON_UI: not inside a git repository"
  exit 1
fi

# Resolve the base ref: explicit override > project-config git.defaultBase > main.
BASE="$BASE_OVERRIDE"
if [ -z "$BASE" ]; then
  CONFIG="$ROOT/.claude/project-config.json"
  if [ -f "$CONFIG" ]; then
    BASE=$(jq -r '.git.defaultBase // empty' "$CONFIG" 2>/dev/null)
  fi
fi
[ -z "$BASE" ] && BASE="main"

# $BASE is interpolated into git commands, and it comes from a file in the repo
# (.claude/project-config.json) or the caller's --base. A value beginning with a
# dash would be read by git as an OPTION rather than a ref, so constrain it to a
# branch-name charset and fall back to "main" rather than letting it reach git.
# Mirrors the sanitization in hooks/stop-task-check.sh.
if ! printf '%s' "$BASE" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._/-]*$'; then
  BASE="main"
fi

# Prefer the remote-tracking ref so a stale local base branch can't shrink the diff.
if git rev-parse --verify --quiet "origin/$BASE" >/dev/null 2>&1; then
  DIFF_BASE="origin/$BASE"
else
  DIFF_BASE="$BASE"
fi

DIFF=$(git diff --numstat --no-renames "$DIFF_BASE...HEAD" -- 2>/dev/null)
if [ $? -ne 0 ]; then
  echo "NON_UI: git diff against $DIFF_BASE failed"
  exit 1
fi

# Empty diff -> nothing changed, so there is nothing to capture. Checked BEFORE
# the path classifier and BEFORE --force-ui: see the --force-ui note above.
if [ -z "$(printf '%s' "$DIFF" | tr -d '[:space:]')" ]; then
  echo "NON_UI: empty diff"
  echo "  base: $DIFF_BASE"
  echo "  branch is byte-identical to base - nothing to capture"
  exit 1
fi

UI_FILES=()
while IFS=$'\t' read -r _added _deleted path; do
  [ -z "${path:-}" ] && continue
  if path_is_ui "$path"; then
    UI_FILES+=("$path")
  fi
done <<< "$DIFF"

if [ "${#UI_FILES[@]}" -eq 0 ]; then
  if [ "$FORCE_UI" -eq 1 ]; then
    # UX-UI subtask override: no path matched, but UI is forced.
    echo "UI"
    echo "  base: $DIFF_BASE"
    echo "  forced: UX-UI subtask override (no path-matched UI files)"
    exit 0
  fi
  echo "NON_UI"
  echo "  base: $DIFF_BASE"
  echo "  no UI source files changed"
  exit 1
fi

echo "UI"
echo "  base: $DIFF_BASE"
[ "$FORCE_UI" -eq 1 ] && echo "  forced: UX-UI subtask override"
echo "  ui files: ${#UI_FILES[@]}"
for f in "${UI_FILES[@]}"; do
  echo "  - $f"
done
exit 0
