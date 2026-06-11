#!/bin/bash
# Tests for plugin/hooks/protect-active-task-state.sh
#
# Strategy: spin up a temp git repo + active-task.json, feed simulated
# PreToolUse Edit/Write/MultiEdit payloads via stdin, assert exit code
# (0 = allow, 2 = block) and that block messages reference the right field.
#
# Run with: bash plugin/hooks/__tests__/protect-active-task-state.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../protect-active-task-state.sh"

if [ ! -x "$HOOK" ]; then
  echo "FATAL: hook not found or not executable at $HOOK"
  exit 1
fi

PASS=0
FAIL=0

# Set up a temp git repo + active-task.json + project-config enabling the hook.
TEST_DIR=$(mktemp -d -t protect-task-state-XXXX)
mkdir -p "$TEST_DIR/.claude"
cd "$TEST_DIR"
git init --quiet
git config user.email "test@example.com"
git config user.name "test"
echo "init" > seed.txt
git add seed.txt
git commit --quiet -m "init"
HEAD_SHA=$(git rev-parse HEAD)

cat > "$TEST_DIR/.claude/project-config.json" <<CFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["protect-active-task-state"] }
}
CFG

# Baseline active-task.json
write_baseline() {
  cat > "$TEST_DIR/.claude/active-task.json" <<JSON
{
  "taskId": "111",
  "taskName": "test task",
  "claimToken": "tok",
  "branch": "feat/test",
  "selfReviewPassed": false,
  "selfReviewPassedAt": null,
  "mondayReconciledShas": []
}
JSON
}

export CLAUDE_PROJECT_DIR="$TEST_DIR"

# Cleanup markers between cases.
clean_markers() { rm -f /tmp/.claude-state-marker-*-"$HEAD_SHA"; }

# Build a PreToolUse payload for Edit/Write/MultiEdit.
# Usage: make_payload TOOL FILE_PATH BODY_JSON
make_payload() {
  python3 -c "
import json, sys
print(json.dumps({
  'tool_name': '$1',
  'tool_input': json.loads(sys.argv[1]),
}))
" "$3" | sed "s|@FILE@|$2|g"
}

# Test runner: name + expected exit + payload-on-stdin
run_test() {
  local name="$1"
  local expect_exit="$2"
  local payload="$3"
  local stderr_grep="${4:-}"

  local actual_stderr
  actual_stderr=$(echo "$payload" | bash "$HOOK" 2>&1 >/dev/null)
  local actual_exit=$?

  local ok=true
  if [ "$actual_exit" != "$expect_exit" ]; then
    ok=false
  fi
  if [ -n "$stderr_grep" ] && ! echo "$actual_stderr" | grep -q "$stderr_grep"; then
    ok=false
  fi

  if $ok; then
    echo "  PASS: $name"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $name (expected exit=$expect_exit, got=$actual_exit)"
    if [ -n "$stderr_grep" ]; then
      echo "         expected stderr to contain: $stderr_grep"
    fi
    echo "         got stderr: $actual_stderr"
    FAIL=$((FAIL+1))
  fi
}

STATE_FILE="$TEST_DIR/.claude/active-task.json"

# ============================================================
# selfReviewPassed
# ============================================================
echo "## selfReviewPassed"

write_baseline
clean_markers
PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'tool_name': 'Edit',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'old_string': '\"selfReviewPassed\": false',
    'new_string': '\"selfReviewPassed\": true',
  },
}))
")
run_test "selfReviewPassed false→true without marker → BLOCK" 2 "$PAYLOAD" "selfReviewPassed"

write_baseline
clean_markers
touch "/tmp/.claude-state-marker-selfReviewPassed-$HEAD_SHA"
run_test "selfReviewPassed false→true with marker → PASS" 0 "$PAYLOAD"

write_baseline
clean_markers
touch "/tmp/.claude-state-marker-selfReviewPassed-DIFFERENT_SHA"
run_test "selfReviewPassed marker for different SHA → BLOCK (stale)" 2 "$PAYLOAD" "selfReviewPassed"

# ============================================================
# reviewAddressed
# ============================================================
echo "## reviewAddressed"

write_baseline
clean_markers
PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'tool_name': 'Edit',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'old_string': '\"mondayReconciledShas\": []',
    'new_string': '\"mondayReconciledShas\": [],\n  \"reviewAddressed\": \"handoff-to-orchestrator\"',
  },
}))
")
run_test "reviewAddressed set without marker → BLOCK" 2 "$PAYLOAD" "reviewAddressed"

