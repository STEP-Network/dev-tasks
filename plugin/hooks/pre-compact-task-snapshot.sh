#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "pre-compact-task-snapshot" in hooks.enabled[]. Keeps the plugin's hooks dormant in
# projects that don't follow this workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "pre-compact-task-snapshot" || exit 0
# Hook: PreCompact — snapshot task + orchestration state before context compaction.
#
# Closes part of GH issue #96 (the snapshot half).
#
# Why: long sessions hit compaction. The post-compact agent may lose track of
# the active task / batch plan (referenced in messages that get summarized
# away). Snapshotting the state files just before compaction gives the agent
# a recovery path: if the post-compact view doesn't reference state correctly,
# it can re-Read the .snapshot.json (or the live file — they should be
# identical at compact-time).
#
# Two layers are snapshotted (each independently, only when the live file
# exists):
#
#   1. .claude/active-task.json → .claude/active-task.snapshot.json
#      Per-task pipeline state (one task at a time).
#
#   2. .claude/orchestration-state.json → .claude/orchestration-state.snapshot.json
#      Cross-task batch plan (e.g. "ship every Sprint 10 task"). Without this,
#      a long-horizon autonomous batch loses its place across compaction.
#
# Non-blocking: this hook MUST never block compaction. Exit 0 on every error.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

snapshot_atomic() {
  local src="$1"
  local dest="$2"
  if [ ! -f "$src" ]; then
    return 0
  fi
  # Atomic copy via mv-from-tmp pattern. mv on the same filesystem is atomic on
  # POSIX, so the snapshot is either the previous version OR the new version,
  # never half-written.
  local tmp="$dest.tmp.$$"
  cp "$src" "$tmp" 2>/dev/null && mv "$tmp" "$dest" 2>/dev/null
}

snapshot_atomic "$PROJECT_ROOT/.claude/active-task.json"           "$PROJECT_ROOT/.claude/active-task.snapshot.json"
snapshot_atomic "$PROJECT_ROOT/.claude/orchestration-state.json"   "$PROJECT_ROOT/.claude/orchestration-state.snapshot.json"

# Best-effort. Silent on success — compaction's user-facing output should not
# be cluttered by hook noise. Errors are also silent (exit 0) so a snapshot
# failure never blocks the user's context-clearing.
exit 0
