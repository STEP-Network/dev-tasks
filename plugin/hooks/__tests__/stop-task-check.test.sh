#!/bin/bash
# Tests for hooks/stop-task-check.sh — BASE BRANCH RESOLUTION only.
#
# The JSON-dependent pipeline logic lives in stop-task-logic.py and is covered by
# stop-task-logic.test.sh. What this file pins is the bash wrapper's choice of
# diff base, which used to be hardcoded to origin/main (#3173690687).
#
# Strategy: build a temp git repo shaped like a staging-based project — origin/main
# left behind, origin/staging at the branch point — then claim a feature branch off
# staging with ZERO commits and assert the hook allows the stop. Against the old
# hardcoded base that same fixture blocks, so test 2 is a real negative control.
#
# The remote-tracking refs are written with `git update-ref` rather than by wiring
# up a bare remote: the hook only ever reads refs/remotes/origin/*, so this is the
# same fixture with no network and no second repo.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../stop-task-check.sh"
[ ! -x "$HOOK" ] && { echo "FATAL: hook not executable"; exit 1; }

PASS_COUNT=0
FAIL_COUNT=0
assert() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1));
  else echo "FAIL: $1 (expected '$3', got '$2')"; FAIL_COUNT=$((FAIL_COUNT + 1)); fi
}

# ---------- fixture: main behind, staging ahead, feature branched off staging ----------
TMP=$(mktemp -d)
cleanup() { [ -n "${TMP:-}" ] && [ -d "$TMP" ] && rm -r -f "$TMP"; }
trap cleanup EXIT
REPO="$TMP/repo"

git init -q "$REPO"
git -C "$REPO" config user.email t@e.com
git -C "$REPO" config user.name t
git -C "$REPO" config commit.gpgsign false 2>/dev/null
mkdir -p "$REPO/src" "$REPO/.claude"
# .claude/ is gitignored in real consumer repos (active-task.json is per-session
# state) — keep it untracked so it never lands in the measured diff.
echo ".claude/" > "$REPO/.gitignore"
echo "base" > "$REPO/src/util.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "init"
git -C "$REPO" branch -m main 2>/dev/null
git -C "$REPO" update-ref refs/remotes/origin/main HEAD

# staging pulls ahead of main by a merged-but-unreleased change (the real-world shape).
git -C "$REPO" checkout -q -b staging
echo "shipped on staging" > "$REPO/src/shipped.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "merged to staging, not yet released"
git -C "$REPO" update-ref refs/remotes/origin/staging HEAD

# Freshly claimed task branch: off staging, ZERO commits, clean tree.
git -C "$REPO" checkout -q -b feat/new-task

CONFIG="$REPO/.claude/project-config.json"
write_config() { cat > "$CONFIG" <<CFG
{
  "version": "1",
  "git": { "defaultBase": "$1" },
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["stop-task-check"] }
}
CFG
}
# A claimed task with the pipeline UNSTARTED — the state that blocks as soon as
# the hook believes source files changed.
echo '{"taskId":"1","taskName":"t","selfReviewPassed":false}' > "$REPO/.claude/active-task.json"

INPUT="{\"cwd\":\"$REPO\"}"
run_hook() { ( cd "$REPO" && CLAUDE_PROJECT_DIR="$REPO" "$HOOK" <<<"$INPUT" >/dev/null 2>&1 ); }

# Test 1: THE BUG. defaultBase=staging, empty branch diff -> allow stop.
write_config "staging"
run_hook; assert "defaultBase=staging, empty branch diff -> allow stop" "$?" "0"

# Test 2: negative control — the same fixture under defaultBase=main DOES block,
# proving test 1 passes because the base moved, not because the fixture is inert.
write_config "main"
run_hook; assert "defaultBase=main sees the staging delta -> blocks" "$?" "2"

# Test 3: no config at all -> hook is not enabled -> pass-through.
rm -f "$CONFIG"
run_hook; assert "no project-config -> pass-through (hook not enabled)" "$?" "0"

# Test 4: a real commit on the branch still blocks under the correct base.
write_config "staging"
echo "work" > "$REPO/src/feature.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -q -m "actual work"
run_hook; assert "defaultBase=staging, real commit -> blocks" "$?" "2"

# Test 5: an option-shaped defaultBase is sanitized to main, never reaching git.
CANARY="$TMP/injection-canary"
write_config "--output=$CANARY"
run_hook; assert "dash-leading defaultBase -> sanitized to main, blocks" "$?" "2"
if [ -e "$CANARY" ]; then
  echo "FAIL: option injection reached git"; FAIL_COUNT=$((FAIL_COUNT + 1))
else
  echo "PASS: option injection did not reach git"; PASS_COUNT=$((PASS_COUNT + 1))
fi

echo ""
echo "Passed: $PASS_COUNT, Failed: $FAIL_COUNT"
[ "$FAIL_COUNT" -eq 0 ] || exit 1
