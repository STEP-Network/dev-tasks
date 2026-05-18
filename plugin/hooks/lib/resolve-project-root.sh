#!/usr/bin/env bash
# dev-tasks plugin — worktree-aware project-root resolver
#
# Hooks that read or write `.claude/active-task.json` must address the
# CORRECT checkout. Source this file and call `resolve_project_root` to get
# the right one.
#
# Why this exists
# ---------------
# `CLAUDE_PROJECT_DIR` is set once at session start to wherever Claude Code
# was launched. When the agent enters a `git worktree` (via /pickup-task's
# `EnterWorktree` call), CLAUDE_PROJECT_DIR is NOT updated — it still points
# at the main checkout. Hooks that read `$CLAUDE_PROJECT_DIR/.claude/active-task.json`
# silently look at the wrong file, causing:
#   - branch-task-match: reads main checkout's claimed branch, ignoring
#     worktree-local state (retro #2922302538)
#   - worktree-required / stop-task-check / task-state-guard: same gap, but
#     also for the writes that mutate state (retro #2922252904 + #2922256731)
#   - pickup-task: writes active-task.json to BOTH locations, orchestrator's
#     stop-hook in the main checkout misfires
#
# Resolution order
# ----------------
# 1. If a file_path is provided (PreToolUse Edit/Write contexts), use it as
#    the basis for git plumbing. `git -C <file_dir> rev-parse --show-toplevel`
#    returns the worktree root that owns that file — correct regardless of
#    what CLAUDE_PROJECT_DIR points to.
# 2. Otherwise, `git rev-parse --show-toplevel` from the hook's CWD. Most
#    hook contexts run with CWD inside the relevant checkout.
# 3. Fall back to CLAUDE_PROJECT_DIR (Claude Code's hint).
# 4. Last resort: $PWD.

resolve_project_root() {
  local file_path="${1:-}"

  # 1. file_path-based detection — most reliable in PreToolUse Edit/Write.
  if [ -n "$file_path" ]; then
    local file_dir
    file_dir=$(dirname -- "$file_path" 2>/dev/null)
    if [ -n "$file_dir" ] && [ -d "$file_dir" ]; then
      local toplevel
      toplevel=$(git -C "$file_dir" rev-parse --show-toplevel 2>/dev/null)
      if [ -n "$toplevel" ]; then
        printf '%s' "$toplevel"
        return 0
      fi
    fi
  fi

  # 2. CWD-based git plumbing — works for Stop hooks and most others.
  local toplevel
  toplevel=$(git rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$toplevel" ]; then
    printf '%s' "$toplevel"
    return 0
  fi

  # 3. CLAUDE_PROJECT_DIR fallback — not worktree-aware but better than nothing.
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    printf '%s' "$CLAUDE_PROJECT_DIR"
    return 0
  fi

  # 4. Last resort.
  printf '%s' "$PWD"
}

# Helper to extract the file_path field from a tool-use stdin payload.
# Returns empty string if not present.
extract_tool_file_path() {
  local input="$1"
  printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null || true
}
