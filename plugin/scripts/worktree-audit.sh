#!/usr/bin/env bash
# .claude/scripts/worktree-audit.sh
#
# Classifies every entry in `git worktree list` as DONE / IN-FLIGHT / ABANDONED
# and (with --remove) removes the DONE ones. Default mode is report-only.
#
# Usage:
#   bash .claude/scripts/worktree-audit.sh              # report only (safe)
#   bash .claude/scripts/worktree-audit.sh --remove     # report + remove DONE worktrees
#   bash .claude/scripts/worktree-audit.sh --remove -y  # skip per-tree confirmation
#   bash .claude/scripts/worktree-audit.sh --auto       # non-interactive GC: remove DONE +
#                                                       # ABANDONED, unlock stale git locks
#
# Classification rules (mirrors .claude/rules/worktree-discipline.md):
#
#   DONE       branch merged (direct OR via PR squash-merge) AND working tree clean
#   IN-FLIGHT  working tree dirty, OR branch unmerged but has an .claude/active-task.json
#              (i.e. claimed but not shipped — needs manual verification)
#   ABANDONED  unmerged AND no active-task.json AND last commit > 30 days old
#
# The main checkout and the currently-active worktree are always skipped.
#
# Stale-lock handling (--auto only):
#   git stores per-worktree locks at .git/worktrees/<name>/locked. A crashed session
#   can leave one behind. --auto removes any locked file whose mtime is > 24h old —
#   conservative floor; no legitimate session holds a lock that long.
#
# Requires: git, gh CLI authenticated, jq.

set -u
shopt -s nullglob

MODE="report"
ASSUME_YES="no"
for arg in "$@"; do
  case "$arg" in
    --remove) MODE="remove" ;;
    --auto)   MODE="auto"; ASSUME_YES="yes" ;;
    -y|--yes) ASSUME_YES="yes" ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# Resolve the MAIN CHECKOUT root (not the worktree's root, which is what
# $SCRIPT_DIR/../.. would give). The main checkout is the parent of the
# git-common-dir (which is the shared .git directory across all worktrees).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_COMMON_DIR=$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --git-common-dir 2>/dev/null)
if [ -z "$GIT_COMMON_DIR" ]; then
  echo "ERROR: not in a git repository" >&2
  exit 1
fi
# git-common-dir is the .git directory (absolute path under main checkout).
# Use pwd -P to canonicalize symlinks; git worktree list returns canonical paths,
# so the equality check below must compare canonical-vs-canonical.
MAIN_CHECKOUT="$(cd "$GIT_COMMON_DIR/.." && pwd -P)"

# The currently active worktree (the one this script runs in) is the path
# whose .git points at a worktree dir, not the common dir.
ACTIVE_WORKTREE=""
if [ "$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --git-common-dir 2>/dev/null)" != "$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --git-dir 2>/dev/null)" ]; then
  ACTIVE_WORKTREE="$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --show-toplevel)"
fi

WORKTREES=$(git -C "$MAIN_CHECKOUT" worktree list --porcelain)

DONE_TREES=()
INFLIGHT_TREES=()
ABANDONED_TREES=()
SKIPPED_TREES=()

