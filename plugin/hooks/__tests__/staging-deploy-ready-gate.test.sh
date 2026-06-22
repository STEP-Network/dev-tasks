#!/bin/bash
# Tests for plugin/hooks/staging-deploy-ready-gate.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../staging-deploy-ready-gate.sh"

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
git -C "$TMP_PROJECT" init -q 2>/dev/null
trap "rm -rf $TMP_PROJECT" EXIT

enable_hook() {
  cat > "$TMP_PROJECT/.claude/project-config.json" <<TESTCFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["staging-deploy-ready-gate"] }
}
TESTCFG
}
disable_hook() {
  cat > "$TMP_PROJECT/.claude/project-config.json" <<TESTCFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": [] }
}
TESTCFG
}
write_state() { echo "$1" > "$TMP_PROJECT/.claude/active-task.json"; }
rm_state() { rm -f "$TMP_PROJECT/.claude/active-task.json"; }

# Local/dev run: explicitly clear CI vars so the gate is NOT relaxed.
run_hook() {
  local payload="$1"
  (cd "$TMP_PROJECT" && env -u CI -u GITHUB_ACTIONS CLAUDE_PROJECT_DIR="$TMP_PROJECT" \
    sh -c "echo '$payload' | '$HOOK' 2>&1")
}
# CI run: set the named CI var.
run_hook_ci() {
  local civar="$1" payload="$2"
  (cd "$TMP_PROJECT" && env -u CI -u GITHUB_ACTIONS "$civar=true" CLAUDE_PROJECT_DIR="$TMP_PROJECT" \
    sh -c "echo '$payload' | '$HOOK' 2>&1")
}

WFUAT='{"tool_input":{"status":"Waiting for UAT","itemId":42}}'

enable_hook

# Test 1: status != Waiting for UAT → pass-through.
write_state '{"taskId":"42","stagingDeployReady":false,"claimToken":"t"}'
OUTPUT=$(run_hook '{"tool_input":{"status":"In Progress","itemId":42}}')
assert "non-WfUAT status → pass-through" "$?" "0"

# Test 2: WfUAT + stagingDeployReady:true → pass.
write_state '{"taskId":"42","stagingDeployReady":true,"claimToken":"t"}'
OUTPUT=$(run_hook "$WFUAT")
assert "WfUAT + deploy READY → pass" "$?" "0"

# Test 3: WfUAT + stagingDeployReady:false → BLOCK.
write_state '{"taskId":"42","stagingDeployReady":false,"claimToken":"t"}'
OUTPUT=$(run_hook "$WFUAT")
assert "WfUAT + deploy not READY → BLOCK" "$?" "2"
assert_contains "BLOCK mentions staging deploy" "$OUTPUT" "staging deploy not verified READY"

# Test 4: WfUAT + field absent → BLOCK (default false).
write_state '{"taskId":"42","claimToken":"t"}'
OUTPUT=$(run_hook "$WFUAT")
assert "WfUAT + field absent → BLOCK" "$?" "2"

# Test 5: WfUAT + CI=true → relaxed pass.
write_state '{"taskId":"42","stagingDeployReady":false,"claimToken":"t"}'
OUTPUT=$(run_hook_ci CI "$WFUAT")
assert "WfUAT + CI=true → relaxed pass" "$?" "0"
assert_contains "CI relax NOTE" "$OUTPUT" "relaxed — running under CI"

# Test 6: WfUAT + GITHUB_ACTIONS=true → relaxed pass.
OUTPUT=$(run_hook_ci GITHUB_ACTIONS "$WFUAT")
assert "WfUAT + GITHUB_ACTIONS=true → relaxed pass" "$?" "0"

# Test 7: WfUAT + no state file → pass (nothing to gate against).
rm_state
OUTPUT=$(run_hook "$WFUAT")
assert "WfUAT + no state file → pass" "$?" "0"

# Test 8: malformed JSON → pass-through (status empty → not WfUAT).
OUTPUT=$(run_hook 'not valid json')
assert "malformed JSON → pass-through" "$?" "0"

# Test 9: hook not enabled → pass-through even when deploy not ready.
disable_hook
write_state '{"taskId":"42","stagingDeployReady":false,"claimToken":"t"}'
OUTPUT=$(run_hook "$WFUAT")
assert "hook disabled → pass-through" "$?" "0"

echo ""
echo "==================================================="
echo "staging-deploy-ready-gate tests: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "==================================================="
[ "$FAIL_COUNT" -eq 0 ]
