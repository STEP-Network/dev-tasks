#!/bin/bash
# Tests for plugin/hooks/bash-guard.sh — focused on gate (f) protected-branch
# push block. Other gates (a destructive, b self-review, c pre-push marker, d/e
# i18n) have implicit coverage via other test files + integration.
#
# Strategy: spin up a temp git repo, feed PreToolUse Bash payloads via stdin,
# assert exit code (0 = allow, 2 = block) and that block messages reference
# the right branch.
#
# Run with: bash plugin/hooks/__tests__/bash-guard.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../bash-guard.sh"

if [ ! -x "$HOOK" ]; then
  echo "FATAL: hook not found or not executable at $HOOK"
  exit 1
fi

PASS=0
FAIL=0

TEST_DIR=$(mktemp -d -t bash-guard-test-XXXX)
mkdir -p "$TEST_DIR/.claude"
cd "$TEST_DIR"
git init --quiet --initial-branch=main
git config user.email "test@example.com"
git config user.name "test"
echo "init" > seed.txt
git add seed.txt
git commit --quiet -m "init"

# Project-config: bash-guard is always-on, no opt-in needed. But i18n.enabled
# needs to be false (default) so gate (d)/(e) don't fire on our test commits.
# Also: ensure protect-active-task-state isn't enabled (test isolation).
cat > "$TEST_DIR/.claude/project-config.json" <<CFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": [] }
}
CFG
export CLAUDE_PROJECT_DIR="$TEST_DIR"

# Build PreToolUse Bash payload
make_bash() {
  python3 -c "
import json, sys
print(json.dumps({
  'tool_name': 'Bash',
  'tool_input': { 'command': sys.argv[1] },
}))
" "$1"
}

# Create a valid pre-push marker for the current branch + HEAD.
# Required so gate (c) passes when the target ISN'T protected.
make_marker() {
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD | tr '/' '-')
  echo "$(git rev-parse HEAD)" > "/tmp/.claude-prepush-${branch}"
}
clean_marker() {
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD | tr '/' '-')
  rm -f "/tmp/.claude-prepush-${branch}"
}

run_test() {
  local name="$1"
  local expect_exit="$2"
  local cmd="$3"
  local stderr_grep="${4:-}"

  local payload
  payload=$(make_bash "$cmd")
  local actual_stderr
  actual_stderr=$(echo "$payload" | bash "$HOOK" 2>&1 >/dev/null)
  local actual_exit=$?

  local ok=true
  [ "$actual_exit" != "$expect_exit" ] && ok=false
  if [ -n "$stderr_grep" ] && ! echo "$actual_stderr" | grep -q "$stderr_grep"; then
    ok=false
  fi

  if $ok; then
    echo "  PASS: $name"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $name (expected exit=$expect_exit, got=$actual_exit)"
    [ -n "$stderr_grep" ] && echo "         expected stderr ~ '$stderr_grep'"
    echo "         got stderr: $actual_stderr"
    FAIL=$((FAIL+1))
  fi
}

# ============================================================
# gate (f) — direct push to protected branch (default list)
# Default: main, staging, master, production, prod
# ============================================================
echo "## gate (f) — default protected branches"

run_test "git push origin main → BLOCK"       2 "git push origin main"       "main"
run_test "git push origin staging → BLOCK"    2 "git push origin staging"    "staging"
run_test "git push origin master → BLOCK"     2 "git push origin master"     "master"
run_test "git push origin production → BLOCK" 2 "git push origin production" "production"
run_test "git push origin prod → BLOCK"       2 "git push origin prod"       "prod"
run_test "git push -u origin staging → BLOCK" 2 "git push -u origin staging" "staging"

# ============================================================
# gate (f) — refspec / delete forms
# ============================================================
echo "## gate (f) — refspec and delete forms"

run_test "git push origin HEAD:main → BLOCK"      2 "git push origin HEAD:main"     "main"
run_test "git push origin feat/foo:staging → BLOCK" 2 "git push origin feat/foo:staging" "staging"
run_test "git push --delete origin main → BLOCK"  2 "git push --delete origin main" "main"
run_test "git push origin :main → BLOCK (delete remote main)" 2 "git push origin :main" "main"
# Force-push +refspec bypass: `git push origin +main` would set TARGET_REF=+main,
# which previously didn't match the protected list. The fix strips the `+` prefix.
run_test "git push origin +main → BLOCK (force-refspec bypass)" 2 "git push origin +main" "main"
run_test "git push origin +HEAD:staging → BLOCK" 2 "git push origin +HEAD:staging" "staging"

