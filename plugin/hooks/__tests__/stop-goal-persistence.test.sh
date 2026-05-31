#!/bin/bash
# Tests for .claude/hooks/stop-goal-persistence.sh
#
# Strategy: build a temp git repo + a project-config that enables the hook, write
# .claude/active-goal.json (+ active-task.json) variants, feed a Stop-hook JSON
# payload on stdin, and assert exit code + stderr.
#
# Hermetic: MONDAY_API_KEY and ANTHROPIC_API_KEY are UNSET inside run_hook so the
# evaluator takes the deterministic path WITHOUT the Monday queue query (no
# network). The deterministic verdict then depends solely on active-task.json's
# selfReviewPassed (signal A): false => goal unmet => block; true/absent + no
# queue => goal met => allow.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../stop-goal-persistence.sh"

[ ! -x "$HOOK" ] && { echo "FATAL: hook not executable: $HOOK"; exit 1; }

PASS_COUNT=0
FAIL_COUNT=0

assert() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1));
  else echo "FAIL: $1 (expected '$3', got '$2')"; FAIL_COUNT=$((FAIL_COUNT + 1)); fi
}
assert_contains() {
  if echo "$2" | grep -qF "$3"; then echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1));
  else echo "FAIL: $1 (needle '$3' missing)"; FAIL_COUNT=$((FAIL_COUNT + 1)); fi
}
assert_not_contains() {
  if echo "$2" | grep -qF "$3"; then echo "FAIL: $1 (unexpected needle '$3' present)"; FAIL_COUNT=$((FAIL_COUNT + 1));
  else echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); fi
}

# Build a tmp git project.
TMP_PROJECT=$(mktemp -d)
trap 'rm -rf "$TMP_PROJECT"' EXIT
mkdir -p "$TMP_PROJECT/.claude"

git -C "$TMP_PROJECT" init -q
git -C "$TMP_PROJECT" config user.email "test@example.com"
git -C "$TMP_PROJECT" config user.name "test"
git -C "$TMP_PROJECT" config commit.gpgsign false 2>/dev/null

# Commit a baseline so `git diff main...HEAD` has a base (the hook tolerates no
# base, but a clean repo keeps SOURCE_CHANGED deterministic per test).
echo "v1" > "$TMP_PROJECT/file"
git -C "$TMP_PROJECT" add file
git -C "$TMP_PROJECT" commit -q -m "initial"
git -C "$TMP_PROJECT" branch -M main 2>/dev/null

CFG_ENABLED='{ "version":"1", "monday":{"productId":"1"}, "hooks":{"enabled":["stop-goal-persistence"]} }'
CFG_DISABLED='{ "version":"1", "monday":{"productId":"1"}, "hooks":{"enabled":[]} }'

write_cfg()    { printf '%s' "$1" > "$TMP_PROJECT/.claude/project-config.json"; }
write_goal()   { printf '%s' "$1" > "$TMP_PROJECT/.claude/active-goal.json"; }
rm_goal()      { rm -f "$TMP_PROJECT/.claude/active-goal.json"; }
write_task()   { printf '%s' "$1" > "$TMP_PROJECT/.claude/active-task.json"; }
rm_task()      { rm -f "$TMP_PROJECT/.claude/active-task.json"; }
goal_exists()  { [ -f "$TMP_PROJECT/.claude/active-goal.json" ]; }

# run_hook <stop_hook_active:true|false>
# Feeds a Stop payload with cwd=$TMP_PROJECT; UNSETS both API keys for hermeticity.
run_hook() {
  local sha="${1:-false}"
  printf '{"cwd":"%s","stop_hook_active":%s,"hook_event_name":"Stop"}' "$TMP_PROJECT" "$sha" \
    | (cd "$TMP_PROJECT" && env -u MONDAY_API_KEY -u ANTHROPIC_API_KEY CLAUDE_PROJECT_DIR="$TMP_PROJECT" bash "$HOOK") 2>&1
}
run_rc() { run_hook "$1" >/dev/null 2>&1; echo $?; }

# ---------------------------------------------------------------------------
# Test 1: hook disabled in project-config -> silent no-op (exit 0).
# ---------------------------------------------------------------------------
write_cfg "$CFG_DISABLED"
write_goal '{"goal":"do the thing","consecutiveBlocks":0,"maxBlocks":3}'
write_task '{"taskId":"1","claimToken":"t","selfReviewPassed":false}'
OUT=$(run_hook false); RC=$(run_rc false)
assert "disabled in config -> allow" "$RC" "0"
assert_not_contains "disabled -> no block message" "$OUT" "BLOCKED by /goal"

# Enable for the remaining tests.
write_cfg "$CFG_ENABLED"

# ---------------------------------------------------------------------------
# Test 2: enabled, no goal marker, clean tree (no source change) -> allow, silent.
# ---------------------------------------------------------------------------
rm_goal; rm_task
OUT=$(run_hook false); RC=$(run_rc false)
assert "no marker, clean tree -> allow" "$RC" "0"
assert_not_contains "no marker, clean tree -> no SELF-CHECK" "$OUT" "SELF-CHECK"

