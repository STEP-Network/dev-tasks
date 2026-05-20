#!/usr/bin/env bash
# SessionStart hook — silently runs worktree-audit.sh in auto mode and reports a
# one-line summary only if anything was cleaned. Fails safe: never blocks session start.
#
# Cleans:
#   - DONE worktrees (merged + clean)
#   - ABANDONED worktrees (unmerged, no active-task, last commit > 30 days)
#   - Stale .git/worktrees/<name>/locked files (mtime > 24h)
#
# Preserves:
#   - main checkout
#   - the current session's worktree
#   - IN-FLIGHT worktrees (dirty OR has active-task.json)
set -u

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$PLUGIN_ROOT" ]; then
  PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
AUDIT_SCRIPT="$PLUGIN_ROOT/scripts/worktree-audit.sh"

# Fail-safe: missing script never blocks session start.
if [ ! -f "$AUDIT_SCRIPT" ]; then
  exit 0
fi

# Only useful inside a git repo. Outside one, silently exit.
if ! git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --git-common-dir >/dev/null 2>&1; then
  exit 0
fi

# Run audit in auto mode. Suppress all stderr (best-effort GC).
output=$(bash "$AUDIT_SCRIPT" --auto 2>/dev/null || true)

# Parse the trailing summary line. Format set by worktree-audit.sh --auto:
#   "Auto-prune complete: N DONE removed, M ABANDONED removed, L stale lock(s) cleared."
summary=$(echo "$output" | grep -E '^Auto-prune complete:' | tail -1)
if [ -z "$summary" ]; then
  exit 0
fi

# Extract counts. Silent on zero across the board.
done_n=$(echo "$summary" | grep -oE '[0-9]+ DONE' | grep -oE '^[0-9]+' || echo 0)
abandoned_n=$(echo "$summary" | grep -oE '[0-9]+ ABANDONED' | grep -oE '^[0-9]+' || echo 0)
lock_n=$(echo "$summary" | grep -oE '[0-9]+ stale lock' | grep -oE '^[0-9]+' || echo 0)
total=$(( done_n + abandoned_n + lock_n ))

if [ "$total" -gt 0 ]; then
  echo "[worktree-janitor] cleaned $done_n DONE + $abandoned_n abandoned worktree(s), $lock_n stale lock(s)"
fi

exit 0
