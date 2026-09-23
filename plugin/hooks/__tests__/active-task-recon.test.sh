#!/usr/bin/env bash
# Smoke test for active-task-recon.sh.
#
# Exercises:
#   - Case D (missing active-task.json in worktree-shaped dir) — local-only
#   - the Monday-provider gate: silent under tracker.provider / DEV_TASKS_TRACKER
#     = linear, Case D still reported under monday — local-only
#   - Healthy in-progress task (no drift output expected) and Case A (task Done
#     on Monday) — offline, against a stubbed curl (Tests 11-12)
#   - the same two against the real Monday API (Tests 13-14) — opt-in only
#
# Skipped (manual verification only):
#   - Case B (ownership changed) — would require deliberately mutating Agent ID
#     on a task; risk of side effects outweighs automation value.
#
# Tests 13-14 create and delete a throwaway item on the live Tasks board
# (5091706356). A MONDAY_API_KEY in the environment is not enough to run them,
# because agent shells export one: they also need DEV_TASKS_LIVE_MONDAY_TESTS=1.
# Everything else makes no network call.

set -u
shopt -s nullglob

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$(cd "$TEST_DIR/.." && pwd)/active-task-recon.sh"

[ -x "$HOOK" ] || { echo "FAIL: hook not executable at $HOOK" >&2; exit 1; }

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1" >&2; FAIL=$((FAIL + 1)); }

# Fake-worktree-shaped temp dir for path-detection check
WORK="$(mktemp -d -t active-task-recon-XXXX)"
trap 'rm -rf "$WORK"' EXIT
# The hook reads the provider from the git toplevel. Stop git's search at
# $WORK so a TMPDIR inside some checkout can't lend these dirs its config.
export GIT_CEILING_DIRECTORIES="$WORK"
FAKE_WORKTREE="$WORK/.claude/worktrees/feat-test-recon"
mkdir -p "$FAKE_WORKTREE/.claude"
CONFIG="$FAKE_WORKTREE/.claude/project-config.json"
MONDAY_CONFIG='{"tracker":{"provider":"monday"}}'

# Helper: run hook from a given cwd and capture stdout. DEV_TASKS_TRACKER is
# cleared so a value exported in the caller's shell can't flip the provider,
# and MONDAY_API_KEY so no local case can reach Monday.
run_hook() {
  ( cd "$1" && env -u DEV_TASKS_TRACKER -u MONDAY_API_KEY bash "$HOOK" 2>&1 )
}

# Helper: same, with DEV_TASKS_TRACKER set to $2
run_hook_tracker() {
  ( cd "$1" && env -u MONDAY_API_KEY DEV_TASKS_TRACKER="$2" bash "$HOOK" 2>&1 )
}

# Helper: run hook with the caller's MONDAY_API_KEY. Live tests only.
run_hook_live() {
  ( cd "$1" && env -u DEV_TASKS_TRACKER bash "$HOOK" 2>&1 )
}

echo "==> Test 1: Case D — missing active-task.json, worktree with no project-config (Monday is the default)"
out=$(run_hook "$FAKE_WORKTREE")
if echo "$out" | grep -q "Case D:" && echo "$out" | grep -q "feat-test-recon"; then
  pass "Case D detected + names the worktree"
else
  fail "Case D not detected. Output: $out"
fi

# From here on the fixture carries a committed Monday config, as a real Monday
# consumer's worktree does. Without one, tracker_provider's "could not read"
# warning (stderr, which run_hook folds in) would land in every output below.
echo "$MONDAY_CONFIG" > "$CONFIG"

echo "==> Test 2: outside worktree path — hook is silent"
out=$(run_hook "$WORK")
if [ -z "$out" ]; then
  pass "hook silent outside .claude/worktrees/"
else
  fail "hook emitted output outside worktree: $out"
fi

echo "==> Test 3: malformed active-task.json — warn but exit 0"
echo "not valid json" > "$FAKE_WORKTREE/.claude/active-task.json"
out=$(run_hook "$FAKE_WORKTREE")
if echo "$out" | grep -q "taskId empty/malformed" || [ -z "$out" ]; then
  pass "malformed JSON handled (warn or silent — both acceptable)"
else
  fail "unexpected output for malformed JSON: $out"
fi

echo "==> Test 4: empty taskId — warns + exits 0"
echo '{"taskId": ""}' > "$FAKE_WORKTREE/.claude/active-task.json"
out=$(run_hook "$FAKE_WORKTREE")
if echo "$out" | grep -q "taskId empty/malformed"; then
  pass "empty taskId warned"