# ---------------------------------------------------------------------------
# Test 3: enabled, no goal marker, SOURCE changed -> allow + SELF-CHECK surfaced.
# ---------------------------------------------------------------------------
rm_goal
echo "v2" > "$TMP_PROJECT/file"   # uncommitted change => SOURCE_CHANGED=1
OUT=$(run_hook false); RC=$(run_rc false)
assert "no marker, source changed -> allow" "$RC" "0"
assert_contains "no marker, source changed -> SELF-CHECK present" "$OUT" "SELF-CHECK"
assert_contains "SELF-CHECK names fake-tiredness" "$OUT" "KEEP GOING"
git -C "$TMP_PROJECT" checkout -q -- file  # reset tree

# ---------------------------------------------------------------------------
# Test 4: goal set + deterministic UNMET (selfReviewPassed=false) -> BLOCK exit 2.
# Capture BOTH stderr and exit code from a SINGLE invocation (the block bumps
# the persistent counter, so re-invoking would bump it again).
# ---------------------------------------------------------------------------
write_goal '{"goal":"ship task #123 to staging","consecutiveBlocks":0,"maxBlocks":3}'
write_task '{"taskId":"123","taskName":"Demo","claimToken":"t","selfReviewPassed":false}'
OUT=$(run_hook false); RC=$?
assert "goal unmet (deterministic) -> BLOCK" "$RC" "2"
assert_contains "block names the goal" "$OUT" "ship task #123 to staging"
assert_contains "block says keep working" "$OUT" "Keep working"
assert_contains "block surfaces SELF-CHECK" "$OUT" "SELF-CHECK"

# ---------------------------------------------------------------------------
# Test 4b: that SINGLE block bumped consecutiveBlocks 0 -> 1 in the marker.
# ---------------------------------------------------------------------------
CB=$(python3 -c "import json;print(json.load(open('$TMP_PROJECT/.claude/active-goal.json')).get('consecutiveBlocks'))" 2>/dev/null)
assert "block bumped consecutiveBlocks to 1" "$CB" "1"

# ---------------------------------------------------------------------------
# Test 5: escape hatch — reviewAddressed=handoff-to-orchestrator -> allow + clear.
# ---------------------------------------------------------------------------
write_goal '{"goal":"x","consecutiveBlocks":1,"maxBlocks":3}'
write_task '{"taskId":"1","claimToken":"t","selfReviewPassed":false,"reviewAddressed":"handoff-to-orchestrator"}'
OUT=$(run_hook false); RC=$(run_rc false)
assert "handoff-to-orchestrator -> allow" "$RC" "0"
# run_hook ran twice (OUT + RC); after the first the marker is already cleared,
# so just assert it's gone now.
goal_exists && { echo "FAIL: handoff did not clear marker"; FAIL_COUNT=$((FAIL_COUNT + 1)); } || { echo "PASS: handoff cleared marker"; PASS_COUNT=$((PASS_COUNT + 1)); }

# ---------------------------------------------------------------------------
# Test 5b: escape hatch — reviewAddressed=stuck:* -> allow.
# ---------------------------------------------------------------------------
write_goal '{"goal":"x","consecutiveBlocks":0,"maxBlocks":3}'
write_task '{"taskId":"1","claimToken":"t","selfReviewPassed":false,"reviewAddressed":"stuck:regression-loop"}'
assert "stuck:* -> allow" "$(run_rc false)" "0"

# ---------------------------------------------------------------------------
# Test 5c: escape hatch — reviewAddressed=timeout:* -> allow.
# ---------------------------------------------------------------------------
write_goal '{"goal":"x","consecutiveBlocks":0,"maxBlocks":3}'
write_task '{"taskId":"1","claimToken":"t","selfReviewPassed":false,"reviewAddressed":"timeout:max-rounds"}'
assert "timeout:* -> allow" "$(run_rc false)" "0"

# ---------------------------------------------------------------------------
# Test 6: max-consecutive-blocks reached (consecutive=3 >= maxBlocks=3) -> allow + warn + clear.
# ---------------------------------------------------------------------------
write_goal '{"goal":"never satisfiable","consecutiveBlocks":3,"maxBlocks":3}'
write_task '{"taskId":"1","claimToken":"t","selfReviewPassed":false}'
OUT=$(run_hook true)            # capture stderr BEFORE the second (RC) run clears it
RC=$(run_rc true)               # second run: marker already cleared -> still allow
assert "max blocks reached -> allow" "$RC" "0"
assert_contains "max blocks -> warns about consecutive blocks" "$OUT" "consecutive blocks"

# ---------------------------------------------------------------------------
# Test 7: goal MET deterministically (selfReviewPassed=true, no queue) -> allow + clear.
# ---------------------------------------------------------------------------
write_goal '{"goal":"x","consecutiveBlocks":1,"maxBlocks":3}'
write_task '{"taskId":"1","claimToken":"t","selfReviewPassed":true}'
OUT=$(run_hook false); RC=$(run_rc false)
assert "goal met (deterministic) -> allow" "$RC" "0"
assert_contains "met -> announces release" "$OUT" "Goal MET"
goal_exists && { echo "FAIL: met did not clear marker"; FAIL_COUNT=$((FAIL_COUNT + 1)); } || { echo "PASS: met cleared marker"; PASS_COUNT=$((PASS_COUNT + 1)); }