write_baseline
clean_markers
touch "/tmp/.claude-state-marker-reviewAddressed-$HEAD_SHA"
run_test "reviewAddressed set with marker → PASS" 0 "$PAYLOAD"

# ============================================================
# parentStatus
# ============================================================
echo "## parentStatus"

write_baseline
clean_markers
PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'tool_name': 'Edit',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'old_string': '\"mondayReconciledShas\": []',
    'new_string': '\"mondayReconciledShas\": [],\n  \"parentStatus\": \"Waiting for UAT\"',
  },
}))
")
run_test "parentStatus='Waiting for UAT' without marker → BLOCK" 2 "$PAYLOAD" "parentStatus"

write_baseline
clean_markers
touch "/tmp/.claude-state-marker-parentStatus-$HEAD_SHA"
run_test "parentStatus='Waiting for UAT' with marker → PASS" 0 "$PAYLOAD"

# parentStatus other values shouldn't trigger
write_baseline
clean_markers
PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'tool_name': 'Edit',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'old_string': '\"mondayReconciledShas\": []',
    'new_string': '\"mondayReconciledShas\": [],\n  \"parentStatus\": \"In Progress\"',
  },
}))
")
run_test "parentStatus='In Progress' (non-bypass) → PASS" 0 "$PAYLOAD"

# ============================================================
# mondayReconciledShas
# ============================================================
echo "## mondayReconciledShas"

write_baseline
clean_markers
PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'tool_name': 'Edit',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'old_string': '\"mondayReconciledShas\": []',
    'new_string': '\"mondayReconciledShas\": [\"abc1234\"]',
  },
}))
")
run_test "mondayReconciledShas append without marker → BLOCK" 2 "$PAYLOAD" "mondayReconciledShas"

write_baseline
clean_markers
touch "/tmp/.claude-state-marker-mondayReconciledShas-$HEAD_SHA"
run_test "mondayReconciledShas append with marker → PASS" 0 "$PAYLOAD"

# ============================================================
# allowMainCheckout (NO marker bypass)
# ============================================================
echo "## allowMainCheckout"

write_baseline
clean_markers
PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'tool_name': 'Edit',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'old_string': '\"mondayReconciledShas\": []',
    'new_string': '\"mondayReconciledShas\": [],\n  \"allowMainCheckout\": true',
  },
}))
")
run_test "allowMainCheckout=true without marker → BLOCK" 2 "$PAYLOAD" "allowMainCheckout"

# Even with marker present, allowMainCheckout still blocks.
touch "/tmp/.claude-state-marker-allowMainCheckout-$HEAD_SHA"
run_test "allowMainCheckout=true WITH marker → still BLOCK (no marker path)" 2 "$PAYLOAD" "allowMainCheckout"

# ============================================================
# ciGate (v0.26.0)
# ============================================================
echo "## ciGate"

write_baseline
clean_markers
PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'tool_name': 'Edit',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'old_string': '\"mondayReconciledShas\": []',
    'new_string': '\"mondayReconciledShas\": [],\n  \"ciGate\": \"Skip (agent)\"',
  },
}))
")
run_test "ciGate → 'Skip (agent)' without marker → BLOCK" 2 "$PAYLOAD" "ciGate"

write_baseline
clean_markers
touch "/tmp/.claude-state-marker-ciGate-$HEAD_SHA"
run_test "ciGate → 'Skip (agent)' with marker → PASS" 0 "$PAYLOAD"

write_baseline
clean_markers
PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'tool_name': 'Edit',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'old_string': '\"mondayReconciledShas\": []',
    'new_string': '\"mondayReconciledShas\": [],\n  \"ciGate\": \"Skip (human)\"',
  },
}))
")
run_test "ciGate → 'Skip (human)' without marker → BLOCK" 2 "$PAYLOAD" "ciGate"

# Reverting to Full never needs a marker (tightening is always allowed).
cat > "$STATE_FILE" <<JSON
{
  "taskId": "111",
  "taskName": "test task",
  "claimToken": "tok",
  "branch": "feat/test",
  "selfReviewPassed": false,
  "selfReviewPassedAt": null,
  "mondayReconciledShas": [],
  "ciGate": "Skip (agent)"
}
JSON
clean_markers
PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'tool_name': 'Edit',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'old_string': '\"ciGate\": \"Skip (agent)\"',
    'new_string': '\"ciGate\": \"Full\"',
  },
}))
")
run_test "ciGate Skip → Full without marker → PASS (tightening)" 0 "$PAYLOAD"

