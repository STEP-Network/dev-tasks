#!/bin/bash
# Tests for plugin/hooks/stop-task-logic.py — focus on the Stage-3 previewUrl
# gate and its CI bypass (2026-05-31).
#
# Strategy: drive the Python helper DIRECTLY with its three positional args
#   argv[1] = STATE_FILE, argv[2] = PROJECT_ROOT, argv[3] = COMBINED_CHANGES
# rather than through stop-task-check.sh. This isolates the stage logic from the
# shell wrapper's git/config-reader/`gh` plumbing and makes the assertions
# deterministic on any machine (CI or local).
#
# Stage 2 ("PR must exist") calls `gh pr view`, whose result is non-deterministic
# in a test env. The helper accepts a `prUrl` field in the state file as a
# documented fallback when gh is unavailable — every state file below that needs
# to reach Stage 3+ sets "prUrl" so Stage 2 passes regardless of gh.
#
# CI env control: this suite may itself run inside GitHub Actions (where
# GITHUB_ACTIONS=true / CI=true). We therefore set the env EXPLICITLY per case —
# `env GITHUB_ACTIONS=true CI=true` for the CI cases and `env -u GITHUB_ACTIONS
# -u CI` for the non-CI cases — so the outcome never depends on the ambient env.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGIC="$SCRIPT_DIR/../stop-task-logic.py"

[ -f "$LOGIC" ] || { echo "FATAL: stop-task-logic.py not found at $LOGIC"; exit 1; }

PASS_COUNT=0
FAIL_COUNT=0

assert() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1));
  else echo "FAIL: $1 (expected '$3', got '$2')"; FAIL_COUNT=$((FAIL_COUNT + 1)); fi
}
assert_contains() {
  if echo "$2" | grep -qF "$3"; then echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1));
  else echo "FAIL: $1 (needle '$3' missing)"; echo "  output: $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); fi
}

TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT
STATE="$TMP/active-task.json"
PROJECT_ROOT="$TMP"

# Resolve python3 to an absolute path so tests that scrub PATH (to hide `gh`)
# don't accidentally lose the interpreter too.
PY3="$(command -v python3)"
[ -n "$PY3" ] || { echo "FATAL: python3 not found on PATH"; exit 1; }

# A stub `gh` that always exits non-zero, on a dir we prepend to PATH for the
# Stage-2 test. This makes `gh pr view` deterministically "fail" (pr_exists=False)
# without clobbering the rest of PATH (so python3 etc. still resolve).
STUB_BIN="$TMP/stubbin"
mkdir -p "$STUB_BIN"
printf '#!/bin/sh\nexit 1\n' > "$STUB_BIN/gh"
chmod +x "$STUB_BIN/gh"

write_state() { printf '%s' "$1" > "$STATE"; }

# Run the helper with CI env FORCED ON. $1 = COMBINED_CHANGES.
# NOTE: all `env` option flags (-u) MUST precede NAME=value assignments — BSD
# (macOS) env rejects flags that come after an assignment.
run_ci() {
  env GITHUB_ACTIONS=true CI=true "$PY3" "$LOGIC" "$STATE" "$PROJECT_ROOT" "$1" 2>&1
}
# Run the helper with CI env FORCED OFF (both signals cleared).
run_local() {
  env -u GITHUB_ACTIONS -u CI "$PY3" "$LOGIC" "$STATE" "$PROJECT_ROOT" "$1" 2>&1
}

# State that has passed Stages 1+2 (selfReviewPassed + prUrl present) but has NO
# previewUrl — the exact state an autonomous-loop CI runner lands in at Stage 3.
STATE_NO_PREVIEW='{"taskId":"1","taskName":"CI task","claimToken":"t","selfReviewPassed":true,"prUrl":"https://github.com/o/r/pull/1"}'

