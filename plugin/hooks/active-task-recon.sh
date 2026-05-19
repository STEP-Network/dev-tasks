#!/usr/bin/env bash
# SessionStart hook: detect drift between a worktree's .claude/active-task.json
# and the Monday.com source-of-truth, and print actionable hints.
#
# Always informational — exits 0 unconditionally. Never blocks session start.
#
# Detected drift cases:
#   A — Task is Done on Monday but the worktree still has an active-task.json
#       (ship-pr Phase 10 cleanup was skipped, or the merge happened in a
#       different session, leaving an orphan worktree).
#   B — Ownership changed: Monday's Agent ID column points at a different
#       agent than the one that originally claimed (potential cross-session
#       conflict; rare but high-impact).
#   D — A .claude/worktrees/* directory has no active-task.json. Either the
#       worktree was abandoned mid-pickup or it was reused without /pickup-task.
#
# Not detected (deferred):
#   C — Task reassigned to a different epic/sprint (low signal — could be
#       intentional refinement).
#   E — claimToken stale / no longer matches a Monday update (would require
#       an extra getUpdates call per session start; not worth the API cost).
#
# Silent no-op when:
#   - cwd is NOT under .claude/worktrees/ (main checkout — nothing to reconcile)
#   - MONDAY_API_KEY is unset (can't reach the source of truth)
#   - curl or jq missing (env can't run the check)
#   - Monday API request fails or times out
#   - active-task.json's taskId is empty/malformed
#
# Output format: "[active-task-recon] Case X: <one-line summary>" followed by
# 1-2 indented suggestion lines. The Claude Code session shows these as
# pre-prompt notices; the agent reads them as context, not as an error.

set -u
shopt -s nullglob

# Only run inside a plugin worktree
if [[ "$PWD" != *"/.claude/worktrees/"* ]]; then
  exit 0
fi

STATE_FILE=".claude/active-task.json"

# Case D: state file missing in a plugin worktree
if [ ! -f "$STATE_FILE" ]; then
  echo "[active-task-recon] Case D: no .claude/active-task.json in $(basename "$PWD")."
  echo "[active-task-recon]   If abandoned    → ExitWorktree({action:'remove'})"
  echo "[active-task-recon]   To pick up here → /pickup-task <id>"
  exit 0
fi

# Cases A + B require querying Monday. Bail silently if env can't.
if [ -z "${MONDAY_API_KEY:-}" ]; then exit 0; fi
command -v curl >/dev/null 2>&1 || exit 0
command -v jq   >/dev/null 2>&1 || exit 0

TASK_ID=$(jq -r '.taskId // empty' "$STATE_FILE" 2>/dev/null)
if [ -z "$TASK_ID" ]; then
  echo "[active-task-recon] active-task.json present but taskId empty/malformed; skipping drift check."
  exit 0
fi

# Query Monday for the task's status + agent
QUERY_PAYLOAD=$(jq -n --arg id "$TASK_ID" \
  '{query: "query($id: [ID!]) { items(ids: $id) { column_values(ids: [\"task_status\", \"dropdown_mm0mrcex\"]) { id text } } }", variables: {id: [$id]}}')

RESPONSE=$(curl -sS -X POST "https://api.monday.com/v2" \
  -H "Authorization: $MONDAY_API_KEY" \
  -H "Content-Type: application/json" \
  --max-time 10 \
  --data "$QUERY_PAYLOAD" 2>/dev/null)

if [ -z "$RESPONSE" ]; then exit 0; fi

# Extract status + agent. Empty if the API returned an error or unexpected shape.
STATUS=$(echo "$RESPONSE" | jq -r '.data.items[0].column_values[]? | select(.id == "task_status") | .text // empty' 2>/dev/null)
AGENT=$(echo  "$RESPONSE" | jq -r '.data.items[0].column_values[]? | select(.id == "dropdown_mm0mrcex") | .text // empty' 2>/dev/null)

# Case A: task Done on Monday but worktree still present
if [ "$STATUS" = "Done" ]; then
  echo "[active-task-recon] Case A: Task #$TASK_ID is Done on Monday."
  echo "[active-task-recon]   Worktree presumed shipped — ExitWorktree({action:'remove'}) once verified clean."
  echo "[active-task-recon]   The worktree-janitor SessionStart hook will collect this on next launch."
fi

# Case B: ownership changed away from this CLI agent's identity.
# Monday's Agent ID dropdown renders "Claude Code in CLI" for the CLI agent
# (note the "in" — the dropdown labels are not character-exact to the AGENT_ID
# enum used by the MCP). Accept both forms to be defensive.
if [ -n "$AGENT" ] && [ "$AGENT" != "Claude Code in CLI" ] && [ "$AGENT" != "Claude Code CLI" ]; then
  echo "[active-task-recon] Case B: Task #$TASK_ID Agent ID is now '$AGENT'."
  echo "[active-task-recon]   Continuing this session may conflict with the other agent's work."
  echo "[active-task-recon]   If you didn't expect this, /log-progress TASK_STUCK and surface to the user."
fi

exit 0
