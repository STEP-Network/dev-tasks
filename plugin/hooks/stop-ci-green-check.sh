#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "stop-ci-green-check" in hooks.enabled[]. Keeps the plugin's blocking hooks dormant
# in projects that don't follow the Monday task-first workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "stop-ci-green-check" || exit 0

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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"

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
ACTIVE_TASK="$PROJECT_ROOT/.claude/active-task.json"
if [ -f "$ACTIVE_TASK" ]; then
  REVIEW_ADDRESSED=$(jq -r '.reviewAddressed // ""' "$ACTIVE_TASK" 2>/dev/null)
  if [ "$REVIEW_ADDRESSED" = "handoff-to-orchestrator" ]; then
    rm -f "$MARKER"
    exit 0
  fi
fi

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

# Pending checks always block — wait for terminal state.
PENDING=$(echo "$STATUS" | jq -r '[.[] | select(.bucket == "pending") | .name] | join(", ")' 2>/dev/null)
if [ -n "$PENDING" ]; then
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
  echo "BLOCKED: CI checks cancelled on PR #$PR ($BRANCH): $CANCELS" >&2
  echo "Likely superseded by a newer push. Wait for the new run to complete." >&2
  exit 2
fi

# All green — clear the marker so the gate doesn't keep re-running on idle stops.
rm -f "$MARKER"
exit 0
