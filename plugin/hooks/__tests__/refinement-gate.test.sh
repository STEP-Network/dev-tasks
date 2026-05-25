#!/bin/bash
# Tests for .claude/hooks/refinement-gate.sh
#
# Strategy: stub MONDAY_API_KEY + curl so we control the Monday response. The
# hook reads tool args from stdin and emits exit 2 + a BLOCKED: message on
# stderr for each failure mode.
#
# Run with: bash .claude/hooks/__tests__/refinement-gate.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../refinement-gate.sh"

if [ ! -x "$HOOK" ]; then
  echo "FATAL: hook not found or not executable at $HOOK"
  exit 1
fi

# Force a stable cache path (the hook reads .claude/cache/monday-board-map.json).
# Tests run from the repo root so the relative path resolves correctly.
# Set up a temp project-config that enables this hook (the plugin's hook_enabled
# opt-in pattern would otherwise return exit 0 immediately).
TEST_PROJECT_DIR=$(mktemp -d -t refinement-gate-test-XXXX)
mkdir -p "$TEST_PROJECT_DIR/.claude/cache"
cat > "$TEST_PROJECT_DIR/.claude/project-config.json" <<TESTCFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["refinement-gate"] }
}
TESTCFG
export CLAUDE_PROJECT_DIR="$TEST_PROJECT_DIR"

# Stub MONDAY_API_KEY so the hook doesn't bail out early.
export MONDAY_API_KEY="test-token-NEVER-USED-curl-is-stubbed"

PASS_COUNT=0
FAIL_COUNT=0

# Stub curl by prepending a temp directory containing a `curl` script that
# echoes a JSON response from $CURL_FIXTURE env var.
STUB_DIR=$(mktemp -d)
cat > "$STUB_DIR/curl" <<'STUB'
#!/bin/bash
# Stub curl. Returns $CURL_FIXTURE as the response body.
echo "$CURL_FIXTURE"
STUB
chmod +x "$STUB_DIR/curl"
export PATH="$STUB_DIR:$PATH"

cleanup() {
  rm -rf "$STUB_DIR" "$TEST_PROJECT_DIR"
}
trap cleanup EXIT

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

run_hook() {
  local task_id="$1"
  local fixture="$2"
  CURL_FIXTURE="$fixture" sh -c "echo '{\"tool_input\":{\"itemId\":$task_id}}' | '$HOOK' 2>&1"
  return $?
}

# -----------------------------------------------------------------------------
# Test 1: BLOCK_BUG — task lives on Bugs Queue board.
# -----------------------------------------------------------------------------
FIXTURE_BUG='{"data":{"items":[{"id":"123","name":"a bug","board":{"id":"5091706353"},"column_values":[],"subitems":[]}]}}'
OUTPUT=$(run_hook 123 "$FIXTURE_BUG")
EXIT_CODE=$?
assert "BLOCK_BUG exit code 2" "$EXIT_CODE" "2"
assert_contains "BLOCK_BUG message mentions convertBugToTask" "$OUTPUT" "convertBugToTask"

# -----------------------------------------------------------------------------
# Test 2: BLOCK_REFINEMENT — task missing type / priority / epic / desc / AC.
# -----------------------------------------------------------------------------
FIXTURE_NO_TYPE='{"data":{"items":[{"id":"123","name":"x","board":{"id":"5091706356"},"column_values":[{"id":"priority","text":"High"},{"id":"long_text","text":"'"$(printf 'x%.0s' {1..250})"'"},{"id":"long_text_mkqnf3aw","text":"AC text"}],"subitems":[]}]}}'
OUTPUT=$(run_hook 123 "$FIXTURE_NO_TYPE")
EXIT_CODE=$?
assert "BLOCK_REFINEMENT (no type) exit code 2" "$EXIT_CODE" "2"
assert_contains "BLOCK_REFINEMENT message mentions /refine-task" "$OUTPUT" "/refine-task"
assert_contains "BLOCK_REFINEMENT message mentions 'type'" "$OUTPUT" "type"