# ---------------------------------------------------------------------------
# Test 8: malformed active-goal.json -> fail-open (treated as no marker) -> allow.
# ---------------------------------------------------------------------------
write_goal '{ this is not valid json'
write_task '{"taskId":"1","claimToken":"t","selfReviewPassed":false}'
assert "malformed marker -> fail-open allow" "$(run_rc false)" "0"

# ---------------------------------------------------------------------------
# Test 9: marker present but empty goal string -> allow (no condition to enforce).
# ---------------------------------------------------------------------------
write_goal '{"goal":"","consecutiveBlocks":0,"maxBlocks":3}'
assert "empty goal -> allow" "$(run_rc false)" "0"

# ---------------------------------------------------------------------------
# Test 10: goal unmet but stop_hook_active=true -> still BLOCK, mentions chain count.
# ---------------------------------------------------------------------------
write_goal '{"goal":"finish it","consecutiveBlocks":1,"maxBlocks":3}'
write_task '{"taskId":"1","taskName":"Demo","claimToken":"t","selfReviewPassed":false}'
OUT=$(run_hook true); RC=$(run_rc true)
assert "unmet + stop_hook_active -> BLOCK" "$RC" "2"
assert_contains "stop_hook_active -> mentions block N of M" "$OUT" "block"

# ---------------------------------------------------------------------------
# Test 11: signal-B parsing contract (offline) — stub monday_graphql and assert
# the deterministic queue check uses the RIGHT column ids:
#   - active sprint matched by `sprint_activation` (NOT `sprint_completion`,
#     which is set on every completed sprint — matching it would pick the wrong
#     sprint),
#   - claimable tasks = status "Ready to Start" AND empty agent AND task_sprint
#     linked_item_ids contains the active sprint id.
# This locks the column-ID contract without a network dependency.
# ---------------------------------------------------------------------------
LOGIC_PY="$SCRIPT_DIR/../stop-goal-persistence-logic.py"
PYOUT=$(python3 - "$LOGIC_PY" <<'PYEOF'
import sys, importlib.util
spec = importlib.util.spec_from_file_location("logic", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

SPRINTS = {  # board_relation/checkbox shape Monday returns
  "data": {"boards": [{"items_page": {"items": [
    {"id": "11", "name": "Sprint 01", "column_values": [{"id": "sprint_completion", "text": "v", "type": "checkbox"}]},
    {"id": "99", "name": "Sprint 09", "column_values": [{"id": "sprint_activation", "text": "v", "type": "checkbox"}]},
  ]}}]}
}
TASKS = {
  "data": {"boards": [{"items_page": {"cursor": None, "items": [
    # claimable in active sprint 99
    {"id": "a", "column_values": [
      {"id": "task_status", "text": "Ready to Start"}, {"id": "dropdown_mm0mrcex", "text": ""},
      {"id": "task_sprint", "text": None, "linked_item_ids": ["99"]}]},
    # Ready-to-Start but ALREADY claimed (agent set) -> NOT counted
    {"id": "b", "column_values": [
      {"id": "task_status", "text": "Ready to Start"}, {"id": "dropdown_mm0mrcex", "text": "Claude Code in Remote"},
      {"id": "task_sprint", "text": None, "linked_item_ids": ["99"]}]},
    # Ready-to-Start, unclaimed, but in a DIFFERENT sprint -> NOT counted
    {"id": "c", "column_values": [
      {"id": "task_status", "text": "Ready to Start"}, {"id": "dropdown_mm0mrcex", "text": ""},
      {"id": "task_sprint", "text": None, "linked_item_ids": ["11"]}]},
    # In Progress, unclaimed, active sprint -> NOT counted (wrong status)
    {"id": "d", "column_values": [
      {"id": "task_status", "text": "In Progress"}, {"id": "dropdown_mm0mrcex", "text": ""},
      {"id": "task_sprint", "text": None, "linked_item_ids": ["99"]}]},
  ]}}]}
}

def fake_graphql(api_key, query, variables):
    # Route by which board id was requested.
    bid = str(variables.get("board", [""])[0])
    return SPRINTS if bid == "5091706352" else TASKS

m.monday_graphql = fake_graphql

asid = m.monday_find_active_sprint("k", "5091706352")
cnt = m.monday_count_ready_tasks("k", "5091706356", "99")
print("active=%s count=%s" % (asid, cnt))
PYEOF
)
assert "signal-B: active sprint resolved by sprint_activation (=99, not 11)" "$(echo "$PYOUT" | grep -o 'active=[0-9]*')" "active=99"
assert "signal-B: only the 1 claimable in-sprint Ready task counted" "$(echo "$PYOUT" | grep -o 'count=[0-9]*')" "count=1"

echo ""
echo "==================================================="
echo "stop-goal-persistence tests: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "==================================================="
[ "$FAIL_COUNT" -eq 0 ]
