#!/usr/bin/env bash
# plugin/scripts/post-merge-cleanup.sh
#
# Orchestrator wrapper: batches the mechanical post-merge steps for a single
# merged PR. Steps 1 (createUpdate) and 5 (verify demoUrl) are interactive —
# they need the human/orchestrator to choose update wording — so this script
# stops at the worktree-removal step and prints a checklist of what's left.
#
# Usage (from the consumer project root, or with $CLAUDE_PROJECT_DIR set):
#   bash ${CLAUDE_PLUGIN_ROOT}/scripts/post-merge-cleanup.sh <PR-number>
#
# Steps executed:
#   2. Locate worktree via Monday Branch column convention (branch with slashes
#      replaced by dashes → .claude/worktrees/<slug>).
#   3. git worktree remove --force <path>
#   4. Emit a SendMessage shutdown-request reminder (manual — the orchestrator
#      issues it after this script returns).
#
# Steps NOT executed (left to the orchestrator's normal Monday updates flow):
#   1. createUpdate on Monday with merge SHA + branch deleted (needs body text).
#   5. updateTask(demoUrl=...) if missing (needs the actual preview URL).
#
# Project-root resolution (in priority order):
#   1. $CLAUDE_PROJECT_DIR (set by Claude Code at session start)
#   2. $PWD if it's a git working tree
#   3. Error out — script needs a consumer-project context, not the plugin cache
#
# Exit codes:
#   0  worktree removed (or wasn't there) + checklist printed
#   1  PR-number argument missing/invalid
#   2  task lookup failed
#   3  worktree-remove failed unexpectedly

set -u

if [ $# -lt 1 ]; then
  echo "Usage: $0 <PR-number>" >&2
  echo "       $0 379" >&2
  exit 1
fi

PR_NUMBER="$1"
if ! [[ "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "ERROR: PR number must be numeric, got: $PR_NUMBER" >&2
  exit 1
fi

# Resolve the consumer project root. Prefer $CLAUDE_PROJECT_DIR (set by Claude
# Code at session start) so this script works when invoked via
# ${CLAUDE_PLUGIN_ROOT}/scripts/post-merge-cleanup.sh from inside a Claude
# session. Fall back to $PWD when run standalone from a CLI.
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "$CLAUDE_PROJECT_DIR/.git" -o -f "$CLAUDE_PROJECT_DIR/.git" ]; then
  PROJECT_ROOT="$CLAUDE_PROJECT_DIR"
elif git_top=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null); then
  PROJECT_ROOT="$git_top"
else
  echo "ERROR: cannot resolve consumer project root." >&2
  echo "Set CLAUDE_PROJECT_DIR or run from inside a git working tree." >&2
  exit 2
fi

# Resolve the main checkout (handles worktree-inside-worktree).
GIT_COMMON_DIR=$(git -C "$PROJECT_ROOT" rev-parse --git-common-dir 2>/dev/null)
if [ -z "$GIT_COMMON_DIR" ]; then
  echo "ERROR: $PROJECT_ROOT is not a git repository" >&2
  exit 2
fi
# git-common-dir is typically <project>/.git; the main checkout is its parent.
MAIN_CHECKOUT="$(cd "$GIT_COMMON_DIR/.." 2>/dev/null && pwd -P)"
if [ -z "$MAIN_CHECKOUT" ]; then
  MAIN_CHECKOUT="$PROJECT_ROOT"
fi

# gh CLI required.
if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: gh CLI not found. Install it before running this script." >&2
  exit 2
fi

PR_JSON=$(gh pr view "$PR_NUMBER" --json number,title,body,headRefName,mergedAt,baseRefName 2>/dev/null)
if [ -z "$PR_JSON" ]; then
  echo "ERROR: failed to read PR #$PR_NUMBER via gh" >&2
  exit 2
fi

PR_BRANCH=$(echo "$PR_JSON" | python3 -c "import sys, json; print(json.load(sys.stdin).get('headRefName',''))" 2>/dev/null)
PR_TITLE=$(echo "$PR_JSON" | python3 -c "import sys, json; print(json.load(sys.stdin).get('title',''))" 2>/dev/null)
PR_BODY=$(echo "$PR_JSON" | python3 -c "import sys, json; print(json.load(sys.stdin).get('body',''))" 2>/dev/null)
PR_MERGED_AT=$(echo "$PR_JSON" | python3 -c "import sys, json; print(json.load(sys.stdin).get('mergedAt',''))" 2>/dev/null)

# Try to extract Monday task ID from the PR body. Convention:
#   monday.com/boards/<board>/pulses/<task-id>
TASK_ID=$(echo "$PR_BODY" | grep -oE "monday\.com/boards/[0-9]+/pulses/[0-9]+" | head -1 | grep -oE "[0-9]+$")

# Resolve worktree path from branch name (slashes → dashes convention).
WORKTREE_SLUG="$(echo "$PR_BRANCH" | tr '/' '-')"
WORKTREE_PATH="$MAIN_CHECKOUT/.claude/worktrees/$WORKTREE_SLUG"

echo "─────────────────────────────────────────────────────────"
echo "POST-MERGE CLEANUP — PR #$PR_NUMBER"
echo "─────────────────────────────────────────────────────────"
echo "  Title:       $PR_TITLE"
echo "  Branch:      $PR_BRANCH"
echo "  Merged at:   $PR_MERGED_AT"
echo "  Task ID:     ${TASK_ID:-<not found in PR body>}"
echo "  Worktree:    $WORKTREE_PATH"
echo "─────────────────────────────────────────────────────────"
echo ""

# Step 3: remove the worktree (if it exists).
if [ -d "$WORKTREE_PATH" ]; then
  echo "Step 3: Removing worktree at $WORKTREE_PATH ..."
  if git -C "$MAIN_CHECKOUT" worktree remove --force "$WORKTREE_PATH" 2>&1; then
    echo "  ✓ Worktree removed."
  else
    echo "  ✗ Worktree removal failed." >&2
    echo "    Path: $WORKTREE_PATH" >&2
    echo "    To force-remove: verify the path is under .claude/worktrees/, then \`rm -rf\` that path and \`git -C $MAIN_CHECKOUT worktree prune\`." >&2
    exit 3
  fi
else
  echo "Step 3: Worktree $WORKTREE_PATH not present — skipping (likely already removed)."
fi

# Step 4: SendMessage shutdown reminder. We can't issue SendMessage from a
# shell script (that's a Claude tool call); print the reminder so the
# orchestrator does it.
echo ""
echo "─────────────────────────────────────────────────────────"
echo "STILL TO DO (orchestrator-side, NOT automated by this script):"
echo "─────────────────────────────────────────────────────────"
if [ -n "$TASK_ID" ]; then
  echo "  1. createUpdate(itemId=$TASK_ID, body=<merge SHA + branch deleted note>)"
  echo "  5. Verify task has demoUrl set; if not, updateTask(itemId=$TASK_ID, demoUrl=<preview URL>)"
else
  echo "  1. createUpdate on the parent Monday task with merge SHA"
  echo "  5. Verify task.demoUrl is set"
fi
echo "  2. (If not already done by agent) manageSubtasks → Done with actualHours"
echo "  4. SendMessage(<agent>, shutdown_request) — close out the agent's session"
echo ""
echo "Reference: ${CLAUDE_PLUGIN_ROOT:-<plugin>}/rules/agent-orchestration.md 'Orchestrator post-merge checklist'"
echo "─────────────────────────────────────────────────────────"

exit 0