# -----------------------------------------------------------------------------
# Test 3: BLOCK_NO_SUBTASKS — task is fully refined but no subtasks.
# -----------------------------------------------------------------------------
LONG_DESC=$(printf 'x%.0s' {1..250})
FIXTURE_NO_SUBS='{"data":{"items":[{"id":"123","name":"x","board":{"id":"5091706356"},"column_values":[{"id":"color_mksbm5er","text":"Improvement"},{"id":"priority","text":"High"},{"id":"board_relation_x","text":"Epic Name"},{"id":"long_text","text":"'"$LONG_DESC"'"},{"id":"long_text_mkqnf3aw","text":"AC content here"}],"subitems":[]}]}}'
OUTPUT=$(run_hook 123 "$FIXTURE_NO_SUBS")
EXIT_CODE=$?
assert "BLOCK_NO_SUBTASKS exit code 2" "$EXIT_CODE" "2"
assert_contains "BLOCK_NO_SUBTASKS message mentions zero subtasks" "$OUTPUT" "zero subtasks"

# -----------------------------------------------------------------------------
# Test 4: BLOCK_SUBTASKS — subtasks exist but lack type/desc/hours.
# -----------------------------------------------------------------------------
FIXTURE_BAD_SUBS='{"data":{"items":[{"id":"123","name":"x","board":{"id":"5091706356"},"column_values":[{"id":"color_mksbm5er","text":"Improvement"},{"id":"priority","text":"High"},{"id":"board_relation_x","text":"Epic"},{"id":"long_text","text":"'"$LONG_DESC"'"},{"id":"long_text_mkqnf3aw","text":"AC"}],"subitems":[{"id":"s1","name":"halfbaked sub","column_values":[{"id":"color_x","text":""},{"id":"long_text","text":""},{"id":"numeric_x","text":""}]}]}]}}'
OUTPUT=$(run_hook 123 "$FIXTURE_BAD_SUBS")
EXIT_CODE=$?
assert "BLOCK_SUBTASKS exit code 2" "$EXIT_CODE" "2"
assert_contains "BLOCK_SUBTASKS message names refinement" "$OUTPUT" "refinement metadata"

# -----------------------------------------------------------------------------
# Test 5: PASS — fully refined task on the Tasks board.
# -----------------------------------------------------------------------------
FIXTURE_PASS='{"data":{"items":[{"id":"123","name":"good","board":{"id":"5091706356"},"column_values":[{"id":"color_mksbm5er","text":"Improvement"},{"id":"priority","text":"High"},{"id":"board_relation_x","text":"Epic"},{"id":"long_text","text":"'"$LONG_DESC"'"},{"id":"long_text_mkqnf3aw","text":"AC"}],"subitems":[{"id":"s1","name":"sub","column_values":[{"id":"color_a","text":"Backend"},{"id":"long_text","text":"do the thing"},{"id":"numeric_h","text":"1.5"}]}]}]}}'
OUTPUT=$(run_hook 123 "$FIXTURE_PASS")
EXIT_CODE=$?
assert "PASS case exit code 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
# Test 6: pass-through when curl returns empty (Monday unreachable).
# -----------------------------------------------------------------------------
OUTPUT=$(run_hook 123 "")
EXIT_CODE=$?
assert "Monday unreachable pass-through exit code 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
# Test 7: pass-through when MONDAY_API_KEY missing.
# -----------------------------------------------------------------------------
OUTPUT=$(MONDAY_API_KEY="" CURL_FIXTURE="$FIXTURE_PASS" sh -c "echo '{\"tool_input\":{\"itemId\":123}}' | '$HOOK' 2>&1")
EXIT_CODE=$?
assert "No token pass-through exit code 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
# Test 8: malformed tool_input.itemId pass-through.
# -----------------------------------------------------------------------------
OUTPUT=$(CURL_FIXTURE="$FIXTURE_PASS" sh -c "echo '{\"tool_input\":{\"itemId\":\"not-numeric\"}}' | '$HOOK' 2>&1")
EXIT_CODE=$?
assert "Malformed itemId pass-through exit code 0" "$EXIT_CODE" "0"

# -----------------------------------------------------------------------------
echo ""
echo "==================================================="
echo "refinement-gate tests: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "==================================================="

[ "$FAIL_COUNT" -eq 0 ]
