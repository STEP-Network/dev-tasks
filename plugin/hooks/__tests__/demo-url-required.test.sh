#!/bin/bash
# Tests for .claude/hooks/demo-url-required.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../demo-url-required.sh"

# Set up a temp project-config that enables this hook (the plugin's hook_enabled
# opt-in pattern would otherwise return exit 0 immediately).
TEST_PROJECT_DIR=$(mktemp -d -t demo-url-required-test-XXXX)
mkdir -p "$TEST_PROJECT_DIR/.claude/cache"
cat > "$TEST_PROJECT_DIR/.claude/project-config.json" <<TESTCFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["demo-url-required"] }
}
TESTCFG
export CLAUDE_PROJECT_DIR="$TEST_PROJECT_DIR"
[ ! -x "$HOOK" ] && { echo "FATAL: hook not executable"; exit 1; }

PASS_COUNT=0
FAIL_COUNT=0

assert() {
  if [ "$2" = "$3" ]; then
    echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL: $1 (expected '$3', got '$2')"; FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}
assert_contains() {
  if echo "$2" | grep -qF "$3"; then
    echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL: $1 (needle '$3' missing)"; FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

TMP_PROJECT=$(mktemp -d)
mkdir -p "$TMP_PROJECT/.claude"

# Enable this hook in the test project config (plugin's opt-in gate).
cat > "$TMP_PROJECT/.claude/project-config.json" <<TESTCFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["demo-url-required"] }
}
TESTCFG
git -C "$TMP_PROJECT" init -q 2>/dev/null
trap "rm -rf $TMP_PROJECT" EXIT

write_state() { echo "$1" > "$TMP_PROJECT/.claude/active-task.json"; }

run_hook() {
  local payload="$1"
  (cd "$TMP_PROJECT" && CLAUDE_PROJECT_DIR="$TMP_PROJECT" sh -c "echo '$payload' | '$HOOK' 2>&1")
}

# Test 1: status != Waiting for UAT → pass-through.
OUTPUT=$(run_hook '{"tool_input":{"status":"In Progress","itemId":1}}')
assert "non-WaitingForUAT status → pass-through" "$?" "0"

# Test 2: Waiting for UAT with NO demoUrl + no state file → BLOCK.
rm -f "$TMP_PROJECT/.claude/active-task.json"
OUTPUT=$(run_hook '{"tool_input":{"status":"Waiting for UAT","itemId":1}}')
assert "WfUAT + no demoUrl → BLOCK" "$?" "2"
assert_contains "BLOCK mentions demoUrl required" "$OUTPUT" "demoUrl is required"

# Test 3: Waiting for UAT with Vercel preview URL → pass.
OUTPUT=$(run_hook '{"tool_input":{"status":"Waiting for UAT","demoUrl":"https://abc.vercel.app","itemId":1}}')
assert "WfUAT + vercel.app demoUrl → pass" "$?" "0"

# Test 4: Waiting for UAT with test.polads.eu → pass.
OUTPUT=$(run_hook '{"tool_input":{"status":"Waiting for UAT","demoUrl":"https://test.polads.eu/some/path","itemId":1}}')
assert "WfUAT + test.polads.eu → pass" "$?" "0"

# Test 5: Waiting for UAT with invalid demoUrl (localhost) → BLOCK.
OUTPUT=$(run_hook '{"tool_input":{"status":"Waiting for UAT","demoUrl":"http://localhost:3000","itemId":1}}')
assert "WfUAT + localhost demoUrl → BLOCK" "$?" "2"
assert_contains "BLOCK mentions configured pattern" "$OUTPUT" "previewUrlPattern"

# Test 6: Waiting for UAT with demoUrl in active-task.json previewUrl mirror → pass.
write_state '{"taskId":"1","previewUrl":"https://foo-bar.vercel.app","claimToken":"t"}'
OUTPUT=$(run_hook '{"tool_input":{"status":"Waiting for UAT","itemId":1}}')
assert "WfUAT + previewUrl mirror → pass" "$?" "0"

# Test 7: Waiting for UAT with invalid demoUrl arg overrides valid mirror → BLOCK.
write_state '{"taskId":"1","previewUrl":"https://foo.vercel.app","claimToken":"t"}'
OUTPUT=$(run_hook '{"tool_input":{"status":"Waiting for UAT","demoUrl":"http://bad","itemId":1}}')
assert "WfUAT + bad arg overrides mirror → BLOCK" "$?" "2"

# Test 8: malformed JSON → pass-through (fail-open).
OUTPUT=$(run_hook 'not valid json')
assert "malformed JSON → pass-through" "$?" "0"

# Test 9: Waiting for UAT with custom polads.eu subdomain → pass.
OUTPUT=$(run_hook '{"tool_input":{"status":"Waiting for UAT","demoUrl":"https://preview-123.polads.eu","itemId":1}}')
assert "WfUAT + custom polads.eu → pass" "$?" "0"

echo ""
echo "==================================================="
echo "demo-url-required tests: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "==================================================="
[ "$FAIL_COUNT" -eq 0 ]