# --- Stage-4 (CI bucket) test harness -----------------------------------------
# A stub `gh` that emits a controllable bucket JSON for `pr checks --json
# name,bucket` (read from $GH_CHECKS_JSON) and an OPEN state for `pr view` so
# Stage 2 passes. Prepended to PATH so it wins over a real `gh`; real PATH is
# kept so python3 still resolves.
CHECKS_STUB_BIN="$TMP/checks-stubbin"
mkdir -p "$CHECKS_STUB_BIN"
cat > "$CHECKS_STUB_BIN/gh" <<'STUB'
#!/bin/sh
case "$*" in
  *"pr checks"*) printf '%s' "$GH_CHECKS_JSON" ;;
  *"pr view"*)   printf '%s' '{"state":"OPEN"}' ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$CHECKS_STUB_BIN/gh"

# Run the helper with the bucket stub active. $1 = bucket JSON, $2 = changes.
# Non-CI env so Stage 3 is enforced (STATE_S4 below carries previewUrl to pass it).
run_with_checks() {
  env -u GITHUB_ACTIONS -u CI GH_CHECKS_JSON="$1" PATH="$CHECKS_STUB_BIN:$PATH" \
    "$PY3" "$LOGIC" "$STATE" "$PROJECT_ROOT" "$2" 2>&1
}

# State past Stages 1-3 (selfReview + prUrl + previewUrl); reviewAddressed unset
# so a fall-through to Stage 5 is detectable in the assertions below.
STATE_S4='{"taskId":"1","taskName":"S4 task","claimToken":"t","selfReviewPassed":true,"prUrl":"https://github.com/o/r/pull/1","previewUrl":"https://preview.example.com"}'

# -----------------------------------------------------------------------------
# Stage 3 — the core of this change.
# -----------------------------------------------------------------------------

# Test 1: NON-CI + missing previewUrl → BLOCK (exit 2). Gate intact for local/dev.
write_state "$STATE_NO_PREVIEW"
OUTPUT=$(run_local "src/foo.ts"); EXIT=$?
assert "non-CI + no previewUrl → BLOCK exit 2" "$EXIT" "2"
assert_contains "non-CI block mentions preview URL" "$OUTPUT" "preview URL has NOT been posted"

# Test 2: CI + missing previewUrl → ALLOWED past Stage 3 (does NOT exit 2 here).
# With no PR/CI reachable in the test env, Stages 4 is skipped (gh errors → warn)
# and Stage 5 blocks on missing reviewAddressed — proving we got PAST Stage 3.
write_state "$STATE_NO_PREVIEW"
OUTPUT=$(run_ci "src/foo.ts"); EXIT=$?
assert_contains "CI + no previewUrl → relaxation NOTE logged" "$OUTPUT" "relaxing Stage 3"
assert_contains "CI relaxation does NOT print the Stage-3 BLOCK line" "$(echo "$OUTPUT" | grep -c 'preview URL has NOT been posted')" "0"
# It must NOT have stopped at Stage 3; it should now be at Stage 5 (reviewAddressed).
assert_contains "CI run falls through to Stage 5" "$OUTPUT" "code review has NOT been addressed"

# Test 3: CI + missing previewUrl + reviewAddressed=accepted → clean stop (exit 0).
# This is the full autonomous-loop happy path: CI runner, no preview, review acked.
write_state '{"taskId":"1","taskName":"CI task","claimToken":"t","selfReviewPassed":true,"prUrl":"https://github.com/o/r/pull/1","reviewAddressed":"accepted"}'
OUTPUT=$(run_ci "src/foo.ts"); EXIT=$?
assert "CI + no previewUrl + reviewAddressed → clean stop exit 0" "$EXIT" "0"

# Test 4: CI but previewUrl PRESENT → no relaxation note (normal path, exit 0 when review acked).
write_state '{"taskId":"1","taskName":"CI task","claimToken":"t","selfReviewPassed":true,"prUrl":"https://github.com/o/r/pull/1","previewUrl":"https://preview.example.com","reviewAddressed":"accepted"}'
OUTPUT=$(run_ci "src/foo.ts"); EXIT=$?
assert "CI + previewUrl present + review acked → exit 0" "$EXIT" "0"
assert_contains "no relaxation note when previewUrl present" "$(echo "$OUTPUT" | grep -c 'relaxing Stage 3')" "0"

