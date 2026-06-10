#!/bin/bash

# STEP-wide policy: CI must be green before session exit (no opt-out). This
# hook is always-on regardless of project-config.hooks.enabled[]. The previous
# opt-in gate was lifted as part of the multi-project alignment (Phase 3).

# Redirect stdout to stderr so block messages (exit 2) reach Claude Code
# correctly. Per Claude Code hooks spec, block reasons must be on stderr.
exec >&2

# Hook: Stop
# HARD BLOCK: refuses session exit when a push happened in this session and CI
# on the resulting PR is not yet green. Complements stop-task-check.sh, which
# only fires when an active Monday task exists — this hook fires for ALL
# pushes, including quickfixes done outside the /pickup-task workflow.
#
# Mechanism:
#   1. post-push-track.sh writes /tmp/.claude-pushed-{branch} after every
#      successful `git push`.
#   2. This hook reads that marker. If present, queries `gh pr checks` for the
#      branch's PR and refuses Stop if any check is `pending` or `fail`.
#   3. On all-green, clears the marker so subsequent stops don't re-check.
#
# Acknowledging known flakes:
#   If a check fails for a documented infra reason (e.g. Anthropic claude-review
#   "Internal error: directory mismatch", or DB-unavailable Test failures), the
#   agent acknowledges by writing a one-line reason to:
#     /tmp/.claude-ci-ack-{branch}
#   The hook will then allow Stop. The ack file is per-branch and per-session
#   (in /tmp), so it doesn't accidentally carry over between unrelated PRs.
#
# Per-task CI Gate (v0.26.0):
#   The Monday "CI Gate" column (color_mm46jxc) can authorize skipping the
#   WAIT: under "Skip (human)" / "Skip (agent)" this hook allows Stop while
#   checks are pending / unregistered / cancelled. FAILED checks still block
#   (the ack path above is the only failure escape). Resolution: live Monday
#   column → active-task.json `ciGate` mirror → "Full". See CLAUDE.md
#   "Per-task CI Gate" for the full contract.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-agent-cwd.sh"

# Read the Stop-hook payload (may be empty for older Claude Code versions —
# resolve_agent_cwd handles that gracefully). Prefer agent's actual cwd over
# CLAUDE_PROJECT_DIR — the BRANCH we look up the marker by must match what
# post-push-track.sh wrote, which is the WORKTREE's branch.
INPUT=$(cat 2>/dev/null || echo "")
AGENT_CWD=$(resolve_agent_cwd "$INPUT")
PROJECT_ROOT="${AGENT_CWD:-${CLAUDE_PROJECT_DIR:-$PWD}}"

BRANCH=$(cd "$PROJECT_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -z "$BRANCH" ]; then
  exit 0
fi

# Must match post-push-track.sh's encoding — see comment there.
SAFE_BRANCH=$(echo "$BRANCH" | sed 's|/|__|g')
MARKER="/tmp/.claude-pushed-${SAFE_BRANCH}"
ACK_FILE="/tmp/.claude-ci-ack-${SAFE_BRANCH}"

# No push marker = no recent push from this session = nothing to gate
if [ ! -f "$MARKER" ]; then
  exit 0
fi

# ESCAPE HATCH (2026-05-15): the new no-merge policy lets agents push + open PR
# + SendMessage orchestrator + end, without waiting for CI. The orchestrator
# session runs /babysit-prs to do all CI gating + review triage + merge.
# If the agent set reviewAddressed: "handoff-to-orchestrator" in active-task.json,
# clear the marker (so subsequent stops don't re-trigger) and let exit through.
# This is opt-in per agent + per push — auto-merge agents still gate on CI green.
#
# Also escape on `stuck:*` values (regression-loop, max-rounds, etc.): the agent
# has deliberately halted because it cannot proceed, and the user needs to
# intervene. Blocking the stop on CI green here would create an impossible
# state (can't fix, can't stop). pre-merge-review-gate.py still refuses the
# merge for any stuck:* value (line 118), so this escape only governs the
# session-stop gate, not the merge gate.
ACTIVE_TASK="$PROJECT_ROOT/.claude/active-task.json"
if [ -f "$ACTIVE_TASK" ]; then
  REVIEW_ADDRESSED=$(jq -r '.reviewAddressed // ""' "$ACTIVE_TASK" 2>/dev/null)
  case "$REVIEW_ADDRESSED" in
    handoff-to-orchestrator|stuck:*|timeout:*)
      rm -f "$MARKER"
      exit 0
      ;;
  esac
