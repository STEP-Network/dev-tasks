#!/usr/bin/env bash
# Tests for pre-merge-review-gate.py (the Python validator called by the hook).
#
# Exercises all 5 gate conditions + the legacy-string path.
# Does NOT require MONDAY_API_KEY — purely local JSON validation.
# The "race check" test mocks `gh` via PATH override.

set -u
shopt -s nullglob

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="$(cd "$TEST_DIR/.." && pwd)/pre-merge-review-gate.py"

[ -f "$VALIDATOR" ] || { echo "FAIL: validator not found at $VALIDATOR" >&2; exit 1; }

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1" >&2; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d -t pre-merge-gate-XXXX)"
trap 'rm -rf "$WORK"' EXIT

# Helper: run the validator and capture exit code + stderr
run_gate() {
  local state_file="$1"
  local project_root="$2"
  local pr_number="${3:-}"
  local sources="${4:-claudeBot,corridor,selfReview}"
  local output
  output=$(python3 "$VALIDATOR" "$state_file" "$project_root" "$pr_number" "$sources" 2>&1)
  local ec=$?
  echo "$output"
  return $ec
}

write_state() {
  local file="$1"
  local content="$2"
  mkdir -p "$(dirname "$file")"
  echo "$content" > "$file"
}

# -------------------------------------------------------------------
echo "==> Test 1: reviewAddressed missing → blocks merge"
STATE="$WORK/test1/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":null}'

ec=0
out=$(run_gate "$STATE" "$WORK/test1" "" "claudeBot") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q "reviewAddressed is not set"; then
  pass "missing reviewAddressed blocks with correct message"
else
  fail "expected exit 2 + message about missing field (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 2: reviewAddressed.status = 'blocker_unaddressed' → blocks"
STATE="$WORK/test2/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":{"status":"blocker_unaddressed","triagedAt":"2026-05-25T12:00:00Z","sources":{}}}'

ec=0
out=$(run_gate "$STATE" "$WORK/test2" "" "claudeBot") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q "not ready for merge"; then
  pass "blocker_unaddressed status blocks"
else
  fail "expected exit 2 for blocker_unaddressed (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 3: reviewAddressed.status = 'pending' → blocks"
STATE="$WORK/test3/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":{"status":"pending","triagedAt":"2026-05-25T12:00:00Z","sources":{}}}'

ec=0
out=$(run_gate "$STATE" "$WORK/test3" "" "claudeBot") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q "not ready for merge"; then
  pass "pending status blocks"
else
  fail "expected exit 2 for pending (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 4: triagedAt older than latest review → blocks (race gate)"
# Mock gh to return a review comment newer than triagedAt
MOCK_BIN="$WORK/test4/bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/gh" << 'MOCKEOF'
#!/bin/bash
echo '{"comments":[{"author":{"login":"claude"},"body":"## Code Review\nsome findings","createdAt":"2026-05-25T13:00:00Z"}]}'
MOCKEOF
chmod +x "$MOCK_BIN/gh"

STATE="$WORK/test4/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":{"status":"accepted","triagedAt":"2026-05-25T12:00:00Z","sources":{"claudeBot":{"commentsFound":1,"blockers":0,"improvements":0,"polish":0,"replies":[]}}}}'

ec=0
out=$(PATH="$MOCK_BIN:$PATH" run_gate "$STATE" "$WORK/test4" "42" "claudeBot") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q "OLDER than"; then
  pass "stale triagedAt blocks (race prevention)"
else
  fail "expected exit 2 for stale triage (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 5: POLISH count > 0 but replies array empty → blocks"
STATE="$WORK/test5/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":{"status":"accepted","triagedAt":"2026-05-25T14:00:00Z","sources":{"claudeBot":{"commentsFound":1,"blockers":0,"improvements":0,"polish":3,"replies":[]}}}}'

ec=0
out=$(run_gate "$STATE" "$WORK/test5" "" "claudeBot") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q "no decline replies"; then
  pass "POLISH without replies blocks"
else
  fail "expected exit 2 for POLISH without replies (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 6: All gates satisfied (structured format) → allows merge"
STATE="$WORK/test6/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":{"status":"fixed","triagedAt":"2026-05-25T14:00:00Z","sources":{"claudeBot":{"commentsFound":1,"blockers":0,"improvements":0,"polish":2,"replies":["IC_abc123"]},"corridor":{"commentsFound":0,"blockers":0,"improvements":0,"polish":0,"replies":[]}}}}'

ec=0
out=$(run_gate "$STATE" "$WORK/test6" "" "claudeBot,corridor") || ec=$?
if [ $ec -eq 0 ]; then
  pass "all gates satisfied — merge allowed"
else
  fail "expected exit 0 (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 7: Legacy string 'accepted' → allows merge"
STATE="$WORK/test7/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":"accepted"}'

ec=0
out=$(run_gate "$STATE" "$WORK/test7" "" "claudeBot") || ec=$?
if [ $ec -eq 0 ]; then
  pass "legacy 'accepted' string passes"
else
  fail "expected exit 0 for legacy accepted (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 8: Legacy string 'handoff-to-orchestrator' → allows (escape hatch)"
STATE="$WORK/test8/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":"handoff-to-orchestrator"}'