else
  fail "expected warning, got: $out"
fi

# Provider gate. Every case above is Monday state, and the 1.0 flow never
# writes active-task.json, so under Linear Case D would fire in every worktree
# session and point the agent at /pickup-task.
rm -f "$FAKE_WORKTREE/.claude/active-task.json"

echo "==> Test 5: tracker.provider linear — silent where Case D would fire"
echo '{"tracker":{"provider":"linear"}}' > "$CONFIG"
out=$(run_hook "$FAKE_WORKTREE")
if [ -z "$out" ]; then
  pass "linear project: no output"
else
  fail "expected silence under linear, got: $out"
fi

echo "==> Test 6: tracker.provider monday — Case D still reported"
echo "$MONDAY_CONFIG" > "$CONFIG"
out=$(run_hook "$FAKE_WORKTREE")
if echo "$out" | grep -q "Case D:"; then
  pass "monday project: Case D reported"
else
  fail "expected Case D under monday, got: $out"
fi

echo "==> Test 7: DEV_TASKS_TRACKER=linear overrides a monday config"
out=$(run_hook_tracker "$FAKE_WORKTREE" linear)
if [ -z "$out" ]; then
  pass "env override to linear: no output"
else
  fail "expected silence with DEV_TASKS_TRACKER=linear, got: $out"
fi

echo "==> Test 8: DEV_TASKS_TRACKER=monday overrides a linear config"
echo '{"tracker":{"provider":"linear"}}' > "$CONFIG"
out=$(run_hook_tracker "$FAKE_WORKTREE" monday)
if echo "$out" | grep -q "Case D:"; then
  pass "env override to monday: Case D reported"
else
  fail "expected Case D with DEV_TASKS_TRACKER=monday, got: $out"
fi
echo "$MONDAY_CONFIG" > "$CONFIG"

# A session can start in a subdirectory. The provider then comes from the
# config at the git toplevel, where trackerctl reads it, not from $PWD.
SUB_WT="$WORK/.claude/worktrees/feat-subdir"
mkdir -p "$SUB_WT/.claude" "$SUB_WT/lib"
printf 'x\n' > "$SUB_WT/lib/file.ts"
echo '{"tracker":{"provider":"linear"}}' > "$SUB_WT/.claude/project-config.json"
git -C "$SUB_WT" init -q
git -C "$SUB_WT" add -A
git -C "$SUB_WT" -c user.email=t@example.com -c user.name=t commit -q -m init

echo "==> Test 9: linear worktree, session started in a subdirectory — silent"
out=$(run_hook "$SUB_WT/lib")
if [ -z "$out" ]; then
  pass "subdirectory of a linear worktree: no output"
else
  fail "expected silence from a subdirectory under linear, got: $out"
fi

echo "==> Test 10: monday worktree, session started in a subdirectory — Case D"
echo '{"tracker":{"provider":"monday"}}' > "$SUB_WT/.claude/project-config.json"
out=$(run_hook "$SUB_WT/lib")
if echo "$out" | grep -q "Case D:"; then
  pass "subdirectory of a monday worktree: Case D reported"
else
  fail "expected Case D from a subdirectory under monday, got: $out"
fi

# The Monday round-trip, offline. curl is a stub that logs each call and
# answers with $CURL_FIXTURE, and the key is a placeholder, so the hook's
# query path runs and nothing can reach Monday.
STUB_DIR="$WORK/stub"
CURL_LOG="$WORK/curl.log"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/curl" <<'STUB'
#!/bin/bash
# Stands in for api.monday.com: logs the call, answers with $CURL_FIXTURE.
printf '%s\n' "$*" >> "$CURL_LOG"
printf '%s' "$CURL_FIXTURE"
STUB
chmod +x "$STUB_DIR/curl"

# run_hook_stubbed <cwd> <monday-response-json>
run_hook_stubbed() {
  ( cd "$1" && env -u DEV_TASKS_TRACKER PATH="$STUB_DIR:$PATH" \
      MONDAY_API_KEY="fake-not-a-key" CURL_FIXTURE="$2" CURL_LOG="$CURL_LOG" \
      bash "$HOOK" 2>&1 )
}

# monday_item <status> <agent> → the items query response the hook parses
monday_item() {
  jq -nc --arg s "$1" --arg a "$2" \
    '{data:{items:[{column_values:[{id:"task_status",text:$s},{id:"dropdown_mm0mrcex",text:$a}]}]}}'
}

echo '{"taskId":"1234567890","branch":"feat/test-recon"}' > "$FAKE_WORKTREE/.claude/active-task.json"

