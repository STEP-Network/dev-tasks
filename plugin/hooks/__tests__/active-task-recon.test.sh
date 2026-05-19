#!/usr/bin/env bash
# Smoke test for active-task-recon.sh.
#
# Exercises:
#   - Case D (missing active-task.json in worktree-shaped dir) — local-only
#   - Healthy in-progress task (no drift output expected) — uses real Monday API
#   - Case A (task Done on Monday) — uses real Monday API + throwaway task
#
# Skipped (manual verification only):
#   - Case B (ownership changed) — would require deliberately mutating Agent ID
#     on a task; risk of side effects outweighs automation value.
#
# Requires MONDAY_API_KEY env. Tests touching Monday create + delete a
# throwaway item on board 5091706356.

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
FAKE_WORKTREE="$WORK/.claude/worktrees/feat-test-recon"
mkdir -p "$FAKE_WORKTREE/.claude"

# Helper: run hook from a given cwd and capture stdout
run_hook() {
  ( cd "$1" && bash "$HOOK" 2>&1 )
}

echo "==> Test 1: Case D — missing active-task.json in worktree-shaped dir"
out=$(run_hook "$FAKE_WORKTREE")
if echo "$out" | grep -q "Case D:" && echo "$out" | grep -q "feat-test-recon"; then
  pass "Case D detected + names the worktree"
else
  fail "Case D not detected. Output: $out"
fi

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

# Optional Monday-touching tests — skip cleanly if env missing
if [ -z "${MONDAY_API_KEY:-}" ]; then
  echo "==> SKIP: Monday-touching tests (MONDAY_API_KEY not set)"
else
  command -v curl >/dev/null 2>&1 || { echo "==> SKIP: curl missing"; echo "Results: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]; exit $?; }
  command -v jq   >/dev/null 2>&1 || { echo "==> SKIP: jq missing"; echo "Results: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]; exit $?; }

  echo "==> Test 5: healthy In Progress task — no drift output"
  # Create throwaway task at Needs Refinement, claim it (sets In Progress + agent)
  TASK_ID=$(curl -sS -X POST https://api.monday.com/v2 \
    -H "Authorization: $MONDAY_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"query":"mutation { create_item(board_id: 5091706356, item_name: \"recon-test — DELETE ME\", column_values: \"{\\\"task_status\\\": {\\\"index\\\": 0}, \\\"dropdown_mm0mrcex\\\": {\\\"ids\\\": [\\\"1\\\"]}}\") { id } }"}' \
    | jq -r '.data.create_item.id')
  if [ -z "$TASK_ID" ] || [ "$TASK_ID" = "null" ]; then
    fail "couldn't create throwaway task for Test 5"
  else
    echo "{\"taskId\":\"$TASK_ID\",\"branch\":\"feat/test-recon\"}" > "$FAKE_WORKTREE/.claude/active-task.json"
    sleep 1
    out=$(run_hook "$FAKE_WORKTREE")
    # AGENT_ID enum: "Claude Code CLI" = 19; Monday text rendering = "Claude Code in CLI"
    # Healthy = no drift output.
    if [ -z "$out" ]; then
      pass "healthy In Progress task → no drift output"
    else
      fail "expected silent, got: $out"
    fi

    echo "==> Test 6: Case A — task Done on Monday"
    # Move to Done
    curl -sS -X POST https://api.monday.com/v2 \
      -H "Authorization: $MONDAY_API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"query\":\"mutation SetDone(\$board: ID!, \$item: ID!, \$val: JSON!) { change_column_value(board_id: \$board, item_id: \$item, column_id: \\\"task_status\\\", value: \$val) { id } }\", \"variables\": {\"board\": \"5091706356\", \"item\": \"$TASK_ID\", \"val\": \"{\\\"index\\\":1}\"}}" \
      >/dev/null
    sleep 1
    out=$(run_hook "$FAKE_WORKTREE")
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
