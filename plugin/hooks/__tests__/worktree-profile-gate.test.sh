#!/bin/bash
# The worktree gates are agent-only (spec section 4). A human works in the main
# checkout by design; an agent mini must stay in its worktree.
#
# This asserts the GATE, not the worktree logic — the enabled+agent case is
# expected to block on a plain repo with an active task and no worktree, and
# the enabled+human case must not.
#
# Run with: bash plugin/hooks/__tests__/worktree-profile-gate.test.sh

set -u

# A shell-exported DEV_TASKS_PROFILE overrides the profile FILE this test
# writes per case (see hooks/lib/profile.sh) — unset it so the fixture is the
# only thing deciding the profile.
unset DEV_TASKS_PROFILE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

TEST_DIR=$(mktemp -d -t worktree-gate-XXXX)
# Resolve to the physical path: macOS's mktemp returns a /var/folders/... path
# that is itself a symlink into /private/var/folders/...; git's rev-parse
# always resolves through it, so an unresolved TEST_DIR would never
# string-match the worktree/main toplevel paths computed from git further down.
TEST_DIR=$(cd "$TEST_DIR" && pwd -P)
TEST_HOME=$(mktemp -d -t worktree-gate-home-XXXX)
mkdir -p "$TEST_DIR/.claude" "$TEST_DIR/src" "$TEST_HOME/.claude"
export HOME="$TEST_HOME"
export CLAUDE_PROJECT_DIR="$TEST_DIR"

cleanup() { chmod -R u+w "$TEST_DIR" "$TEST_HOME" 2>/dev/null; command rm -r -f "$TEST_DIR" "$TEST_HOME"; }
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
  "hooks": { "enabled": ["worktree-required", "worktree-path-boundary"] }
}
CFG

# An active task with no worktree is what the gate exists to catch.
cat > "$TEST_DIR/.claude/active-task.json" <<'TASK'
{ "taskId": "1234567890", "branch": "feat/x", "status": "in_progress" }
TASK

# A real linked worktree, nested under $TEST_DIR so the existing cleanup trap
# removes it too. worktree-path-boundary.sh's block branch only fires when
# CLAUDE_PROJECT_DIR points at an ACTUAL worktree (git-common-dir != git-dir)
# and the target path is in the main checkout but outside that worktree — a
# plain repo never reaches that branch, so this fixture is required to make
# the profile gate load-bearing for that hook.
LINKED_WT="$TEST_DIR/linked-worktree"
git worktree add --quiet -b wt-branch "$LINKED_WT" main >/dev/null 2>&1
WT_SETUP_OK=$?
mkdir -p "$LINKED_WT/.claude"
cp "$TEST_DIR/.claude/project-config.json" "$LINKED_WT/.claude/project-config.json"

payload() {
  printf '{"tool_name":"Edit","tool_input":{"file_path":"%s/src/app.ts"}}' "$TEST_DIR"
}

# assert_hook <hook> <profile|none> <expected-exit> <label>
assert_hook() {
  local hook="$1" profile="$2" expected="$3" label="$4" code
  if [ "$profile" = "none" ]; then
    command rm -f "$TEST_HOME/.claude/dev-tasks-profile.json"
  else
    printf '{ "profile": "%s" }' "$profile" > "$TEST_HOME/.claude/dev-tasks-profile.json"
  fi
  payload | bash "$SCRIPT_DIR/../$hook.sh" >/dev/null 2>&1
  code=$?
  if [ "$code" = "$expected" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected exit $expected, got $code)"
    FAIL=$((FAIL + 1))
  fi
}

# assert_hook_in_worktree <profile|none> <expected-exit> <label>
# Same as assert_hook but runs worktree-path-boundary.sh with CLAUDE_PROJECT_DIR
# pointed at the linked worktree, targeting a file_path back in the main
# checkout (src/app.ts) — the exact "edit landed in the wrong tree" case the
# hook exists to block.
assert_hook_in_worktree() {
  local profile="$1" expected="$2" label="$3" code
  if [ "$profile" = "none" ]; then
    command rm -f "$TEST_HOME/.claude/dev-tasks-profile.json"
  else
    printf '{ "profile": "%s" }' "$profile" > "$TEST_HOME/.claude/dev-tasks-profile.json"
  fi
  payload | CLAUDE_PROJECT_DIR="$LINKED_WT" bash "$SCRIPT_DIR/../worktree-path-boundary.sh" >/dev/null 2>&1
  code=$?
  if [ "$code" = "$expected" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected exit $expected, got $code)"
    FAIL=$((FAIL + 1))
  fi
}

echo "--- human: both gates pass through ---"
assert_hook worktree-required human 0 "worktree-required allows on human"
assert_hook worktree-path-boundary human 0 "worktree-path-boundary allows on human"

echo "--- absent profile file behaves as human ---"
assert_hook worktree-required none 0 "worktree-required allows with no profile file"

echo "--- agent: the gate is live again ---"
assert_hook worktree-required agent 2 "worktree-required blocks on agent"

echo "--- real worktree: worktree-path-boundary's block branch is load-bearing ---"
if [ "$WT_SETUP_OK" -ne 0 ]; then
  echo "FAIL: could not create linked worktree fixture"
  FAIL=$((FAIL + 1))
else
  assert_hook_in_worktree agent 2 "worktree-path-boundary blocks on agent from a real worktree"
  assert_hook_in_worktree human 0 "worktree-path-boundary allows on human from a real worktree"
  assert_hook_in_worktree none 0 "worktree-path-boundary allows with no profile file from a real worktree"
fi

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
