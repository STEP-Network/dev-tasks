#!/bin/bash
# Tests for .claude/hooks/stop-monday-reconciled-check.sh
#
# Strategy: build a temp git repo with controlled merge history, write
# active-task.json + a session marker pointing at SHA before the merge, run the
# hook, assert behaviour.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../stop-monday-reconciled-check.sh"

# Set up a temp project-config that enables this hook (the plugin's hook_enabled
# opt-in pattern would otherwise return exit 0 immediately).
TEST_PROJECT_DIR=$(mktemp -d -t stop-monday-reconciled-check-test-XXXX)
mkdir -p "$TEST_PROJECT_DIR/.claude/cache"
cat > "$TEST_PROJECT_DIR/.claude/project-config.json" <<TESTCFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["stop-monday-reconciled-check"] }
}
TESTCFG
export CLAUDE_PROJECT_DIR="$TEST_PROJECT_DIR"
[ ! -x "$HOOK" ] && { echo "FATAL: hook not executable"; exit 1; }

PASS_COUNT=0
FAIL_COUNT=0

assert() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1));
  else echo "FAIL: $1 (expected '$3', got '$2')"; FAIL_COUNT=$((FAIL_COUNT + 1)); fi
}
assert_contains() {
  if echo "$2" | grep -qF "$3"; then echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1));
  else echo "FAIL: $1 (needle '$3' missing)"; FAIL_COUNT=$((FAIL_COUNT + 1)); fi
}

# Build a tmp git project with a clear merge history.
TMP_PROJECT=$(mktemp -d)
trap "rm -rf $TMP_PROJECT" EXIT
mkdir -p "$TMP_PROJECT/.claude/cache"

# Enable this hook in the test project config (plugin's opt-in gate).
cat > "$TMP_PROJECT/.claude/project-config.json" <<TESTCFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["stop-monday-reconciled-check"] }
}
TESTCFG

git -C "$TMP_PROJECT" init -q
git -C "$TMP_PROJECT" config user.email "test@example.com"
git -C "$TMP_PROJECT" config user.name "test"
git -C "$TMP_PROJECT" config commit.gpgsign false 2>/dev/null

# Commit 1: initial.
echo "v1" > "$TMP_PROJECT/file"
git -C "$TMP_PROJECT" add file
git -C "$TMP_PROJECT" commit -q -m "initial"
INIT_SHA=$(git -C "$TMP_PROJECT" rev-parse HEAD)

# Make a feature branch + merge.
git -C "$TMP_PROJECT" checkout -q -b feature 2>/dev/null
echo "v2" > "$TMP_PROJECT/file"
git -C "$TMP_PROJECT" commit -q -am "feature commit"
git -C "$TMP_PROJECT" checkout -q -
git -C "$TMP_PROJECT" merge -q --no-ff feature -m "Merge PR #123"
MERGE_SHA=$(git -C "$TMP_PROJECT" rev-parse HEAD)

write_state() { echo "$1" > "$TMP_PROJECT/.claude/active-task.json"; }
write_marker() { echo "$1" > "$TMP_PROJECT/.claude/cache/session-merge-marker"; }
rm_marker() { rm -f "$TMP_PROJECT/.claude/cache/session-merge-marker"; }
rm_state() { rm -f "$TMP_PROJECT/.claude/active-task.json"; }

run_hook() {
  (cd "$TMP_PROJECT" && CLAUDE_PROJECT_DIR="$TMP_PROJECT" "$HOOK" </dev/null 2>&1)
}

# Test 1: no active-task.json → pass-through.
rm_state; rm_marker
OUTPUT=$(run_hook)
assert "no state → pass-through" "$?" "0"

# Test 2: no marker → creates marker + passes (first Stop of session).
rm_marker
write_state '{"taskId":"1","claimToken":"t","subtasks":[]}'
OUTPUT=$(run_hook)
assert "no marker → pass + create marker" "$?" "0"
[ -f "$TMP_PROJECT/.claude/cache/session-merge-marker" ] && echo "PASS: marker created" && PASS_COUNT=$((PASS_COUNT + 1)) || { echo "FAIL: marker not created"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# Test 3: handoff-to-orchestrator → pass-through even with merges since marker.
write_marker "$INIT_SHA"
write_state '{"taskId":"1","claimToken":"t","reviewAddressed":"handoff-to-orchestrator","subtasks":[]}'
OUTPUT=$(run_hook)
assert "handoff-to-orchestrator → pass" "$?" "0"

# Test 4: marker at INIT_SHA, merge since, no reconciled SHAs, parent='In Progress' → BLOCK.
write_marker "$INIT_SHA"
write_state '{"taskId":"1","taskName":"X","claimToken":"t","parentStatus":"In Progress","subtasks":[]}'
OUTPUT=$(run_hook)
assert "merge w/o reconciliation → BLOCK" "$?" "2"
assert_contains "BLOCK mentions merge SHA prefix" "$OUTPUT" "${MERGE_SHA:0:8}"
assert_contains "BLOCK mentions Waiting for UAT" "$OUTPUT" "Waiting for UAT"

# Test 5: marker at INIT_SHA, merge since, parent='Waiting for UAT' → pass-through.
write_marker "$INIT_SHA"
write_state '{"taskId":"1","claimToken":"t","parentStatus":"Waiting for UAT","subtasks":[]}'
OUTPUT=$(run_hook)
assert "parent already at Waiting for UAT → pass" "$?" "0"

# Test 6: marker at INIT_SHA, merge SHA listed in mondayReconciledShas → pass.
write_marker "$INIT_SHA"
write_state "{\"taskId\":\"1\",\"claimToken\":\"t\",\"parentStatus\":\"In Progress\",\"mondayReconciledShas\":[\"$MERGE_SHA\"],\"subtasks\":[]}"
OUTPUT=$(run_hook)
assert "SHA recorded as reconciled → pass" "$?" "0"

# Test 7: marker at HEAD (no merges since) → pass-through.
write_marker "$MERGE_SHA"
write_state '{"taskId":"1","claimToken":"t","parentStatus":"In Progress","subtasks":[]}'
OUTPUT=$(run_hook)
assert "marker at HEAD (no new merges) → pass" "$?" "0"

# Test 8: malformed JSON state → pass-through.
echo "{ bad" > "$TMP_PROJECT/.claude/active-task.json"
OUTPUT=$(run_hook)
assert "malformed JSON → pass-through" "$?" "0"

echo ""
echo "==================================================="
echo "stop-monday-reconciled-check tests: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "==================================================="
[ "$FAIL_COUNT" -eq 0 ]
