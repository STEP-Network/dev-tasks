#!/bin/bash
# plugin/hooks/staging-deploy-ready-gate.sh
#
# Hook: PreToolUse on mcp__plugin_dev-tasks_dev-tasks__updateTask.
#
# Refuses (exit 2) any updateTask call that sets status='Waiting for UAT'
# UNLESS the staging deploy has been verified READY for this branch — recorded
# as `stagingDeployReady: true` in .claude/active-task.json.
#
# Rationale: "Waiting for UAT" tells a human the change is live on staging and
# ready to test. Flipping it the instant a PR merges (or before the post-merge
# redeploy finishes) is a lie — the reviewer hits the pre-deploy version. This
# gate enforces the order documented in workflow-pipeline.md:
#   Merge → wait for staging deploy READY → flip Waiting for UAT.
#
# The legitimate writer is /ship-pr: after polling Vercel
# (mcp__vercel__list_deployments filtered by the merge SHA) until a
# production-target deployment reaches state READY, it runs
# `emit-state-marker.sh stagingDeployReady` and writes the field. The
# `stagingDeployReady` field is marker-protected by protect-active-task-state.sh
# so it can't be self-granted by a direct JSON edit.
#
# CI relaxation: a CI runner spawned by the autonomous fix-loop has no Vercel
# access and can never observe a READY deploy, so under CI (GITHUB_ACTIONS=true
# or CI=true) this gate logs a NOTE and falls through — mirrors the
# stop-task-check Stage-3 CI relaxation (stop-task-logic.py running_in_ci()).
# Local/dev sessions still require a verified READY deploy.
#
# Opt-in via project-config.json → hooks.enabled[]. Silent no-op when not
# enabled, when the transition target is not "Waiting for UAT", or when no
# active-task.json exists (nothing to gate against — the server-side WfUAT
# gate and demo-url-required still apply).

# Redirect stdout to stderr.
exec >&2

# Opt-in gate.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-agent-cwd.sh"
hook_enabled "staging-deploy-ready-gate" || exit 0

INPUT=$(cat)

# Extract status + itemId from tool_input.
PARSED=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    ti = data.get('tool_input') or {}
    print(ti.get('status') or '')
    print(ti.get('itemId') or '')
except Exception:
    print('')
    print('')
" 2>/dev/null)

TARGET_STATUS=$(echo "$PARSED" | sed -n '1p')
ITEM_ID=$(echo "$PARSED" | sed -n '2p')

# Only fire when transitioning to Waiting for UAT.
if [ "$TARGET_STATUS" != "Waiting for UAT" ]; then
  exit 0
fi

# CI relaxation: runners can't reach Vercel, so a READY deploy is unobservable.
# Mirror stop-task-check Stage-3 (running_in_ci): log a NOTE and allow.
if [ "${GITHUB_ACTIONS:-}" = "true" ] || [ "${CI:-}" = "true" ]; then
  echo "NOTE: staging-deploy-ready-gate relaxed — running under CI (GITHUB_ACTIONS/CI)."
  echo "      A CI runner has no Vercel access, so it can't verify a READY staging deploy."
  echo "      Allowing the 'Waiting for UAT' transition for task #$ITEM_ID."
  exit 0
fi

# Resolve project root (same precedence as demo-url-required).
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

# No state file → nothing to gate against (e.g. orchestrator/babysit merges with
# no active-task.json). Don't block — the server-side WfUAT gate still applies.
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

READY=$(jq -r '.stagingDeployReady // false' "$STATE_FILE" 2>/dev/null)

if [ "$READY" = "true" ]; then
  exit 0
fi

echo "BLOCKED: task #$ITEM_ID can't flip to 'Waiting for UAT' — staging deploy not verified READY."
echo ""
echo "\"Waiting for UAT\" means a human can test the change on staging. Flipping it"
echo "before the post-merge deploy finishes points reviewers at the pre-deploy"
echo "version (PR #347 / retro #2926719311)."
echo ""
echo "Correct order (/ship-pr Phase 6.6 → 6.7, workflow-pipeline.md):"
echo "  1. Merge the PR."
echo "  2. Poll the deploy until READY:"
echo "       mergedSHA=\$(gh pr view {N} --json mergeCommit --jq .mergeCommit.oid)"
echo "       mcp__vercel__list_deployments filtered by meta.githubCommitSha=\$mergedSHA"
echo "       → wait for a production-target deployment in state READY."
echo "     (Non-Vercel: gh run watch / flyctl status / your platform's deploy check.)"
echo "  3. Record it (marker-protected field):"
echo "       bash \$CLAUDE_PLUGIN_ROOT/scripts/emit-state-marker.sh stagingDeployReady"
echo "       then set \"stagingDeployReady\": true in .claude/active-task.json"
echo "  4. Retry this updateTask(status='Waiting for UAT')."
echo ""
echo "Under CI (GITHUB_ACTIONS/CI) this gate is relaxed automatically — runners"
echo "can't reach Vercel. This block only fires in local/dev sessions."
exit 2