classify_worktree() {
  local path="$1" branch="$2" head="$3"
  local rel_path="${path/#$MAIN_CHECKOUT\//}"
  [ "$path" = "$MAIN_CHECKOUT" ] && rel_path="(main checkout)"

  # Skip the main checkout and the active worktree.
  if [ "$path" = "$MAIN_CHECKOUT" ]; then
    SKIPPED_TREES+=("$rel_path|main checkout|—")
    printf '  %-50s  %-10s  %s\n' "$rel_path" "SKIP" "main checkout"
    return
  fi
  if [ "$path" = "$ACTIVE_WORKTREE" ]; then
    SKIPPED_TREES+=("$rel_path|active session|$branch")
    printf '  %-50s  %-10s  %s\n' "$rel_path" "SKIP" "active session"
    return
  fi

  local dirty
  dirty=$(git -C "$path" status --porcelain 2>/dev/null | head -1)

  local last_age
  last_age=$(git -C "$path" log -1 --format='%cr' 2>/dev/null || echo "unknown")

  # Commit age in whole days — used by the ABANDONED safety floor below.
  # Without this, a fresh unmerged worktree (no active-task.json) would be
  # misclassified ABANDONED and force-deleted by --auto. The 30-day floor
  # matches the docstring contract.
  local last_commit_ts last_commit_days=0
  last_commit_ts=$(git -C "$path" log -1 --format='%ct' 2>/dev/null || echo 0)
  if [ "$last_commit_ts" -gt 0 ]; then
    last_commit_days=$(( ( $(date +%s) - last_commit_ts ) / 86400 ))
  fi

  local task_id="" task_name=""
  if [ -f "$path/.claude/active-task.json" ]; then
    task_id=$(jq -r '.taskId // empty' "$path/.claude/active-task.json" 2>/dev/null)
    task_name=$(jq -r '.taskName // empty' "$path/.claude/active-task.json" 2>/dev/null)
  fi

  # Merge detection — direct ancestor OR squash-merged PR.
  local merge_status="unmerged" merge_pr=""
  if git -C "$MAIN_CHECKOUT" merge-base --is-ancestor "$head" origin/staging 2>/dev/null; then
    merge_status="merged-direct"
  elif git -C "$MAIN_CHECKOUT" merge-base --is-ancestor "$head" origin/main 2>/dev/null; then
    merge_status="merged-to-main"
  else
    merge_pr=$(gh pr list --state merged --head "$branch" --json number,mergedAt --limit 1 --jq '.[0].number // empty' 2>/dev/null)
    if [ -n "$merge_pr" ]; then
      merge_status="merged-via-PR-#${merge_pr}-squash"
    fi
  fi

  local cls reason
  if [[ "$merge_status" == merged-* ]] && [ -z "$dirty" ]; then
    cls="DONE"
    reason="$merge_status, clean tree"
    DONE_TREES+=("$rel_path|$branch|$head|$reason")
  elif [ -n "$dirty" ]; then
    cls="IN-FLIGHT"
    local extras
    extras=$(git -C "$path" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    reason="$merge_status, working tree dirty ($extras files)"
    INFLIGHT_TREES+=("$rel_path|$branch|$task_id|$task_name|dirty ($extras files), $merge_status")
  elif [ -n "$task_id" ]; then
    cls="IN-FLIGHT"
    reason="unmerged, has Monday task #$task_id (verify status manually)"
    INFLIGHT_TREES+=("$rel_path|$branch|$task_id|$task_name|$merge_status")
  elif [ "$last_commit_days" -lt 30 ]; then
    # Fresh unmerged worktree without active-task.json — could be exploratory.
    # Preserve until it ages past the 30-day floor.
    cls="IN-FLIGHT"
    reason="$merge_status, no task, last commit ${last_commit_days}d ago (under 30d floor, preserved)"
    INFLIGHT_TREES+=("$rel_path|$branch|||$reason")
  else
    cls="ABANDONED"
    reason="$merge_status, no Monday task, last commit $last_age (${last_commit_days}d)"
    ABANDONED_TREES+=("$rel_path|$branch|$head|$reason")
  fi

  printf '  %-50s  %-10s  %s\n' "$rel_path" "$cls" "$reason"
}

# clean_stale_locks — remove .git/worktrees/<name>/locked files older than 24h.
# Conservative floor: no legitimate session holds a lock that long. Prints one line
# per unlocked worktree to stdout. Returns the count via the global STALE_LOCKS_CLEANED.
STALE_LOCKS_CLEANED=0
clean_stale_locks() {
  local lock_root="$MAIN_CHECKOUT/.git/worktrees"
  [ -d "$lock_root" ] || return 0
  local now_ts
  now_ts=$(date +%s)
  for lock_file in "$lock_root"/*/locked; do
    [ -f "$lock_file" ] || continue
    local mtime
    # macOS uses `stat -f %m`; Linux uses `stat -c %Y`. Fall back to 0 (skip).
    mtime=$(stat -f %m "$lock_file" 2>/dev/null || stat -c %Y "$lock_file" 2>/dev/null || echo 0)
    [ "$mtime" -eq 0 ] && continue
    local age_hours=$(( (now_ts - mtime) / 3600 ))
    if [ "$age_hours" -gt 24 ]; then
      local worktree_name
      worktree_name=$(basename "$(dirname "$lock_file")")
      rm -f "$lock_file"
      echo "  unlocked stale: $worktree_name (lock age ${age_hours}h)"
      STALE_LOCKS_CLEANED=$((STALE_LOCKS_CLEANED + 1))
    fi
  done
}

echo "Worktree audit ($MODE mode)"
echo "================================================================="
echo "  Main checkout: $MAIN_CHECKOUT"
echo "  Active worktree (this session, never removed): ${ACTIVE_WORKTREE:-<none>}"
echo
printf '  %-50s  %-10s  %s\n' "PATH" "STATUS" "REASON"
printf '  %-50s  %-10s  %s\n' "----" "------" "------"

current_path="" current_branch="" current_head=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*) current_path="${line#worktree }" ;;
    "HEAD "*)    current_head="${line#HEAD }" ;;
    "branch "*)  current_branch="${line#branch refs/heads/}" ;;
    "")
      if [ -n "$current_path" ]; then
        classify_worktree "$current_path" "$current_branch" "$current_head"
      fi
      current_path="" current_branch="" current_head=""
      ;;
  esac
done <<< "$WORKTREES"
if [ -n "$current_path" ]; then
  classify_worktree "$current_path" "$current_branch" "$current_head"
fi

echo
echo "Summary:"
echo "  DONE       ${#DONE_TREES[@]}"
echo "  IN-FLIGHT  ${#INFLIGHT_TREES[@]}"
echo "  ABANDONED  ${#ABANDONED_TREES[@]}"
echo "  SKIPPED    ${#SKIPPED_TREES[@]}  (main checkout + active session)"
echo

if [ "$MODE" = "report" ]; then
  [ "${#DONE_TREES[@]}" -gt 0 ] && echo "Run with --remove to delete the ${#DONE_TREES[@]} DONE worktree(s)."
  if [ "${#INFLIGHT_TREES[@]}" -gt 0 ]; then
    echo
    echo "IN-FLIGHT worktrees (preserve — verify manually):"
    for entry in "${INFLIGHT_TREES[@]}"; do
      IFS='|' read -r path branch task_id task_name notes <<< "$entry"
      echo "  - $path [$branch]"
      [ -n "$task_id" ] && echo "      Monday task: #$task_id '$task_name'"
      echo "      $notes"
    done
  fi
  if [ "${#ABANDONED_TREES[@]}" -gt 0 ]; then
    echo
    echo "ABANDONED worktrees (flag for user decision):"
    for entry in "${ABANDONED_TREES[@]}"; do
      IFS='|' read -r path branch head reason <<< "$entry"
      echo "  - $path [$branch] @ ${head:0:8} — $reason"
    done
  fi
  exit 0
fi

# Cleanup mode (--remove or --auto).
# --remove: DONE only, interactive prompt unless -y.
# --auto:   DONE + ABANDONED + stale locks, non-interactive. Used by the SessionStart janitor hook.
removed=0 skipped=0

# DONE removal (both modes). Guard the for-loop — `set -u` rejects empty array expansion.
if [ "${#DONE_TREES[@]}" -gt 0 ]; then
  for entry in "${DONE_TREES[@]}"; do
    IFS='|' read -r rel_path branch head reason <<< "$entry"
    full_path="$MAIN_CHECKOUT/$rel_path"
    # Defense-in-depth: refuse to operate on paths outside the checkout.
    if [[ "$full_path" != "$MAIN_CHECKOUT/"* ]]; then
      echo "  REFUSED $rel_path (outside main checkout — possible path-traversal)"
      continue
    fi
    if [ "$ASSUME_YES" != "yes" ]; then
      read -p "Remove $rel_path [$branch]? (y/N/a) " yn
      case "$yn" in
        a|A) ASSUME_YES="yes" ;;
        y|Y) ;;
        *)   echo "  skipped"; skipped=$((skipped + 1)); continue ;;
      esac
    fi
    if git -C "$MAIN_CHECKOUT" worktree remove "$full_path" 2>/dev/null; then
      echo "  removed $rel_path"
      removed=$((removed + 1))
    else
      echo "  FAILED to remove $rel_path (try: git worktree remove --force $rel_path)"
    fi
  done
fi

# Auto mode also reclaims ABANDONED and clears stale git locks.
abandoned_removed=0
if [ "$MODE" = "auto" ]; then
  if [ "${#ABANDONED_TREES[@]}" -gt 0 ]; then
    for entry in "${ABANDONED_TREES[@]}"; do
      IFS='|' read -r rel_path branch head reason <<< "$entry"
      full_path="$MAIN_CHECKOUT/$rel_path"
      if [[ "$full_path" != "$MAIN_CHECKOUT/"* ]]; then
        echo "  REFUSED abandoned $rel_path (outside main checkout — possible path-traversal)"
        continue
      fi
      if git -C "$MAIN_CHECKOUT" worktree remove "$full_path" 2>/dev/null; then
        echo "  removed abandoned $rel_path"
        abandoned_removed=$((abandoned_removed + 1))
      elif git -C "$MAIN_CHECKOUT" worktree remove --force "$full_path" 2>/dev/null; then
        echo "  removed abandoned $rel_path (--force)"
        abandoned_removed=$((abandoned_removed + 1))
      else
        echo "  FAILED to remove abandoned $rel_path"
      fi
    done
  fi
  clean_stale_locks
  # Prune git's internal worktree admin data for anything removed off-disk.
  git -C "$MAIN_CHECKOUT" worktree prune 2>/dev/null || true
fi

echo
if [ "$MODE" = "auto" ]; then
  echo "Auto-prune complete: $removed DONE removed, $abandoned_removed ABANDONED removed, $STALE_LOCKS_CLEANED stale lock(s) cleared."
else
  echo "Removal complete: $removed removed, $skipped skipped."
fi
[ "${#INFLIGHT_TREES[@]}" -gt 0 ] && echo "Note: ${#INFLIGHT_TREES[@]} IN-FLIGHT worktrees preserved for manual review."
if [ "$MODE" != "auto" ] && [ "${#ABANDONED_TREES[@]}" -gt 0 ]; then
  echo "Note: ${#ABANDONED_TREES[@]} ABANDONED worktrees preserved for user decision (use --auto to reclaim)."
fi