echo "==> Test 11: healthy In Progress task — no drift output (stubbed Monday)"
: > "$CURL_LOG"
out=$(run_hook_stubbed "$FAKE_WORKTREE" "$(monday_item "In Progress" "Claude Code in CLI")")
if [ ! -s "$CURL_LOG" ]; then
  fail "the hook never queried Monday, so its silence proves nothing (output: $out)"
elif [ -z "$out" ]; then
  pass "healthy task: queried Monday, printed nothing"
else
  fail "expected no output for a healthy task, got: $out"
fi

echo "==> Test 12: Case A — task Done on Monday (stubbed Monday)"
: > "$CURL_LOG"
out=$(run_hook_stubbed "$FAKE_WORKTREE" "$(monday_item "Done" "Claude Code in CLI")")
if echo "$out" | grep -q "Case A:.*1234567890.*Done"; then
  pass "Case A detected"
else
  fail "expected Case A detection, got: $out"
fi
rm -f "$FAKE_WORKTREE/.claude/active-task.json"

# The same two against the live API. They create and delete a real item on the
# Tasks board, so a key in the environment is not enough (agent shells export
# one): they also need DEV_TASKS_LIVE_MONDAY_TESTS=1.
if [ "${DEV_TASKS_LIVE_MONDAY_TESTS:-}" != "1" ]; then
  echo "==> SKIP: live Monday tests 13-14 (they write to the Tasks board; opt in with DEV_TASKS_LIVE_MONDAY_TESTS=1 and MONDAY_API_KEY)"
elif [ -z "${MONDAY_API_KEY:-}" ]; then
  echo "==> SKIP: live Monday tests 13-14 (DEV_TASKS_LIVE_MONDAY_TESTS=1 but MONDAY_API_KEY is not set)"
else
  command -v curl >/dev/null 2>&1 || { echo "==> SKIP: curl missing"; echo "Results: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]; exit $?; }
  command -v jq   >/dev/null 2>&1 || { echo "==> SKIP: jq missing"; echo "Results: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]; exit $?; }

  echo "==> Test 13: healthy In Progress task — no drift output (live Monday)"
  # Create throwaway task at Needs Refinement, claim it (sets In Progress + agent)
  TASK_ID=$(curl -sS -X POST https://api.monday.com/v2 \
    -H "Authorization: $MONDAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"query":"mutation { create_item(board_id: 5091706356, item_name: \"recon-test — DELETE ME\", column_values: \"{\\\"task_status\\\": {\\\"index\\\": 0}, \\\"dropdown_mm0mrcex\\\": {\\\"ids\\\": [\\\"1\\\"]}}\") { id } }"}' \
    | jq -r '.data.create_item.id')
  if [ -z "$TASK_ID" ] || [ "$TASK_ID" = "null" ]; then
    fail "couldn't create throwaway task for Test 13"
  else
    echo "{\"taskId\":\"$TASK_ID\",\"branch\":\"feat/test-recon\"}" > "$FAKE_WORKTREE/.claude/active-task.json"
    sleep 1
    out=$(run_hook_live "$FAKE_WORKTREE")
    # AGENT_ID enum: "Claude Code CLI" = 19; Monday text rendering = "Claude Code in CLI"
    # Healthy = no drift output.
    if [ -z "$out" ]; then
      pass "healthy In Progress task → no drift output"
    else
      fail "expected silent, got: $out"
    fi

    echo "==> Test 14: Case A — task Done on Monday (live Monday)"
    # Move to Done
    curl -sS -X POST https://api.monday.com/v2 \
      -H "Authorization: $MONDAY_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"query\":\"mutation SetDone(\$board: ID!, \$item: ID!, \$val: JSON!) { change_column_value(board_id: \$board, item_id: \$item, column_id: \\\"task_status\\\", value: \$val) { id } }\", \"variables\": {\"board\": \"5091706356\", \"item\": \"$TASK_ID\", \"val\": \"{\\\"index\\\":1}\"}}" \
      >/dev/null
    sleep 1
    out=$(run_hook_live "$FAKE_WORKTREE")
    if echo "$out" | grep -q "Case A:.*$TASK_ID.*Done"; then
      pass "Case A detected"
    else
      fail "expected Case A detection, got: $out"
    fi

    # Cleanup
    curl -sS -X POST https://api.monday.com/v2 \
      -H "Authorization: $MONDAY_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"query\":\"mutation { delete_item(item_id: $TASK_ID) { id } }\"}" \
      >/dev/null
  fi
fi

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