# Same Skip value rewritten unchanged → no transition → pass.
cat > "$STATE_FILE" <<JSON
{
  "taskId": "111",
  "taskName": "test task",
  "claimToken": "tok",
  "branch": "feat/test",
  "selfReviewPassed": false,
  "selfReviewPassedAt": null,
  "mondayReconciledShas": [],
  "ciGate": "Skip (human)"
}
JSON
clean_markers
PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'tool_name': 'Edit',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'old_string': '\"taskName\": \"test task\"',
    'new_string': '\"taskName\": \"renamed\"',
  },
}))
")
run_test "unrelated edit while ciGate already Skip → PASS (no transition)" 0 "$PAYLOAD"

# ============================================================
# Non-protected field edits pass through
# ============================================================
echo "## non-protected fields"

write_baseline
clean_markers
PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'tool_name': 'Edit',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'old_string': '\"taskName\": \"test task\"',
    'new_string': '\"taskName\": \"renamed task\"',
  },
}))
")
run_test "Edit non-protected field (taskName) → PASS" 0 "$PAYLOAD"

# ============================================================
# Edits on other files pass through
# ============================================================
echo "## non-active-task.json files"

PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'tool_name': 'Write',
  'tool_input': {
    'file_path': '$TEST_DIR/some-other-file.json',
    'content': '{\"selfReviewPassed\": true}',
  },
}))
")
run_test "Write on unrelated file → PASS" 0 "$PAYLOAD"

# ============================================================
# Hook disabled (not in hooks.enabled[]) → silent pass
# ============================================================
echo "## hook disabled"

cat > "$TEST_DIR/.claude/project-config.json" <<CFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["other-hook"] }
}
CFG

write_baseline
clean_markers
PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'tool_name': 'Edit',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'old_string': '\"selfReviewPassed\": false',
    'new_string': '\"selfReviewPassed\": true',
  },
}))
")
run_test "hook disabled — bypass attempt → PASS (silent)" 0 "$PAYLOAD"

# Restore enabled config
cat > "$TEST_DIR/.claude/project-config.json" <<CFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": ["protect-active-task-state"] }
}
CFG

# ============================================================
# Write (full content) on active-task.json
# ============================================================
echo "## Write tool"

write_baseline
clean_markers
PAYLOAD=$(python3 -c "
import json
new = {
  'taskId': '111',
  'taskName': 'test task',
  'claimToken': 'tok',
  'branch': 'feat/test',
  'selfReviewPassed': True,
  'selfReviewPassedAt': '2026-05-28T12:00:00Z',
  'mondayReconciledShas': [],
}
print(json.dumps({
  'tool_name': 'Write',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'content': json.dumps(new),
  },
}))
")
run_test "Write full content with selfReviewPassed:true, no marker → BLOCK" 2 "$PAYLOAD" "selfReviewPassed"

# ============================================================
# MultiEdit
# ============================================================
echo "## MultiEdit"

write_baseline
clean_markers
PAYLOAD=$(python3 -c "
import json
print(json.dumps({
  'tool_name': 'MultiEdit',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'edits': [
      {'old_string': '\"taskName\": \"test task\"', 'new_string': '\"taskName\": \"renamed\"'},
      {'old_string': '\"selfReviewPassed\": false', 'new_string': '\"selfReviewPassed\": true'},
    ],
  },
}))
")
run_test "MultiEdit with one protected edit → BLOCK" 2 "$PAYLOAD" "selfReviewPassed"

# ============================================================
# Initial Write (no existing state file)
# ============================================================
echo "## initial Write (pickup-task scenario)"

rm -f "$TEST_DIR/.claude/active-task.json"
clean_markers
PAYLOAD=$(python3 -c "
import json
init = {
  'taskId': '111',
  'taskName': 'fresh',
  'claimToken': 'tok',
  'selfReviewPassed': False,
  'selfReviewPassedAt': None,
  'mondayReconciledShas': [],
}
print(json.dumps({
  'tool_name': 'Write',
  'tool_input': {
    'file_path': '$STATE_FILE',
    'content': json.dumps(init),
  },
}))
")
run_test "initial Write with selfReviewPassed:false → PASS" 0 "$PAYLOAD"

# Cleanup
cd /
rm -rf "$TEST_DIR"
clean_markers
rm -f /tmp/.claude-state-marker-*-DIFFERENT_SHA

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
