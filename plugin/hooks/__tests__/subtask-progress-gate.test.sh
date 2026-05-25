#!/bin/bash
# Tests for .claude/hooks/subtask-progress-gate.sh
#
# Strategy: write a synthetic active-task.json into a temp CLAUDE_PROJECT_DIR,
# feed the hook a `git push` Bash payload, and assert exit codes + messages.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../subtask-progress-gate.sh"

# Set up a temp project-config that enables this hook (the plugin's hook_enabled
# opt-in pattern would otherwise return exit 0 immediately).
TEST_PROJECT_DIR=$(mktemp -d -t subtask-progress-gate-test-XXXX)
mkdir -p "$TEST_PROJECT_DIR/.claude/cache"
cat > "$TEST_PROJECT_DIR/.claude/project-config.json" <<TESTCFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["subtask-progress-gate"] }
}
TESTCFG
export CLAUDE_PROJECT_DIR="$TEST_PROJECT_DIR"

if [ ! -x "$HOOK" ]; then
  echo "FATAL: hook not found or not executable at $HOOK"
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

# Build a tmp project with active-task.json.
TMP_PROJECT=$(mktemp -d)
mkdir -p "$TMP_PROJECT/.claude"

# Enable this hook in the test project config (plugin's opt-in gate).
cat > "$TMP_PROJECT/.claude/project-config.json" <<TESTCFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["subtask-progress-gate"] }
}
TESTCFG

cleanup() {
  rm -rf "$TMP_PROJECT"
}
trap cleanup EXIT

write_state() {
  local content="$1"
  echo "$content" > "$TMP_PROJECT/.claude/active-task.json"
}

run_hook() {
  local cmd="$1"
  CLAUDE_PROJECT_DIR="$TMP_PROJECT" sh -c "echo '{\"tool_input\":{\"command\":\"$cmd\"}}' | '$HOOK' 2>&1"
  return $?
}

# -----------------------------------------------------------------------------
# Test 1: no active-task.json → pass-through.
# -----------------------------------------------------------------------------
rm -f "$TMP_PROJECT/.claude/active-task.json"
OUTPUT=$(run_hook "git push origin foo")
EXIT_CODE=$?
assert "no state file → pass-through exit 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
# Test 2: zero subtasks → pass-through (flat task case).
# -----------------------------------------------------------------------------
write_state '{"taskId":"1","taskName":"flat","claimToken":"t","subtasks":[]}'
OUTPUT=$(run_hook "git push origin foo")
EXIT_CODE=$?
assert "zero subtasks → pass-through exit 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
# Test 3: subtasks exist, NONE done with hours → BLOCK.
# -----------------------------------------------------------------------------
write_state '{"taskId":"1","taskName":"X","claimToken":"t","subtasks":[{"id":"s1","name":"sub1","status":"in_progress"},{"id":"s2","name":"sub2","status":"pending"}]}'
OUTPUT=$(run_hook "git push origin foo")
EXIT_CODE=$?
assert "no done-with-hours subtasks → BLOCK exit 2" "$EXIT_CODE" "2"
assert_contains "BLOCK message mentions actualHours" "$OUTPUT" "actualHours"
assert_contains "BLOCK message mentions /log-progress" "$OUTPUT" "/log-progress"

# -----------------------------------------------------------------------------
# Test 4: at least one subtask Done with actualHours > 0 → pass-through.
# -----------------------------------------------------------------------------
write_state '{"taskId":"1","taskName":"X","claimToken":"t","subtasks":[{"id":"s1","name":"sub1","status":"done","actualHours":1.5},{"id":"s2","name":"sub2","status":"pending"}]}'
OUTPUT=$(run_hook "git push origin foo")
EXIT_CODE=$?
assert "at least one done-with-hours → pass-through exit 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
# Test 5: subtask Done but actualHours = 0 → BLOCK (not really done).
# -----------------------------------------------------------------------------
write_state '{"taskId":"1","taskName":"X","claimToken":"t","subtasks":[{"id":"s1","name":"sub1","status":"done","actualHours":0}]}'
OUTPUT=$(run_hook "git push origin foo")
EXIT_CODE=$?
assert "done with 0 hours → BLOCK exit 2" "$EXIT_CODE" "2"

# -----------------------------------------------------------------------------
# Test 6: escape hatch allowPushWithoutSubtaskProgress → pass-through.
# -----------------------------------------------------------------------------
write_state '{"taskId":"1","taskName":"X","claimToken":"t","allowPushWithoutSubtaskProgress":true,"subtasks":[{"id":"s1","name":"sub1","status":"pending"}]}'
OUTPUT=$(run_hook "git push origin foo")
EXIT_CODE=$?
assert "escape hatch → pass-through exit 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
# Test 7: non-git-push command → pass-through (defensive).
# -----------------------------------------------------------------------------
write_state '{"taskId":"1","taskName":"X","claimToken":"t","subtasks":[{"id":"s1","name":"sub1","status":"pending"}]}'
OUTPUT=$(run_hook "git status")
EXIT_CODE=$?
assert "non-git-push → pass-through exit 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
# Test 8: malformed JSON → pass-through (don't block when state corrupt).
# -----------------------------------------------------------------------------
echo "{ not valid json" > "$TMP_PROJECT/.claude/active-task.json"
OUTPUT=$(run_hook "git push origin foo")
EXIT_CODE=$?
assert "malformed JSON → pass-through exit 0" "$EXIT_CODE" "0"

echo ""
echo "==================================================="
echo "subtask-progress-gate tests: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "==================================================="

[ "$FAIL_COUNT" -eq 0 ]
