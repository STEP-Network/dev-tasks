#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "post-push-review-check" in hooks.enabled[]. Keeps the plugin's hooks dormant in
# projects that don't follow this workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "post-push-review-check" || exit 0
# Hook: PostToolUse (Bash)
# After a successful git push, poll CI status until complete, then check reviews.
# Non-blocking (exit 0) but prints prominent results the agent MUST act on.

INPUT=$(cat)

# Only trigger on git push commands
ACTUAL_CMD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null)
if ! echo "$ACTUAL_CMD" | grep -q "git push"; then
  exit 0
fi

# Check if the push succeeded (stdout should contain "->").
# Two correctness traps fixed in #146:
#   1. Field name is `tool_response`, NOT `tool_result` (the version below
#      that hardcoded `tool_result` was reading the wrong key all along —
#      the python returned `''`, the grep matched nothing, the hook was a
#      no-op for every push). Verified against build-failure-advisor.sh,
#      parse-self-review-output.py, post-self-review.sh.
#   2. `grep -q -- "->"` (note the `--`) is required: BSD grep on macOS AND
#      GNU grep on Linux both treat `->` as a malformed flag and error
#      with exit 2 otherwise.
# Defensive: tool_response may be a dict (with .stdout) OR a plain string.
STDOUT=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    r = d.get('tool_response', '')
    if isinstance(r, dict):
        print(r.get('stdout', '') or '')
    else:
        print(r or '')
except Exception:
    pass
" 2>/dev/null)
if ! echo "$STDOUT" | grep -q -- "->"; then
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
BRANCH=$(cd "$PROJECT_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

# Find PR number for this branch
PR_NUM=$(cd "$PROJECT_ROOT" && gh pr list --head "$BRANCH" --json number --jq '.[0].number' 2>/dev/null)

if [ -z "$PR_NUM" ] || [ "$PR_NUM" = "null" ]; then
  exit 0
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  POST-PUSH: Polling PR #${PR_NUM} CI (every 30s, max 10 min)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

MAX_ATTEMPTS=20  # 20 * 30s = 10 minutes
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  ATTEMPT=$((ATTEMPT + 1))

  CHECKS=$(cd "$PROJECT_ROOT" && gh pr checks "$PR_NUM" 2>/dev/null)
  FAILED=$(echo "$CHECKS" | grep -ci "fail")
  PENDING=$(echo "$CHECKS" | grep -ci "pending\|queued\|in_progress")
  PASSED=$(echo "$CHECKS" | grep -ci "pass\|success")
  SKIPPING=$(echo "$CHECKS" | grep -ci "skipping\|neutral")

  TOTAL=$((FAILED + PENDING + PASSED + SKIPPING))

  if [ "$PENDING" -eq 0 ] 2>/dev/null; then
    # All checks complete
    break
  fi

  echo "  ⏳ Attempt ${ATTEMPT}/${MAX_ATTEMPTS}: ${PASSED} passed, ${FAILED} failed, ${PENDING} pending..."
  sleep 30
done

echo ""

# Final status
CHECKS=$(cd "$PROJECT_ROOT" && gh pr checks "$PR_NUM" 2>/dev/null)
FAIL_LINES=$(echo "$CHECKS" | grep -i "fail")

if [ -n "$FAIL_LINES" ]; then
  echo "  ❌ FAILING CI CHECKS:"
  echo "$FAIL_LINES" | while read -r line; do echo "     $line"; done
  echo ""
  echo "  ACTION REQUIRED: Fix failing checks before continuing!"
  echo "  Run: gh run view <run-id> --log-failed"
else
  echo "  ✅ All CI checks passing."
fi

# Check for review comments
REVIEW_COMMENTS=$(cd "$PROJECT_ROOT" && gh api "repos/{owner}/{repo}/pulls/${PR_NUM}/comments" --jq 'length' 2>/dev/null)
CHANGES_REQUESTED=$(cd "$PROJECT_ROOT" && gh pr view "$PR_NUM" --json reviews --jq '[.reviews[] | select(.state == "CHANGES_REQUESTED")] | length' 2>/dev/null)

if [ "$CHANGES_REQUESTED" -gt 0 ] 2>/dev/null; then
  echo ""
  echo "  🔴 CHANGES REQUESTED — review comments MUST be addressed!"
  echo "  Run: gh api repos/{owner}/{repo}/pulls/${PR_NUM}/comments --jq '.[].body'"
fi

if [ "$REVIEW_COMMENTS" -gt 0 ] 2>/dev/null; then
  echo ""
  echo "  💬 ${REVIEW_COMMENTS} PR review comment(s) — check for unresolved feedback."
fi

# Fetch the latest claude-review bot comment (issue comments, not PR review comments)
echo ""
echo "  📋 Fetching latest claude-review bot comment..."
CLAUDE_REVIEW=$(cd "$PROJECT_ROOT" && gh api "repos/{owner}/{repo}/issues/${PR_NUM}/comments" \
  --jq '[.[] | select(.body | test("^---\\n## Code Review|^## Code Review"))] | last | .body' 2>/dev/null)

if [ -n "$CLAUDE_REVIEW" ] && [ "$CLAUDE_REVIEW" != "null" ]; then
  printf '\n'
  printf '  ┌─────────────────────────────────────────────────┐\n'
  printf '  │  CLAUDE CODE REVIEW (MUST READ BEFORE MERGING)  │\n'
  printf '  └─────────────────────────────────────────────────┘\n'
  printf '\n'
  printf '%s\n' "$CLAUDE_REVIEW"
  printf '\n'
  printf '  ⚠️  You MUST address all actionable findings above before merging.\n'
else
  printf '  ℹ️  No claude-review comment found yet. It may still be running.\n'
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

exit 0
