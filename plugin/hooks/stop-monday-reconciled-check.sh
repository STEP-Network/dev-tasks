#!/bin/bash
# .claude/hooks/stop-monday-reconciled-check.sh
#
# Hook: Stop (chains AFTER stop-waiting-for-uat-stage.sh).
#
# Refuses session exit if a PR merged during this session lacks a Monday
# reconciliation update on the active task. "Reconciliation" means: an update
# was posted that mentions the merge SHA AND the parent task is at Waiting
# for UAT (or a later downstream state).
#
# Detection: walks git reflog from a session-start marker
# .claude/cache/session-merge-marker (created on first invocation) forward,
# looking for commits authored by `gh pr merge` (i.e. the merged-PR commit on
# the staging/main branch tip).
#
# Escape hatches:
#   - handoff-to-orchestrator: per the agent-never-merges policy, agents push +
#     open PR + handoff; the orchestrator merges centrally and reconciles. Skip.
#   - stuck:* / timeout:*: the agent has intentionally halted because it can't
#     proceed (regression-loop, max-rounds, etc.) — there's no merge SHA to
#     reconcile (the merge didn't happen, that's the point of the halt).
#     Blocking on reconciliation here creates an impossible state.
#     pre-merge-review-gate.py still refuses the merge for any stuck:*/timeout:*
#     value, so this escape only governs the session-stop gate, not the merge.
#
# Pass-through cases:
#   - No active-task.json
#   - No PRs detected as merged this session (reflog has no `gh pr merge` traces
#     since the marker)
#   - reviewAddressed matches: handoff-to-orchestrator | stuck:* | timeout:*

# Redirect stdout to stderr.
exec >&2

# Opt-in gate: silent no-op unless the consumer enabled this hook in their
# .claude/project-config.json hooks.enabled[] array.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-agent-cwd.sh"
hook_enabled "stop-monday-reconciled-check" || exit 0

# Prefer the agent's actual cwd from the Stop-hook payload (Claude Code
# includes it). Falls through to $CLAUDE_PROJECT_DIR (pinned to main checkout
# at session start), then git_top, then $PWD. The agent's cwd is the worktree
# when one is in use — that's where the relevant active-task.json lives.
INPUT=$(cat 2>/dev/null || echo "")
AGENT_CWD=$(resolve_agent_cwd "$INPUT")

PROJECT_ROOT=""
if [ -n "$AGENT_CWD" ] && [ -d "$AGENT_CWD/.claude" ]; then
  PROJECT_ROOT="$AGENT_CWD"
elif [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "$CLAUDE_PROJECT_DIR/.claude" ]; then
  PROJECT_ROOT="$CLAUDE_PROJECT_DIR"
elif git_top=$(git rev-parse --show-toplevel 2>/dev/null); then
  PROJECT_ROOT="$git_top"
else
  PROJECT_ROOT="$PWD"
fi

STATE_FILE="$PROJECT_ROOT/.claude/active-task.json"
[ ! -f "$STATE_FILE" ] && exit 0

# Validate JSON.
if ! STATE_FILE_PATH="$STATE_FILE" python3 -c "import json, os; json.load(open(os.environ['STATE_FILE_PATH']))" 2>/dev/null; then
  exit 0
fi

# Escape hatch: handoff-to-orchestrator, or any stuck:*/timeout:* halt the
# agent has explicitly entered. A round-5 HALT will not have a merge SHA to
# reconcile (the merge didn't happen — that's the point of the halt), so
# blocking on missing reconciliation would create an impossible state. The
# user resumes manually after triaging the unresolved findings.
REVIEW_ADDRESSED=$(jq -r '.reviewAddressed // ""' "$STATE_FILE" 2>/dev/null)
case "$REVIEW_ADDRESSED" in
  handoff-to-orchestrator|stuck:*|timeout:*)
    exit 0
    ;;
esac

