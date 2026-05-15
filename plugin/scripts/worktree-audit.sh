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
# Requires: git, gh CLI authenticated, jq.

set -u
shopt -s nullglob

MODE="report"
ASSUME_YES="no"
for arg in "$@"; do
  case "$arg" in
    --remove) MODE="remove" ;;
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
MAIN_CHECKOUT="$(cd "$GIT_COMMON_DIR/.." && pwd)"

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
  else
    cls="ABANDONED"
    reason="$merge_status, no Monday task, last commit $last_age"
    ABANDONED_TREES+=("$rel_path|$branch|$head|$reason")
  fi

  printf '  %-50s  %-10s  %s\n' "$rel_path" "$cls" "$reason"
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

# --remove mode: prompt + delete DONE worktrees.
if [ "${#DONE_TREES[@]}" -eq 0 ]; then
  echo "No DONE worktrees to remove."
  exit 0
fi

removed=0 skipped=0
for entry in "${DONE_TREES[@]}"; do
  IFS='|' read -r rel_path branch head reason <<< "$entry"
  full_path="$MAIN_CHECKOUT/$rel_path"
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

echo
echo "Removal complete: $removed removed, $skipped skipped."
[ "${#INFLIGHT_TREES[@]}" -gt 0 ] && echo "Note: ${#INFLIGHT_TREES[@]} IN-FLIGHT worktrees preserved for manual review."
[ "${#ABANDONED_TREES[@]}" -gt 0 ] && echo "Note: ${#ABANDONED_TREES[@]} ABANDONED worktrees preserved for user decision."