# Test 5: NON-CI + previewUrl present + review acked → exit 0 (gate satisfied normally).
write_state '{"taskId":"1","taskName":"local task","claimToken":"t","selfReviewPassed":true,"prUrl":"https://github.com/o/r/pull/1","previewUrl":"https://preview.example.com","reviewAddressed":"accepted"}'
OUTPUT=$(run_local "src/foo.ts"); EXIT=$?
assert "non-CI + previewUrl + review acked → exit 0" "$EXIT" "0"

# -----------------------------------------------------------------------------
# Regression: Stages 1 + 2 must STILL block first, regardless of CI.
# The CI bypass is scoped to Stage 3 only — it must not let an un-reviewed or
# un-pushed change slip through.
# -----------------------------------------------------------------------------

# Test 6: CI + selfReview NOT passed → Stage 1 BLOCK (exit 2), never reaches Stage 3.
write_state '{"taskId":"1","taskName":"CI task","claimToken":"t","selfReviewPassed":false,"prUrl":"https://github.com/o/r/pull/1"}'
OUTPUT=$(run_ci "src/foo.ts"); EXIT=$?
assert "CI + no self-review → Stage 1 BLOCK exit 2" "$EXIT" "2"
assert_contains "Stage 1 block message" "$OUTPUT" "self-review has NOT passed"
assert_contains "Stage 1 fires before Stage-3 relaxation" "$(echo "$OUTPUT" | grep -c 'relaxing Stage 3')" "0"

# Test 7: CI + selfReview passed but NO PR (no prUrl, gh returns non-zero) → Stage 2 BLOCK.
# Prepend a stub `gh` (exit 1) so pr_exists=False deterministically; with no
# prUrl in state, Stage 2 blocks. Real PATH is kept so python3 still resolves.
write_state '{"taskId":"1","taskName":"CI task","claimToken":"t","selfReviewPassed":true}'
OUTPUT=$(env GITHUB_ACTIONS=true CI=true PATH="$STUB_BIN:$PATH" "$PY3" "$LOGIC" "$STATE" "$PROJECT_ROOT" "src/foo.ts" 2>&1); EXIT=$?
assert "CI + no PR → Stage 2 BLOCK exit 2" "$EXIT" "2"
assert_contains "Stage 2 block message" "$OUTPUT" "no PR exists"
assert_contains "Stage 2 fires before Stage-3 relaxation" "$(echo "$OUTPUT" | grep -c 'relaxing Stage 3')" "0"

# -----------------------------------------------------------------------------
# Pass-through edge cases (shared by both CI and non-CI).
# -----------------------------------------------------------------------------

# Test 8: no source changes (empty COMBINED_CHANGES) → allow stop silently, both modes.
write_state "$STATE_NO_PREVIEW"
OUTPUT=$(run_ci ""); EXIT=$?
assert "no source changes (CI) → exit 0" "$EXIT" "0"
OUTPUT=$(run_local ""); EXIT=$?
assert "no source changes (local) → exit 0" "$EXIT" "0"

# Test 9: malformed JSON state → fail-open exit 0 (don't block on corrupt state).
printf '%s' "{ not valid json" > "$STATE"
OUTPUT=$(run_ci "src/foo.ts"); EXIT=$?
assert "malformed JSON → fail-open exit 0" "$EXIT" "0"

# Test 10: only CI=true (no GITHUB_ACTIONS) still triggers the bypass.
write_state '{"taskId":"1","taskName":"CI task","claimToken":"t","selfReviewPassed":true,"prUrl":"https://github.com/o/r/pull/1","reviewAddressed":"accepted"}'
OUTPUT=$(env -u GITHUB_ACTIONS CI=true "$PY3" "$LOGIC" "$STATE" "$PROJECT_ROOT" "src/foo.ts" 2>&1); EXIT=$?
assert "CI=true alone (no GITHUB_ACTIONS) → clean stop exit 0" "$EXIT" "0"

# Test 11: GITHUB_ACTIONS=false + CI unset → treated as NON-CI → Stage 3 BLOCK.
# Guards against a truthiness bug (e.g. checking presence instead of =='true').
# (env option flags before assignments for BSD-env compatibility.)
write_state "$STATE_NO_PREVIEW"
OUTPUT=$(env -u CI GITHUB_ACTIONS=false "$PY3" "$LOGIC" "$STATE" "$PROJECT_ROOT" "src/foo.ts" 2>&1); EXIT=$?
assert "GITHUB_ACTIONS=false + no CI → BLOCK exit 2" "$EXIT" "2"