fi

# CI GATE (v0.26.0): per-task skip of the CI WAIT, authorized via the Monday
# "CI Gate" status column (color_mm46jxc on the Tasks board). "Skip (human)" /
# "Skip (agent)" allow session exit while checks are PENDING (or not yet
# registered, or cancelled). A check that has already FAILED still blocks —
# skip removes the wait, never the never-bypass-red-CI policy.
#
# Resolution order: live Monday column (the server-side authority — a human
# flipping the column mid-task, or a revoked auto-skip, takes effect at the
# next Stop) → active-task.json `ciGate` mirror (offline fallback, written by
# /pickup-task via the protected-field marker contract) → "Full".
CI_GATE="Full"
if [ -f "$ACTIVE_TASK" ]; then
  LOCAL_GATE=$(jq -r '.ciGate // ""' "$ACTIVE_TASK" 2>/dev/null)
  [ -n "$LOCAL_GATE" ] && CI_GATE="$LOCAL_GATE"

  TASK_ID=$(jq -r '.taskId // ""' "$ACTIVE_TASK" 2>/dev/null)
  if [ -n "$TASK_ID" ] && [ -n "${MONDAY_API_KEY:-}" ] && command -v curl >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
    GATE_PAYLOAD=$(jq -n --arg id "$TASK_ID" \
      '{query: "query($id: [ID!]) { items(ids: $id) { column_values(ids: [\"color_mm46jxc\"]) { id text } } }", variables: {id: [$id]}}')
    GATE_RESPONSE=$(curl -sS -X POST "https://api.monday.com/v2" \
      -H "Authorization: $MONDAY_API_KEY" \
      -H "Content-Type: application/json" \
      --max-time 5 \
      --data "$GATE_PAYLOAD" 2>/dev/null)
    if [ -n "$GATE_RESPONSE" ] && echo "$GATE_RESPONSE" | jq -e '.data.items[0]' >/dev/null 2>&1; then
      # Live read succeeded — it wins, including "empty column" (= Full), so a
      # revoked skip can't survive via a stale local mirror.
      LIVE_GATE=$(echo "$GATE_RESPONSE" | jq -r '.data.items[0].column_values[]? | select(.id == "color_mm46jxc") | .text // empty' 2>/dev/null)
      CI_GATE="${LIVE_GATE:-Full}"
    fi
  fi
fi
CI_GATE_SKIP=false
case "$CI_GATE" in
  "Skip (human)"|"Skip (agent)") CI_GATE_SKIP=true ;;
esac

# Find PR for this branch
PR=$(cd "$PROJECT_ROOT" && gh pr list --head "$BRANCH" --json number --jq '.[0].number' 2>/dev/null)
if [ -z "$PR" ] || [ "$PR" = "null" ]; then
  # Push happened but no PR yet — could be a direct push to main/staging, or
  # /ship-pr hasn't created the PR yet. Don't block on missing PR; that's
  # ship-pr's stage, not this hook's.
  exit 0
fi

# Skip review-only PRs (e.g. PR #158 "[REVIEW-ONLY · DO NOT MERGE]" staging→main
# tracking PR). Their head=staging means every staging push trips this hook
# even though the PR is not a real merge target. Filed as retro #2915621698.
PR_TITLE=$(cd "$PROJECT_ROOT" && gh pr view "$PR" --json title --jq '.title' 2>/dev/null)
if echo "$PR_TITLE" | grep -qiE 'do not merge|review.only|no.merge'; then
  exit 0
fi

# Query CI state. `gh pr checks` returns one row per check name with its
# bucket: pass | fail | pending | skipping | cancelled.
STATUS=$(cd "$PROJECT_ROOT" && gh pr checks "$PR" --json name,bucket 2>/dev/null)
if [ -z "$STATUS" ] || [ "$STATUS" = "[]" ]; then
  # Race-window detection: if the marker is fresh (<60s old) AND gh returned
  # empty, GitHub probably hasn't registered the workflow runs yet. Block —
  # otherwise an agent that pushes and immediately Stops would silently
  # bypass the entire gate. Falls back to fail-open after 60s for genuine
  # network/auth issues that shouldn't trap the user indefinitely.
  MARKER_MTIME=$(stat -f %m "$MARKER" 2>/dev/null || stat -c %Y "$MARKER" 2>/dev/null)
  NOW=$(date +%s)
  if [ -n "$MARKER_MTIME" ]; then
    AGE=$((NOW - MARKER_MTIME))
    if [ "$AGE" -lt 60 ]; then
      if [ "$CI_GATE_SKIP" = "true" ]; then
        echo "INFO: CI Gate '$CI_GATE' — checks not yet registered on PR #$PR, but the wait is skipped. Merge stays gated on green." >&2
        exit 0
      fi
      echo "BLOCKED: pushed ${AGE}s ago to PR #$PR — CI checks not yet registered by GitHub." >&2
      echo "Wait ~30–60s and retry. The marker stays in place; this hook will re-check on next Stop attempt." >&2
      exit 2
    fi
  fi
  # Older than 60s with empty status → likely a real query failure, not a race.
  # Don't trap the user; warn and let through.
  echo "WARNING: could not query CI for PR #$PR ($BRANCH). Verify manually before declaring done." >&2
  exit 0