# Locate the merge marker. If absent, create + exit silently (this is the
# session-start state; nothing to reconcile yet).
MARKER_DIR="$PROJECT_ROOT/.claude/cache"
mkdir -p "$MARKER_DIR" 2>/dev/null
MARKER="$MARKER_DIR/session-merge-marker"

if [ ! -f "$MARKER" ]; then
  # First Stop invocation of this session — record the HEAD SHA and exit.
  cd "$PROJECT_ROOT" 2>/dev/null && git rev-parse HEAD > "$MARKER" 2>/dev/null
  exit 0
fi

SESSION_START_SHA=$(cat "$MARKER" 2>/dev/null)

# Detect merges via git reflog. Look for `merge` operations on staging/main
# between SESSION_START_SHA and HEAD.
MERGED_PRS=$(cd "$PROJECT_ROOT" && git log --merges --format='%H %s' "$SESSION_START_SHA..HEAD" 2>/dev/null | head -10)

if [ -z "$MERGED_PRS" ]; then
  # No merges since session start — nothing to reconcile.
  exit 0
fi

# Found merges. For each, check the Monday updates feed for a mention.
TASK_ID=$(jq -r '.taskId // ""' "$STATE_FILE" 2>/dev/null)
TASK_NAME=$(jq -r '.taskName // "(unnamed)"' "$STATE_FILE" 2>/dev/null)
PARENT_STATUS=$(jq -r '.parentStatus // ""' "$STATE_FILE" 2>/dev/null)
PARENT_STATUS_LC=$(echo "$PARENT_STATUS" | tr '[:upper:]' '[:lower:]')

# If parent is already at Waiting for UAT (or beyond), reconciliation is
# implicitly done — pass-through.
case "$PARENT_STATUS_LC" in
  "waiting for uat"|"pending deploy to prod"|"done")
    exit 0
    ;;
esac

# Check if updates exist mentioning a merge SHA. Without a Monday token we
# can't query, so fall back to a local check: did the agent record a merge
# acknowledgement in active-task.json? The mondayReconciledShas list is the
# explicit record.
RECORDED_SHAS=$(jq -r '.mondayReconciledShas // [] | join(",")' "$STATE_FILE" 2>/dev/null)

UNRECONCILED=""
while IFS= read -r line; do
  SHA=$(echo "$line" | awk '{print $1}')
  [ -z "$SHA" ] && continue
  if ! echo "$RECORDED_SHAS" | grep -q "$SHA"; then
    UNRECONCILED="$UNRECONCILED $SHA"
  fi
done <<< "$MERGED_PRS"

if [ -z "$UNRECONCILED" ]; then
  exit 0
fi

# Build the block message.
FIRST_SHA=$(echo "$UNRECONCILED" | awk '{print $1}')
SHORT_SHA="${FIRST_SHA:0:8}"

echo "BLOCKED: PR merge $SHORT_SHA has no Monday reconciliation on task #$TASK_ID '$TASK_NAME'."
echo ""
echo "A merge commit landed during this session but the active task has not been"
echo "reconciled on Monday (parent status: '$PARENT_STATUS' — expected 'Waiting for UAT')."
echo ""
echo "To unblock, do ONE of:"
echo "  1. createUpdate(itemId=$TASK_ID, body=...) mentioning the merge SHA ($SHORT_SHA),"
echo "     then updateTask(itemId=$TASK_ID, status='Waiting for UAT', demoUrl=...),"
echo "     then add the SHA to .claude/active-task.json mondayReconciledShas array."
echo ""
echo "  2. (Agent-side) Set 'reviewAddressed': 'handoff-to-orchestrator' in"
echo "     .claude/active-task.json. The orchestrator's /babysit-prs Phase 4"
echo "     owns the post-merge reconciliation in that case."
echo ""
echo "Reference: .claude/rules/agent-coordination.md Orchestrator post-merge checklist."
exit 2