# -----------------------------------------------------------------------------
# Stage 4 — CI classification via gh's `bucket` field (the busy-wait-loop fix).
# Regression guard: the previous state-based pending set
# (QUEUED/IN_PROGRESS/PENDING/WAITING) mis-read a still-queued claude-review
# check as terminal, so Stage 4 fell through and Stage 5 fired a FALSE
# "code review has NOT been addressed". These cases pin the bucket-based
# classification so a revert to state-matching fails the suite.
# -----------------------------------------------------------------------------

# Test 12: pending bucket → BLOCK "still PENDING" at Stage 4, NOT Stage 5.
write_state "$STATE_S4"
OUTPUT=$(run_with_checks '[{"name":"Build","bucket":"pass"},{"name":"claude-review","bucket":"pending"}]' "src/foo.ts"); EXIT=$?
assert "Stage 4 pending bucket → BLOCK exit 2" "$EXIT" "2"
assert_contains "pending block says 'still PENDING'" "$OUTPUT" "still PENDING"
assert_contains "pending block lists the pending check" "$OUTPUT" "claude-review"
assert_contains "pending does NOT fall through to Stage 5" "$(echo "$OUTPUT" | grep -c 'code review has NOT been addressed')" "0"

# Test 13: all checks pass + reviewAddressed unset → Stage 4 passes, Stage 5 fires.
write_state "$STATE_S4"
OUTPUT=$(run_with_checks '[{"name":"Build","bucket":"pass"},{"name":"claude-review","bucket":"pass"}]' "src/foo.ts"); EXIT=$?
assert "all pass + no reviewAddressed → Stage 5 BLOCK exit 2" "$EXIT" "2"
assert_contains "Stage 5 message reached when truly green" "$OUTPUT" "code review has NOT been addressed"

# Test 14: fail bucket → "CI checks FAILING" (and takes precedence over pending).
write_state "$STATE_S4"
OUTPUT=$(run_with_checks '[{"name":"Build","bucket":"fail"},{"name":"claude-review","bucket":"pending"}]' "src/foo.ts"); EXIT=$?
assert "Stage 4 fail bucket → BLOCK exit 2" "$EXIT" "2"
assert_contains "fail block message" "$OUTPUT" "CI checks FAILING"

# Test 15: cancel bucket → "CANCELLED" (superseded, not silently green).
write_state "$STATE_S4"
OUTPUT=$(run_with_checks '[{"name":"Build","bucket":"cancel"}]' "src/foo.ts"); EXIT=$?
assert "Stage 4 cancel bucket → BLOCK exit 2" "$EXIT" "2"
assert_contains "cancel block message" "$OUTPUT" "CANCELLED"

# Test 16: 'Vercel Agent Review' pending is excluded — must not gate Stage 4.
write_state "$STATE_S4"
OUTPUT=$(run_with_checks '[{"name":"Vercel Agent Review","bucket":"pending"},{"name":"Build","bucket":"pass"}]' "src/foo.ts"); EXIT=$?
assert "Vercel Agent Review pending excluded → not held at Stage 4" "$EXIT" "2"
assert_contains "excluded check → falls through to Stage 5" "$OUTPUT" "code review has NOT been addressed"
assert_contains "excluded check not reported as pending" "$(echo "$OUTPUT" | grep -c 'still PENDING')" "0"

# Test 17: all pass + reviewAddressed=accepted → clean stop exit 0 (end-to-end).
write_state '{"taskId":"1","taskName":"S4 task","claimToken":"t","selfReviewPassed":true,"prUrl":"https://github.com/o/r/pull/1","previewUrl":"https://preview.example.com","reviewAddressed":"accepted"}'
OUTPUT=$(run_with_checks '[{"name":"Build","bucket":"pass"},{"name":"claude-review","bucket":"pass"}]' "src/foo.ts"); EXIT=$?
assert "all pass + reviewAddressed=accepted → clean stop exit 0" "$EXIT" "0"

echo ""
echo "==================================================="
echo "stop-task-logic tests: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "==================================================="
[ "$FAIL_COUNT" -eq 0 ]