fi

# Pending checks block — unless the per-task CI Gate authorizes skipping the
# wait. The marker stays in place so a later Stop re-checks (the gate may have
# been revoked, and a FAILED check must still block).
PENDING=$(echo "$STATUS" | jq -r '[.[] | select(.bucket == "pending") | .name] | join(", ")' 2>/dev/null)
if [ -n "$PENDING" ]; then
  if [ "$CI_GATE_SKIP" = "true" ]; then
    echo "INFO: CI Gate '$CI_GATE' — pending checks on PR #$PR not awaited: $PENDING" >&2
    echo "Merge remains server-gated on green (pre-merge gate + branch protection unchanged)." >&2
    exit 0
  fi
  echo "BLOCKED: CI checks still pending on PR #$PR ($BRANCH): $PENDING" >&2
  echo "" >&2
  echo "You pushed code in this session and CI hasn't reached terminal state yet." >&2
  echo "Wait for all checks to settle before ending. The agent should still be on a Monitor for this." >&2
  echo "If a Monitor isn't running, arm one with:" >&2
  echo "  gh pr checks $PR --watch" >&2
  exit 2
fi

# Failed checks block unless explicitly acknowledged.
FAILS=$(echo "$STATUS" | jq -r '[.[] | select(.bucket == "fail") | .name] | join(", ")' 2>/dev/null)
if [ -n "$FAILS" ]; then
  if [ -f "$ACK_FILE" ]; then
    REASON=$(head -1 "$ACK_FILE" 2>/dev/null)
    echo "INFO: CI failures on PR #$PR acknowledged ($FAILS). Reason: $REASON" >&2
    # Don't clear the marker — we let through this stop, but a subsequent push
    # rewrites the marker and the ack should be re-stated for the new commit.
    exit 0
  fi
  echo "BLOCKED: CI failures on PR #$PR ($BRANCH): $FAILS" >&2
  echo "" >&2
  echo "Either fix the failures, or — if they're known flakes per .claude/rules/ship-readiness.md" >&2
  echo "(e.g. Test fail = DB-unavailable in CI, claude-review fail = Anthropic infra 'directory" >&2
  echo "mismatch' error) — acknowledge them by writing the reason to:" >&2
  echo "  $ACK_FILE" >&2
  echo "" >&2
  echo "Example:" >&2
  echo "  echo 'Test fail: pre-existing flake (DB unavailable in CI runner)' > $ACK_FILE" >&2
  exit 2
fi

# Cancelled checks (e.g. superseded by a new push) — hold the marker but don't
# clear it. A cancelled bucket would otherwise silently fall through to "all
# green" and clear the marker. Block instead so the agent waits for the new
# run that triggered the cancellation, which produces fresh check entries.
# Defense against gh version drift: accept both `cancel` (current) and
# `cancelled` (defensive).
CANCELS=$(echo "$STATUS" | jq -r '[.[] | select(.bucket == "cancel" or .bucket == "cancelled") | .name] | join(", ")' 2>/dev/null)
if [ -n "$CANCELS" ]; then
  if [ "$CI_GATE_SKIP" = "true" ]; then
    echo "INFO: CI Gate '$CI_GATE' — cancelled checks on PR #$PR not awaited: $CANCELS" >&2
    exit 0
  fi
  echo "BLOCKED: CI checks cancelled on PR #$PR ($BRANCH): $CANCELS" >&2
  echo "Likely superseded by a newer push. Wait for the new run to complete." >&2
  exit 2
fi

# All green — clear the marker so the gate doesn't keep re-running on idle stops.
rm -f "$MARKER"
exit 0
