#!/usr/bin/env bash
# Tests for auto-merge-policy-gate.sh — enforces git.autoMergePolicy on `gh pr merge`.
#
# `gh` is mocked via PATH override (same convention as pre-merge-review-gate.test.sh).
# CLAUDE_PROJECT_DIR points at a per-case temp project so config-reader.sh reads a
# controlled .claude/project-config.json. No network, no MONDAY_API_KEY.

set -u
shopt -s nullglob

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$(cd "$TEST_DIR/.." && pwd)/auto-merge-policy-gate.sh"

[ -f "$HOOK" ] || { echo "FAIL: hook not found at $HOOK" >&2; exit 1; }

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1" >&2; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d -t auto-merge-gate-XXXX)"
trap 'rm -rf "$WORK"' EXIT

CASE=0

# run_gate <policy_json|""> <mock_branch|"FAIL"> <command> [enabled=yes]
# Echoes hook stdout+stderr; returns the hook's exit code.
run_gate() {
  local policy="$1" mock_branch="$2" cmd="$3" enabled="${4:-yes}"
  CASE=$((CASE + 1))
  local sandbox="$WORK/case-$CASE"
  mkdir -p "$sandbox/proj/.claude" "$sandbox/bin"

  local enabled_arr='[]'
  [ "$enabled" = "yes" ] && enabled_arr='["auto-merge-policy-gate"]'

  local git_block='"git": {}'
  [ -n "$policy" ] && git_block="\"git\": { \"autoMergePolicy\": $policy }"

  cat > "$sandbox/proj/.claude/project-config.json" <<EOF
{ "hooks": { "enabled": $enabled_arr }, $git_block }
EOF

  if [ "$mock_branch" = "FAIL" ]; then
    printf '#!/bin/bash\nexit 1\n' > "$sandbox/bin/gh"
  elif [ "${mock_branch#NUMONLY:}" != "$mock_branch" ]; then
    # Echo the branch only when gh is invoked WITH a numeric arg (an explicit PR
    # number); fail otherwise — simulates "current branch has no open PR". Lets a
    # test prove the PR-number was actually extracted from the command.
    printf '#!/bin/bash\ncase "$*" in *[0-9]*) echo "%s" ;; *) exit 1 ;; esac\n' "${mock_branch#NUMONLY:}" > "$sandbox/bin/gh"
  else
    printf '#!/bin/bash\necho "%s"\n' "$mock_branch" > "$sandbox/bin/gh"
  fi
  chmod +x "$sandbox/bin/gh"

  local input
  input=$(printf '{"tool_input":{"command":"%s"},"cwd":"%s"}' "$cmd" "$sandbox/proj")
  CLAUDE_PROJECT_DIR="$sandbox/proj" PATH="$sandbox/bin:$PATH" bash "$HOOK" <<<"$input" 2>&1
}

# -------------------------------------------------------------------
echo "==> Test 1: command is not 'gh pr merge' → allows"
ec=0; out=$(run_gate '{"main":"never"}' "main" "git push origin main") || ec=$?
if [ $ec -eq 0 ]; then pass "non-merge command passes (ec=0)"; else fail "expected 0 (got $ec: $out)"; fi

# -------------------------------------------------------------------
echo "==> Test 2: no autoMergePolicy configured → allows (no opinion)"
ec=0; out=$(run_gate "" "main" "gh pr merge 42 --admin --squash") || ec=$?
if [ $ec -eq 0 ]; then pass "absent policy passes"; else fail "expected 0 (got $ec: $out)"; fi

# -------------------------------------------------------------------
echo "==> Test 3: policy 'never' for target branch → blocks"
ec=0; out=$(run_gate '{"main":"never"}' "main" "gh pr merge 42 --admin --squash") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q 'autoMergePolicy "never"'; then
  pass "never blocks with message"
else
  fail "expected 2 + never message (got $ec: $out)"
fi

# -------------------------------------------------------------------
echo "==> Test 4: policy 'manual-only' for target branch → blocks"
ec=0; out=$(run_gate '{"staging":"manual-only"}' "staging" "gh pr merge 7 --squash") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q 'manual-only'; then
  pass "manual-only blocks"
else
  fail "expected 2 + manual-only message (got $ec: $out)"
fi

# -------------------------------------------------------------------
echo "==> Test 5: policy 'auto-after-checks-and-review' → allows"
ec=0; out=$(run_gate '{"staging":"auto-after-checks-and-review"}' "staging" "gh pr merge 7 --admin --squash") || ec=$?
if [ $ec -eq 0 ]; then pass "auto-after-checks-and-review allows"; else fail "expected 0 (got $ec: $out)"; fi

# -------------------------------------------------------------------
echo "==> Test 6: target branch absent from policy → allows (no opinion)"
ec=0; out=$(run_gate '{"main":"never"}' "feat/some-feature" "gh pr merge 9 --squash") || ec=$?
if [ $ec -eq 0 ]; then pass "unlisted branch passes"; else fail "expected 0 (got $ec: $out)"; fi

# -------------------------------------------------------------------
echo "==> Test 7: unrecognized policy value (e.g. 'manual') → blocks (fail safe)"
ec=0; out=$(run_gate '{"staging":"manual"}' "staging" "gh pr merge 7 --squash") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q 'unrecognized autoMergePolicy'; then
  pass "invalid value blocks + lists valid values"
else
  fail "expected 2 + unrecognized message (got $ec: $out)"
fi

# -------------------------------------------------------------------
echo "==> Test 8: base branch unresolvable (gh offline) → allows (fail open)"
ec=0; out=$(run_gate '{"main":"never"}' "FAIL" "gh pr merge 42 --admin --squash") || ec=$?
if [ $ec -eq 0 ]; then pass "gh-unresolvable fails open"; else fail "expected 0 (got $ec: $out)"; fi

# -------------------------------------------------------------------
echo "==> Test 9: hook not in hooks.enabled[] → inert (allows even 'never')"
ec=0; out=$(run_gate '{"main":"never"}' "main" "gh pr merge 42 --admin --squash" "no") || ec=$?
if [ $ec -eq 0 ]; then pass "disabled hook is inert"; else fail "expected 0 when disabled (got $ec: $out)"; fi

# -------------------------------------------------------------------
echo "==> Test 10: 'never' resolved for a no-PR-number merge → blocks"
ec=0; out=$(run_gate '{"main":"never"}' "main" "gh pr merge --admin --squash") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q 'current branch'; then
  pass "no-PR-number merge resolves current branch + blocks"
else
  fail "expected 2 + current-branch label (got $ec: $out)"
fi

# -------------------------------------------------------------------
# -------------------------------------------------------------------
echo "==> Test 11: explicit PR number AFTER flags ('gh pr merge --squash 42') is extracted → blocks"
# Mock resolves a branch ONLY when gh gets a numeric PR arg; if the regex misses
# the number the hook falls back to current-branch (no PR) and fails open. So a
# block here proves '42' was extracted despite the leading flags.
ec=0; out=$(run_gate '{"main":"never"}' "NUMONLY:main" "gh pr merge --squash 42") || ec=$?
if [ $ec -eq 2 ] && echo "$out" | grep -q '#42'; then
  pass "flags-before-number PR is extracted + blocked"
else
  fail "expected 2 + PR #42 label (got $ec: $out)"
fi

# -------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
