#!/bin/bash

# Opt-in gate: hook is inert unless this project's .claude/project-config.json
# lists "post-merge-postmortem" in hooks.enabled[]. Keeps the plugin's hooks dormant in
# projects that don't follow this workflow.
source "$(dirname "${BASH_SOURCE[0]}")/lib/config-reader.sh"
hook_enabled "post-merge-postmortem" || exit 0
# Hook: PostToolUse Bash — capture multi-round PR merges as post-mortem candidates.
#
# Closes part of GH issue #113 (GAP-H — review-loop post-mortem capture).
#
# Why: When a PR needs >1 review round, there's a systemic gap somewhere — the agent
# missed a pattern, a rule was unclear, an edge case wasn't covered. Today the lesson
# dies in the conversation. We capture multi-round merges as candidates so the agent
# can periodically review them and decide which lessons should become rule updates.
#
# Filter: only triggers on `gh pr merge *` commands. Multi-round detection: counts
# claude bot review comments matching "## Code Review" (not greetings/warnings) —
# ≥2 means the bot reviewed twice, i.e. one fix round happened between them.
#
# Output: appends to .claude/postmortem-candidates.md (gitignored). Each entry has
# PR number, number of review rounds, fix-commit summaries, and a placeholder for the
# systemic-gap analysis (filled in later by the agent or a /postmortem skill).
#
# Non-blocking: exits 0 on every error so a hook failure never blocks a merge.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
CANDIDATES_FILE="$PROJECT_ROOT/.claude/postmortem-candidates.md"

INPUT=$(cat)

# Extract the bash command via jq (already a dependency for gh and other hooks).
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null)

case "$COMMAND" in
  *"gh pr merge "*) ;;
  *) exit 0 ;;
esac

# Extract the first numeric run after `gh pr merge`. `[^0-9]*` absorbs any flags
# between the subcommand and the PR number — e.g. `gh pr merge --squash 127` or
# `gh pr merge --delete-branch --squash 127` both extract correctly. `-E` for
# portable extended regex (BSD sed on macOS + GNU sed both support it).
PR_NUMBER=$(echo "$COMMAND" | sed -nE 's/.*gh pr merge[^0-9]*([0-9]+).*/\1/p' | head -1)

if [ -z "$PR_NUMBER" ]; then
  exit 0
fi

# Single gh pr view call covering all needed fields.
PR_DATA=$(gh pr view "$PR_NUMBER" --json title,url,headRefName,mergedAt,commits,comments 2>/dev/null)

if [ -z "$PR_DATA" ]; then
  exit 0
fi

# Count claude bot REVIEW comments specifically — not every comment by the bot account.
# Tighter filter than `select(.author.login == "claude")` because the bot occasionally
# posts non-review comments (greetings, warnings, etc.) that would inflate the count.
ROUNDS=$(echo "$PR_DATA" | jq '[.comments[] | select(.author.login == "claude" and (.body | contains("## Code Review")))] | length' 2>/dev/null)

if [ -z "$ROUNDS" ] || [ "$ROUNDS" -lt 2 ]; then
  exit 0
fi

# Multi-round merge detected. Extract metadata.
TITLE=$(echo "$PR_DATA" | jq -r '.title // ""')
URL=$(echo "$PR_DATA" | jq -r '.url // ""')
BRANCH=$(echo "$PR_DATA" | jq -r '.headRefName // ""')
MERGED_AT=$(echo "$PR_DATA" | jq -r '.mergedAt // ""')

# Get all non-merge commits in the PR. We don't have timestamp correlation to review
# comments, so we can't precisely attribute commits to specific review rounds — this
# is just the full commit set the agent (or a /postmortem skill) can mine for context.
PR_COMMITS=$(echo "$PR_DATA" | jq -r '
  .commits[]
  | select((.messageHeadline // "") | ascii_downcase | startswith("merge") | not)
  | "  - \(.oid[0:8]) \(.messageHeadline)"
' 2>/dev/null)

# Ensure the candidates dir exists.
mkdir -p "$(dirname "$CANDIDATES_FILE")"

# Initialize the file with a header if it doesn't exist.
if [ ! -f "$CANDIDATES_FILE" ]; then
  cat > "$CANDIDATES_FILE" <<'HEADER'
# Post-Mortem Candidates

> Captured by `.claude/hooks/post-merge-postmortem.sh` after every PR merge with
> ≥2 claude bot review rounds. Each entry is raw data — the systemic-gap analysis
> is filled in later by the agent (manually or via a `/postmortem` skill).
>
> Workflow:
> 1. Hook captures candidate when `gh pr merge` runs on a multi-round PR.
> 2. Periodically (or when this file accumulates ~10–20 entries), agent reviews
>    candidates and proposes rule updates.
> 3. Approved insights become entries in `.claude/rules/` or skill updates.
> 4. The candidate is then deleted from this file (resolved).
>
> Format per entry:
> - **PR**: #N — title
> - **Branch**: feat/foo-bar
> - **Merged**: ISO8601
> - **Review rounds**: N (count of claude bot "## Code Review" comments)
> - **Commits in PR** (non-merge): bulleted list — no precise round attribution
> - **Systemic gap**: TODO — fill in after analysis
> - **Suggested rule update**: TODO — fill in after analysis

---

HEADER
fi

# Append the new entry. Concurrent gh-pr-merge invocations are not a real scenario
# (single agent, one merge at a time), so plain `>>` is sufficient.
{
  echo ""
  echo "## #$PR_NUMBER — $TITLE"
  echo ""
  echo "- **PR**: $URL"
  echo "- **Branch**: \`$BRANCH\`"
  echo "- **Merged**: $MERGED_AT"
  echo "- **Review rounds**: $ROUNDS"
  echo "- **Commits in PR** (non-merge):"
  if [ -n "$PR_COMMITS" ]; then
    echo "$PR_COMMITS"
  else
    echo "  - (none captured)"
  fi
  echo "- **Systemic gap**: TODO — what pattern did the multi-round review surface?"
  echo "- **Suggested rule update**: TODO — which \`.claude/rules/*.md\` should be tightened?"
  echo ""
  echo "---"
} >> "$CANDIDATES_FILE"

# Print a non-blocking reminder to the agent's stdout so the next prompt sees it.
echo "📝 Post-mortem candidate captured: PR #$PR_NUMBER had $ROUNDS review rounds."
echo "   Review .claude/postmortem-candidates.md when convenient and propose rule updates."

exit 0
