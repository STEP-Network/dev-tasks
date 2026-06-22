#!/bin/bash

# emit-state-marker.sh <field>
#
# Emit a /tmp marker file that unlocks the corresponding active-task.json field
# from the protect-active-task-state hook. Marker path:
#   /tmp/.claude-state-marker-<field>-<HEAD_SHA>
#
# Called by:
#   post-self-review.sh   → selfReviewPassed (after validator PASS)
#   /ship-pr SKILL.md     → reviewAddressed (Phase 6 / 6.2)
#                           parentStatus    (Phase 6.7)
#                           mondayReconciledShas (Phase 10)
#                           ciGate (Phase 2 auto-skip, after ci-skip-eval ELIGIBLE
#                           + the Monday column write to "Skip (agent)")
#   /babysit-prs SKILL.md → mondayReconciledShas (Phase 3)
#   /pickup-task SKILL.md → ciGate (step 12, mirroring a board-side Skip value
#                           into the fresh active-task.json)
#   /ship-pr SKILL.md     → stagingDeployReady (Phase 6.6, after the post-merge
#                           Vercel deploy is polled to state READY)
#
# Markers are SHA-scoped: they unlock a write at the current HEAD only. New
# commits invalidate prior markers, so a stale marker can't be reused after
# more code lands.
#
# Valid fields: selfReviewPassed, reviewAddressed, parentStatus,
# mondayReconciledShas, ciGate, stagingDeployReady. allowMainCheckout has no
# marker path (rejected here).
#
# Usage:
#   bash $CLAUDE_PLUGIN_ROOT/scripts/emit-state-marker.sh selfReviewPassed
#
# Returns: 0 + prints marker path on success, 1 on bad arg / no git repo.

set -u

FIELD="${1:-}"

case "$FIELD" in
  selfReviewPassed|reviewAddressed|parentStatus|mondayReconciledShas|ciGate|stagingDeployReady)
    ;;
  allowMainCheckout)
    echo "emit-state-marker: allowMainCheckout has no marker path — user must set manually" >&2
    exit 1
    ;;
  *)
    echo "emit-state-marker: invalid field '$FIELD'" >&2
    echo "Valid fields: selfReviewPassed, reviewAddressed, parentStatus, mondayReconciledShas, ciGate, stagingDeployReady" >&2
    exit 1
    ;;
esac

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null)
if [ -z "$HEAD_SHA" ]; then
  echo "emit-state-marker: not in a git repo" >&2
  exit 1
fi

MARKER="/tmp/.claude-state-marker-${FIELD}-${HEAD_SHA}"
: > "$MARKER"
echo "$MARKER"
