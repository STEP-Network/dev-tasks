#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "auto-merge-policy-gate" in hooks.enabled[].
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-agent-cwd.sh"
hook_enabled "auto-merge-policy-gate" || exit 0

exec >&2

# Hook: PreToolUse (Bash) — enforces git.autoMergePolicy on `gh pr merge`.
#
# autoMergePolicy is a per-branch map (branch name → policy) in project-config:
#   never | manual-only              → agent must NOT merge; a human merges.
#   auto-after-checks-and-review     → agent MAY merge (existing review + CI
#                                      gates still apply — this gate only PERMITS).
# This gate resolves the PR's TARGET (base) branch and blocks the merge when
# that branch's policy is never/manual-only.
#
# Why a dedicated hook (not folded into pre-merge-review-gate): the review gate
# only fires for task-driven merges (it exits 0 when there is no active-task.json).
# Orchestrator / babysit-prs merges frequently run with no state file, which is
# exactly the path that let unwanted auto-merges through. This gate is
# state-file-independent: it keys purely off project-config + the PR's base branch.
#
# Safety posture:
#   - Unknown/typo'd policy value (e.g. "manual", "auto")  → BLOCK (fail safe):
#     surfaces the misconfiguration loudly instead of silently doing nothing.
#   - Base branch unresolvable (gh offline/unauthed)       → ALLOW (fail open):
#     the `gh pr merge` itself needs GitHub connectivity, so an offline merge
#     fails on its own; we don't brick the command on our inability to verify.
#   - No autoMergePolicy configured, or branch absent from it → ALLOW (no opinion).

INPUT=$(cat)

ACTUAL_CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)
if [ -z "$ACTUAL_CMD" ]; then
  exit 0
fi

# Only gate `gh pr merge` commands
case "$ACTUAL_CMD" in
  *"gh pr merge"*) ;;
  *) exit 0 ;;
esac

# Read the whole policy object once. Absent/empty → this project has no
# auto-merge policy, so the gate has no opinion.
POLICY_OBJ=$(read_project_config '.git.autoMergePolicy')
if [ -z "$POLICY_OBJ" ]; then
  exit 0
fi

AGENT_CWD=$(resolve_agent_cwd "$INPUT")
PROJECT_ROOT="${AGENT_CWD:-${CLAUDE_PROJECT_DIR:-$PWD}}"

# Extract an explicit PR number if the command carries one (`gh pr merge 123`).
# Absent → gh resolves the current branch's PR.
PR_NUMBER=$(echo "$ACTUAL_CMD" | sed -nE 's/.*gh pr merge[^0-9]*([0-9]+).*/\1/p' | head -1)

# Resolve the PR's TARGET (base) branch. Run from the agent's repo dir so gh
# resolves the right repository/PR.
if [ -n "$PR_NUMBER" ]; then
  BASE_BRANCH=$(cd "$PROJECT_ROOT" 2>/dev/null && gh pr view "$PR_NUMBER" --json baseRefName -q .baseRefName 2>/dev/null)
else
  BASE_BRANCH=$(cd "$PROJECT_ROOT" 2>/dev/null && gh pr view --json baseRefName -q .baseRefName 2>/dev/null)
fi

# Can't determine the base branch → fail open (the merge needs GitHub anyway).
if [ -z "$BASE_BRANCH" ]; then
  exit 0
fi

# Branch name is data, never code: pass it to jq via --arg (no filter injection).
POLICY=$(printf '%s' "$POLICY_OBJ" | jq -r --arg b "$BASE_BRANCH" '.[$b] // empty' 2>/dev/null)

PR_LABEL="${PR_NUMBER:+#$PR_NUMBER}"
PR_LABEL="${PR_LABEL:-(current branch)}"

case "$POLICY" in
  never|manual-only)
    echo "BLOCKED: auto-merge-policy-gate — branch \"$BASE_BRANCH\" has autoMergePolicy \"$POLICY\"."
    echo "  Agent auto-merge to \"$BASE_BRANCH\" is disabled; a human must merge PR $PR_LABEL."
    echo "  To allow agent merges to this branch, set git.autoMergePolicy.\"$BASE_BRANCH\""
    echo "  to \"auto-after-checks-and-review\" in .claude/project-config.json."
    exit 2
    ;;
  auto-after-checks-and-review)
    # Permitted. The review gate + CI checks remain the merge-readiness authority.
    exit 0
    ;;
  "")
    # Branch not listed in autoMergePolicy → no opinion.
    exit 0
    ;;
  *)
    echo "BLOCKED: auto-merge-policy-gate — unrecognized autoMergePolicy \"$POLICY\" for branch \"$BASE_BRANCH\"."
    echo "  Valid values: never | manual-only | auto-after-checks-and-review."
    echo "  Fix git.autoMergePolicy.\"$BASE_BRANCH\" in .claude/project-config.json, then retry."
    exit 2
    ;;
esac