ec=0
out=$(run_gate "$STATE" "$WORK/test8" "" "claudeBot") || ec=$?
if [ $ec -eq 0 ]; then
  pass "handoff-to-orchestrator escape passes"
else
  fail "expected exit 0 for escape hatch (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 9: Legacy string 'stuck:regression-loop' → blocks"
STATE="$WORK/test9/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":"stuck:regression-loop"}'

ec=0
out=$(run_gate "$STATE" "$WORK/test9" "" "claudeBot") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q "stuck/timeout state"; then
  pass "stuck string blocks merge"
else
  fail "expected exit 2 for stuck (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 10: API unreachable (gh not found) → blocks"
STATE="$WORK/test10/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":{"status":"accepted","triagedAt":"2026-05-25T14:00:00Z","sources":{"claudeBot":{"commentsFound":1,"blockers":0,"improvements":0,"polish":0,"replies":[]}}}}'

# Use a mock gh that always fails
PYTHON_PATH=$(which python3)
MOCK_BIN="$WORK/test10/bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/gh" << 'MOCKEOF'
#!/bin/bash
exit 1
MOCKEOF
chmod +x "$MOCK_BIN/gh"

ec=0
out=$(PATH="$MOCK_BIN:$(dirname "$PYTHON_PATH")" run_gate "$STATE" "$WORK/test10" "99" "claudeBot") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q "reviews unreachable"; then
  pass "API unreachable blocks merge"
else
  fail "expected exit 2 for unreachable API (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 11: No state file → blocks at Python level"
# The shell wrapper handles this (exits 0 before calling Python), but test the Python validator directly
ec=0
out=$(run_gate "$WORK/nonexistent/active-task.json" "$WORK" "" "claudeBot") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q "cannot read"; then
  pass "missing file blocks at Python level (shell wrapper would exit 0 first)"
else
  fail "expected exit 2 from Python for missing file (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 12: Unconfigured source with POLISH is ignored"
STATE="$WORK/test12/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":{"status":"accepted","triagedAt":"2026-05-25T14:00:00Z","sources":{"vercelAgent":{"commentsFound":1,"blockers":0,"improvements":0,"polish":5,"replies":[]},"claudeBot":{"commentsFound":1,"blockers":0,"improvements":0,"polish":0,"replies":[]}}}}'

# Only claudeBot is configured — vercelAgent's missing replies should NOT block
ec=0
out=$(run_gate "$STATE" "$WORK/test12" "" "claudeBot") || ec=$?
if [ $ec -eq 0 ]; then
  pass "unconfigured source POLISH is ignored"
else
  fail "expected exit 0 when POLISH source is not configured (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 13: localReview POLISH with declinedInPrBody → allows merge (v0.28.0)"
STATE="$WORK/test13/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":{"status":"fixed","triagedAt":"2026-05-25T14:00:00Z","sources":{"localReview":{"blockers":0,"improvements":1,"polish":2,"replies":[],"declinedInPrBody":true,"lenses":["correctness","security"],"rounds":2}}}}'

ec=0
out=$(run_gate "$STATE" "$WORK/test13" "" "localReview") || ec=$?
if [ $ec -eq 0 ]; then
  pass "localReview POLISH + declinedInPrBody allowed"
else
  fail "expected exit 0 for localReview declinedInPrBody (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 14: localReview POLISH without declinedInPrBody or replies → blocks"
STATE="$WORK/test14/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":{"status":"fixed","triagedAt":"2026-05-25T14:00:00Z","sources":{"localReview":{"blockers":0,"improvements":0,"polish":1,"replies":[]}}}}'

ec=0
out=$(run_gate "$STATE" "$WORK/test14" "" "localReview") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q "declinedInPrBody"; then
  pass "localReview POLISH without decline record blocks"
else
  fail "expected exit 2 with declinedInPrBody hint (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 15: localReview POLISH with non-empty replies → allows (replies also valid)"
STATE="$WORK/test15/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":{"status":"fixed","triagedAt":"2026-05-25T14:00:00Z","sources":{"localReview":{"blockers":0,"improvements":0,"polish":1,"replies":["IC_xyz789"]}}}}'

ec=0
out=$(run_gate "$STATE" "$WORK/test15" "" "localReview") || ec=$?
if [ $ec -eq 0 ]; then
  pass "localReview POLISH with replies allowed"
else
  fail "expected exit 0 for localReview with replies (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo "==> Test 16: declinedInPrBody is NAME-GATED — claudeBot cannot use it to bypass"
STATE="$WORK/test16/active-task.json"
write_state "$STATE" '{"taskId":"123","reviewAddressed":{"status":"fixed","triagedAt":"2026-05-25T14:00:00Z","sources":{"claudeBot":{"commentsFound":1,"blockers":0,"improvements":0,"polish":1,"replies":[],"declinedInPrBody":true}}}}'

ec=0
out=$(run_gate "$STATE" "$WORK/test16" "" "claudeBot") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q "no decline replies"; then
  pass "claudeBot declinedInPrBody does NOT bypass (localReview-only escape)"
else
  fail "expected exit 2 — declinedInPrBody must not help non-localReview sources (got ec=$ec, out=$out)"
fi

# -------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
