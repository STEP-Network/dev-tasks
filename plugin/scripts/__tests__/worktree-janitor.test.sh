#!/usr/bin/env bash
# Smoke test for worktree-audit.sh --auto + the SessionStart janitor hook.
#
# Run: bash plugin/scripts/__tests__/worktree-janitor.test.sh
#
# Sets up a throwaway git repo in $TMPDIR with worktrees in known states,
# exercises the janitor, and asserts each scenario behaves as expected.

set -u
shopt -s nullglob

# Resolve script paths from this test's location.
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
AUDIT_SCRIPT="$PLUGIN_ROOT/scripts/worktree-audit.sh"
JANITOR_HOOK="$PLUGIN_ROOT/hooks/worktree-janitor.sh"

[ -f "$AUDIT_SCRIPT" ] || { echo "FAIL: audit script not found at $AUDIT_SCRIPT" >&2; exit 1; }
[ -f "$JANITOR_HOOK" ] || { echo "FAIL: janitor hook not found at $JANITOR_HOOK" >&2; exit 1; }

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1" >&2; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d -t worktree-janitor-test-XXXX)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

# Build a tiny git repo with an initial commit on main.
git init -q -b main fixture
cd fixture
git config user.email "test@test"
git config user.name "test"
echo "x" > README.md
git add README.md
git commit -q -m "init"
MAIN_HEAD=$(git rev-parse HEAD)

echo "==> Test 1: --auto flag is accepted and reports zero work on a clean repo"
out=$(bash "$AUDIT_SCRIPT" --auto 2>&1)
if echo "$out" | grep -q "Auto-prune complete:"; then
  pass "--auto produces expected summary line"
else
  fail "--auto missing summary line. Output:"
  echo "$out" | sed 's/^/    /'
fi

echo "==> Test 2: stale .git/worktrees/<name>/locked > 24h is unlocked"
# Create a real worktree, then add a stale lock file with backdated mtime.
git worktree add -q .claude/worktrees/test-stale-lock -b test-stale-lock
mkdir -p .git/worktrees/test-stale-lock
touch .git/worktrees/test-stale-lock/locked
# Backdate the lock by 48h (macOS + Linux compatible).
if touch -d "48 hours ago" .git/worktrees/test-stale-lock/locked 2>/dev/null; then :; else
  # macOS BSD touch — use -t YYYYMMDDhhmm format
  past=$(date -v-2d "+%Y%m%d%H%M" 2>/dev/null || date -d "2 days ago" "+%Y%m%d%H%M")
  touch -t "$past" .git/worktrees/test-stale-lock/locked
fi
out=$(bash "$AUDIT_SCRIPT" --auto 2>&1)
if [ ! -f .git/worktrees/test-stale-lock/locked ]; then
  pass "stale lock file removed"
else
  fail "stale lock file persisted"
fi
if echo "$out" | grep -q "1 stale lock"; then
  pass "summary reports 1 stale lock cleared"
else
  fail "summary missed lock count. Output: $(echo "$out" | tail -3)"
fi
git worktree remove --force .claude/worktrees/test-stale-lock 2>/dev/null || true

echo "==> Test 3: fresh lock (mtime < 24h) is preserved"
git worktree add -q .claude/worktrees/test-fresh-lock -b test-fresh-lock
mkdir -p .git/worktrees/test-fresh-lock
touch .git/worktrees/test-fresh-lock/locked
out=$(bash "$AUDIT_SCRIPT" --auto 2>&1)
if [ -f .git/worktrees/test-fresh-lock/locked ]; then
  pass "fresh lock preserved"
else
  fail "fresh lock was incorrectly removed"
fi
git worktree remove --force .claude/worktrees/test-fresh-lock 2>/dev/null || true

echo "==> Test 4: janitor hook produces no output when nothing to clean"
out=$(bash "$JANITOR_HOOK" 2>&1)
if [ -z "$out" ]; then
  pass "hook is silent on no-op"
else
  fail "hook produced unexpected output: $out"
fi

echo "==> Test 5: janitor hook produces summary when stale lock is cleaned"
git worktree add -q .claude/worktrees/test-hook-output -b test-hook-output
mkdir -p .git/worktrees/test-hook-output
touch .git/worktrees/test-hook-output/locked
past=$(date -v-2d "+%Y%m%d%H%M" 2>/dev/null || date -d "2 days ago" "+%Y%m%d%H%M")
touch -t "$past" .git/worktrees/test-hook-output/locked
out=$(bash "$JANITOR_HOOK" 2>&1)
if echo "$out" | grep -q "\[worktree-janitor\]"; then
  pass "hook produced summary line"
else
  fail "hook did not produce summary. Output: $out"
fi
git worktree remove --force .claude/worktrees/test-hook-output 2>/dev/null || true

echo "==> Test 6: fresh unmerged worktree without active-task.json is preserved (30d age floor)"
# Regression test for the ABANDONED-without-age-guard bug. Before the fix, --auto
# would --force-delete this worktree. After the fix it must classify as IN-FLIGHT
# and stay on disk.
git worktree add -q .claude/worktrees/test-fresh-no-task -b test-fresh-no-task
# No .claude/active-task.json. Latest commit is from "init" seconds ago.
out=$(bash "$AUDIT_SCRIPT" --auto 2>&1)
if [ -d .claude/worktrees/test-fresh-no-task ]; then
  pass "fresh exploratory worktree preserved"
else
  fail "fresh exploratory worktree was incorrectly removed by --auto"
  echo "    Output: $(echo "$out" | tail -5)"
fi
if echo "$out" | grep -q "0 ABANDONED removed"; then
  pass "summary reports 0 ABANDONED removed"
else
  fail "expected '0 ABANDONED removed' in summary. Got: $(echo "$out" | grep 'Auto-prune')"
fi
git worktree remove --force .claude/worktrees/test-fresh-no-task 2>/dev/null || true

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
