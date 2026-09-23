#!/bin/bash
# Gate (b) is retired (spec sections 4 and 10). Review moved to the CI
# `Claude review` check; nothing local sets selfReviewPassed any more, so a
# surviving gate would refuse every commit made while an active-task.json
# exists.
#
# The negative controls matter as much as the assertion: gates (a) and (f)
# must still block, or "retire gate b" has quietly become "disable bash-guard".
# The destructive fixture is assembled at run time so this FILE never contains
# the literal string gate (a) matches — otherwise the agent writing it is
# blocked by its own guard.
#
# Run with: bash plugin/hooks/__tests__/bash-guard-gate-b-retired.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../bash-guard.sh"

PASS=0
FAIL=0

TEST_DIR=$(mktemp -d -t gate-b-XXXX)
TEST_HOME=$(mktemp -d -t gate-b-home-XXXX)
mkdir -p "$TEST_DIR/.claude" "$TEST_HOME/.claude"
export HOME="$TEST_HOME"
export CLAUDE_PROJECT_DIR="$TEST_DIR"
printf '{ "profile": "human" }' > "$TEST_HOME/.claude/dev-tasks-profile.json"

cleanup() { command rm -r -f "$TEST_DIR" "$TEST_HOME"; }
trap cleanup EXIT

cd "$TEST_DIR"
git init --quiet --initial-branch=main
git config user.email "test@example.com"
git config user.name "test"
echo init > seed.txt
git add seed.txt
git commit --quiet -m init

cat > "$TEST_DIR/.claude/project-config.json" <<'CFG'
{
  "version": "1",
  "monday": { "productId": "1" },
  "git": { "protectedBranches": ["main", "staging"] },
  "hooks": { "enabled": [] }
}
CFG

# The exact state gate (b) used to refuse: an active task with the flag unset.
cat > "$TEST_DIR/.claude/active-task.json" <<'TASK'
{ "taskId": "1234567890", "branch": "feat/x", "selfReviewPassed": false }
TASK

# assert_cmd <command> <expected-exit> <label>
assert_cmd() {
  local cmd="$1" expected="$2" label="$3" code
  printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$cmd" | bash "$HOOK" >/dev/null 2>&1
  code=$?
  if [ "$code" = "$expected" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected exit $expected, got $code)"
    FAIL=$((FAIL + 1))
  fi
}

echo "--- gate (b) is gone ---"
assert_cmd "git commit -m wip" 0 "commit allowed with selfReviewPassed false"

command rm -f "$TEST_DIR/.claude/active-task.json"
assert_cmd "git commit -m no-active-task" 0 "commit allowed with no active task"

echo "--- negative controls: the other gates still block ---"
DESTRUCTIVE=$(printf 'rm -%sf /tmp/anything' r)
assert_cmd "$DESTRUCTIVE" 2 "gate (a) still blocks a recursive force delete"
assert_cmd "git push origin staging" 2 "gate (f) still blocks a push to staging"

echo "--- the source carries no selfReviewPassed gate any more ---"
if grep -q "selfReviewPassed" "$HOOK"; then
  echo "FAIL: bash-guard.sh still mentions selfReviewPassed"
  FAIL=$((FAIL + 1))
else
  echo "PASS: bash-guard.sh no longer mentions selfReviewPassed"
  PASS=$((PASS + 1))
fi

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