# ============================================================
# gate (f) — fallback to current branch when no explicit target
# Current branch = main → block
# ============================================================
echo "## gate (f) — current-branch fallback"

# Currently on main from git init.
run_test "git push (current=main) → BLOCK" 2 "git push" "main"
run_test "git push origin (current=main) → BLOCK" 2 "git push origin" "main"

# Switch to a feature branch — pushes without explicit target should pass.
git checkout --quiet -b feat/test-branch
make_marker
run_test "git push (current=feat/test-branch, marker present) → PASS" 0 "git push"
run_test "git push origin feat/test-branch (marker present) → PASS" 0 "git push origin feat/test-branch"
clean_marker

# Verify gate (c) still fires when marker is absent for unprotected branch.
run_test "git push (current=feat/, NO marker) → BLOCK by gate (c)" 2 "git push" "marker"

# ============================================================
# Custom protectedBranches config
# ============================================================
echo "## custom protectedBranches list"

cat > "$TEST_DIR/.claude/project-config.json" <<CFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "git": { "protectedBranches": ["dev", "release"] },
  "hooks": { "enabled": [] }
}
CFG

# 'dev' is now protected
run_test "custom: git push origin dev → BLOCK" 2 "git push origin dev" "dev"
run_test "custom: git push origin release → BLOCK" 2 "git push origin release" "release"

# 'main' is no longer protected with custom list — gate (f) passes,
# gate (c) still fires unless marker present
git checkout --quiet main
make_marker
run_test "custom: git push origin main (no longer in protected list, with marker) → PASS" \
  0 "git push origin main"
clean_marker

# Restore defaults
cat > "$TEST_DIR/.claude/project-config.json" <<CFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "hooks": { "enabled": [] }
}
CFG

# ============================================================
# gate (f) — empty list disables the gate
# ============================================================
echo "## empty protectedBranches list"

cat > "$TEST_DIR/.claude/project-config.json" <<CFG
{
  "version": "1",
  "monday": { "productId": "1" },
  "git": { "protectedBranches": [] },
  "hooks": { "enabled": [] }
}
CFG

git checkout --quiet -B main
make_marker
# Empty list = gate disabled. main push proceeds (gate c still validates marker).
run_test "empty list disables gate (f) → main PASSES with marker" 0 "git push origin main"
clean_marker
# Without marker, gate (c) still blocks (sanity check that empty doesn't bypass gate c).
run_test "empty list + no marker → BLOCK by gate (c)" 2 "git push origin main" "marker"

# ============================================================
# gate (c) opt-out: git.prePushMarker (pipeline Wave 1)
# ============================================================
echo "## gate (c) opt-out — git.prePushMarker"

# ── gate (c) opt-out: git.prePushMarker (pipeline Wave 1) ──────────────────
rm -f /tmp/.claude-prepush-main   # no marker for this branch

cat > "$TEST_DIR/.claude/project-config.json" <<CFG
{ "version": "1", "git": { "prePushMarker": false, "protectedBranches": [] } }
CFG
OUT=$(printf '{"tool_name":"Bash","tool_input":{"command":"git push -u origin main"}}' | "$HOOK" 2>&1); CODE=$?
if [ "$CODE" -eq 0 ]; then PASS=$((PASS+1)); echo "PASS: prePushMarker=false allows push without marker"
else FAIL=$((FAIL+1)); echo "FAIL: prePushMarker=false should allow push (exit $CODE): $OUT"; fi

cat > "$TEST_DIR/.claude/project-config.json" <<CFG
{ "version": "1", "git": { "protectedBranches": [] } }
CFG
OUT=$(printf '{"tool_name":"Bash","tool_input":{"command":"git push -u origin main"}}' | "$HOOK" 2>&1); CODE=$?
if [ "$CODE" -eq 2 ] && echo "$OUT" | grep -q "no validation marker"; then PASS=$((PASS+1)); echo "PASS: default still requires the marker"
else FAIL=$((FAIL+1)); echo "FAIL: default should block without marker (exit $CODE): $OUT"; fi

# ============================================================
# Cleanup
# ============================================================
cd /
rm -rf "$TEST_DIR"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
