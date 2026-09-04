#!/bin/bash
# Tests for plugin/hooks/lib/gh-checks.sh
#
# Run with: bash plugin/hooks/__tests__/gh-checks.test.sh
#
# WHAT THESE PIN, and why the existing hook tests could not.
#
# stop-ci-green-check.test.sh stubs `gh` with a fixture that always prints JSON,
# so it passed identically before and after this fix — it never exercised the
# failure shape at all. The bug (#3200367976) was that `gh` EXITS 0 on a
# statusCheckRollup refusal while printing NOTHING to stdout, and every caller
# treated that as "this PR has no checks yet".
#
# So the case that matters here is the one no other test creates: a stub that
# exits 0 with empty stdout and an auth error on stderr.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/../lib/gh-checks.sh"

if [ ! -f "$HELPER" ]; then
  echo "FATAL: helper not found at $HELPER"
  exit 1
fi

# shellcheck source=/dev/null
source "$HELPER"

PASS=0
FAIL=0

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "  PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name"
    echo "         expected: '$want'"
    echo "         got:      '$got'"
    FAIL=$((FAIL + 1))
  fi
}

STUB_DIR=$(mktemp -d)
export PATH="$STUB_DIR:$PATH"

# Write a fake `gh` whose behaviour depends on whether a token is in the env.
# $1 = what to do when a token IS set, $2 = what to do when it is NOT.
make_gh() {
  cat >"$STUB_DIR/gh" <<STUB
#!/bin/bash
if [ -n "\${GH_TOKEN:-}" ] || [ -n "\${GITHUB_TOKEN:-}" ]; then
  $1
else
  $2
fi
STUB
  chmod +x "$STUB_DIR/gh"
}

# ============================================================
# The bug shape: exit 0, empty stdout, auth error on stderr
# ============================================================
echo "## the refusal shape (exit 0 + empty stdout)"

make_gh \
  'echo "GraphQL: Resource not accessible by personal access token" >&2; exit 0' \
  'echo "[{\"bucket\":\"pass\",\"name\":\"Test\"}]"; exit 0'

GH_TOKEN=fine_grained_pat
export GH_TOKEN
OUT=$(gh_pr_checks 123 --json name,bucket)
RC=$?
assert_eq "falls back and recovers the payload" "$OUT" '[{"bucket":"pass","name":"Test"}]'
assert_eq "returns 0 on a successful fallback" "$RC" "0"

# A zero exit with empty stdout must NOT be reported as success. This is the
# single assertion that would have caught the original defect.
make_gh \
  'echo "GraphQL: Resource not accessible by personal access token" >&2; exit 0' \
  'exit 0'
OUT=$(gh_pr_checks 123 --json name,bucket 2>/dev/null)
RC=$?
assert_eq "zero exit + empty stdout is a FAILURE, not success" "$RC" "1"
assert_eq "prints nothing to stdout on failure" "$OUT" ""

# ============================================================
# CI: the ambient token is the ONLY credential and it works
# ============================================================
echo "## github actions shape (ambient token works)"

make_gh \
  'echo "[{\"bucket\":\"pass\",\"name\":\"CI\"}]"; exit 0' \
  'echo "gh: no credential" >&2; exit 1'

GITHUB_TOKEN=actions_token
export GITHUB_TOKEN
unset GH_TOKEN
OUT=$(gh_pr_checks 123 --json name,bucket)
assert_eq "uses the ambient token when it works (never clears it)" \
  "$OUT" '[{"bucket":"pass","name":"CI"}]'
unset GITHUB_TOKEN

# ============================================================
# A genuine error is surfaced, not swallowed
# ============================================================
echo "## genuine failures stay loud"

cat >"$STUB_DIR/gh" <<'STUB'
#!/bin/bash
echo "GraphQL: Could not resolve to a PullRequest with the number of 999999." >&2
exit 1
STUB
chmod +x "$STUB_DIR/gh"

ERRFILE=$(mktemp)
OUT=$(gh_pr_checks 999999 --json name,bucket 2>"$ERRFILE")
RC=$?
assert_eq "returns non-zero on a real error" "$RC" "1"
if grep -q "Could not resolve to a PullRequest" "$ERRFILE"; then
  echo "  PASS: passes the underlying stderr through"
  PASS=$((PASS + 1))
else
  echo "  FAIL: stderr was swallowed — the exact hole this helper closes"
  FAIL=$((FAIL + 1))
fi
rm -f "$ERRFILE"

# ============================================================
# gh_pr_view_checks shares the behaviour
# ============================================================
echo "## gh_pr_view_checks"

make_gh \
  'echo "Resource not accessible by personal access token" >&2; exit 0' \
  'echo "{\"state\":\"OPEN\"}"; exit 0'
GH_TOKEN=fine_grained_pat
export GH_TOKEN
assert_eq "pr view falls back too" \
  "$(gh_pr_view_checks 123 --json state)" '{"state":"OPEN"}'
unset GH_TOKEN

rm -rf "$STUB_DIR"

echo ""
echo "gh-checks.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
