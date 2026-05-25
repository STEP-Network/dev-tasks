#!/bin/bash
# Tests for .claude/hooks/stop-waiting-for-uat-stage.sh
#
# Strategy: write synthetic active-task.json into tmp project, invoke hook with
# no stdin (Stop hooks don't carry a payload), assert exit codes.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../stop-waiting-for-uat-stage.sh"

# Set up a temp project-config that enables this hook (the plugin's hook_enabled
# opt-in pattern would otherwise return exit 0 immediately).
TEST_PROJECT_DIR=$(mktemp -d -t stop-waiting-for-uat-stage-test-XXXX)
mkdir -p "$TEST_PROJECT_DIR/.claude/cache"
cat > "$TEST_PROJECT_DIR/.claude/project-config.json" <<TESTCFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["stop-waiting-for-uat-stage"] }
}
TESTCFG
export CLAUDE_PROJECT_DIR="$TEST_PROJECT_DIR"

if [ ! -x "$HOOK" ]; then
  echo "FATAL: hook not found at $HOOK"
  exit 1
fi

PASS_COUNT=0
FAIL_COUNT=0

assert() {
  local name="$1"
  local got="$2"
  local want="$3"
  if [ "$got" = "$want" ]; then
    echo "PASS: $name"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL: $name"
    echo "  expected: $want"
    echo "  got:      $got"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

assert_contains() {
  local name="$1"
  local haystack="$2"
  local needle="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "PASS: $name"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL: $name (needle '$needle' not in output)"
    echo "  output: $haystack"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# Make a tmp directory that's also a git repo so `git rev-parse --show-toplevel`
# returns it (the hook uses that to resolve project root from CWD).
TMP_PROJECT=$(mktemp -d)
mkdir -p "$TMP_PROJECT/.claude"

# Enable this hook in the test project config (plugin's opt-in gate).
cat > "$TMP_PROJECT/.claude/project-config.json" <<TESTCFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["stop-waiting-for-uat-stage"] }
}
TESTCFG
git -C "$TMP_PROJECT" init -q
git -C "$TMP_PROJECT" config user.email "test@example.com"
git -C "$TMP_PROJECT" config user.name "test"

cleanup() {
  rm -rf "$TMP_PROJECT"
}
trap cleanup EXIT

write_state() {
  echo "$1" > "$TMP_PROJECT/.claude/active-task.json"
}

run_hook() {
  # Run in the tmp project's CWD so git plumbing finds it.
  ( cd "$TMP_PROJECT" && CLAUDE_PROJECT_DIR="$TMP_PROJECT" '$HOOK' </dev/null 2>&1 )
}
# Use a function instead of inline so we can capture stdout reliably.
run_hook_real() {
  pushd "$TMP_PROJECT" > /dev/null
  CLAUDE_PROJECT_DIR="$TMP_PROJECT" "$HOOK" </dev/null 2>&1
  local rc=$?
  popd > /dev/null
  return $rc
}

# -----------------------------------------------------------------------------
# Test 1: no active-task.json → pass-through.
# -----------------------------------------------------------------------------
rm -f "$TMP_PROJECT/.claude/active-task.json"
OUTPUT=$(run_hook_real)
EXIT_CODE=$?
assert "no state file → pass-through exit 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
# Test 2: zero subtasks → pass-through.
# -----------------------------------------------------------------------------
write_state '{"taskId":"1","taskName":"flat","claimToken":"t","subtasks":[]}'
OUTPUT=$(run_hook_real)
EXIT_CODE=$?
assert "flat task → pass-through exit 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
# Test 3: subtasks NOT all done → pass-through.
# -----------------------------------------------------------------------------
write_state '{"taskId":"1","taskName":"X","claimToken":"t","subtasks":[{"id":"s1","status":"done"},{"id":"s2","status":"pending"}]}'
OUTPUT=$(run_hook_real)
EXIT_CODE=$?
assert "not all done → pass-through exit 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
# Test 4: all subtasks done, parent status unset → BLOCK.
# -----------------------------------------------------------------------------
write_state '{"taskId":"1","taskName":"X","claimToken":"t","subtasks":[{"id":"s1","status":"done"},{"id":"s2","status":"done"}]}'
OUTPUT=$(run_hook_real)
EXIT_CODE=$?
assert "all done + parentStatus unset → BLOCK exit 2" "$EXIT_CODE" "2"
assert_contains "BLOCK message mentions Waiting for UAT" "$OUTPUT" "Waiting for UAT"
assert_contains "BLOCK message mentions createTaskUatDoc" "$OUTPUT" "createTaskUatDoc"

# -----------------------------------------------------------------------------
# Test 5: all subtasks done, parentStatus='Waiting for UAT' → pass-through.
# -----------------------------------------------------------------------------
write_state '{"taskId":"1","taskName":"X","claimToken":"t","parentStatus":"Waiting for UAT","subtasks":[{"id":"s1","status":"done"},{"id":"s2","status":"done"}]}'
OUTPUT=$(run_hook_real)
EXIT_CODE=$?
assert "parentStatus Waiting for UAT → pass-through exit 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
# Test 6: all done + parentStatus='In Progress' → BLOCK.
# -----------------------------------------------------------------------------
write_state '{"taskId":"1","taskName":"X","claimToken":"t","parentStatus":"In Progress","subtasks":[{"id":"s1","status":"done"},{"id":"s2","status":"done"}]}'
OUTPUT=$(run_hook_real)
EXIT_CODE=$?
assert "parentStatus In Progress → BLOCK exit 2" "$EXIT_CODE" "2"

# -----------------------------------------------------------------------------
# Test 7: handoff-to-orchestrator escape hatch → pass-through.
# -----------------------------------------------------------------------------
write_state '{"taskId":"1","taskName":"X","claimToken":"t","reviewAddressed":"handoff-to-orchestrator","subtasks":[{"id":"s1","status":"done"},{"id":"s2","status":"done"}]}'
OUTPUT=$(run_hook_real)
EXIT_CODE=$?
assert "handoff-to-orchestrator → pass-through exit 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
# Test 8: parentStatus='Pending Deploy to Prod' → pass-through.
# -----------------------------------------------------------------------------
write_state '{"taskId":"1","taskName":"X","claimToken":"t","parentStatus":"Pending Deploy to Prod","subtasks":[{"id":"s1","status":"done"}]}'
OUTPUT=$(run_hook_real)
EXIT_CODE=$?
assert "Pending Deploy to Prod → pass-through exit 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
# Test 9: malformed JSON → pass-through (don't block when state corrupt).
# -----------------------------------------------------------------------------
echo "{ not valid json" > "$TMP_PROJECT/.claude/active-task.json"
OUTPUT=$(run_hook_real)
EXIT_CODE=$?
assert "malformed JSON → pass-through exit 0" "$EXIT_CODE" "0"

echo ""
echo "==================================================="
echo "stop-waiting-for-uat-stage tests: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "==================================================="

[ "$FAIL_COUNT" -eq 0 ]
