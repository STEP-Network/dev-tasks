#!/bin/bash
# Tests for plugin/hooks/lib/resolve-agent-cwd.sh
#
# Run with: bash plugin/hooks/__tests__/resolve-agent-cwd.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/../lib/resolve-agent-cwd.sh"

if [ ! -f "$HELPER" ]; then
  echo "FATAL: helper not found at $HELPER"
  exit 1
fi

# shellcheck source=/dev/null
source "$HELPER"

PASS=0
FAIL=0

assert_eq() {
  local name="$1"
  local got="$2"
  local want="$3"
  if [ "$got" = "$want" ]; then
    echo "  PASS: $name"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $name"
    echo "         expected: '$want'"
    echo "         got:      '$got'"
    FAIL=$((FAIL+1))
  fi
}

# ============================================================
# Happy path: payload with cwd field
# ============================================================
echo "## happy path"

assert_eq "extracts cwd from payload" \
  "$(resolve_agent_cwd '{"cwd":"/Users/nate/worktree","tool_name":"Bash"}')" \
  "/Users/nate/worktree"

assert_eq "cwd with spaces (no quoting weirdness)" \
  "$(resolve_agent_cwd '{"cwd":"/Users/nate/path with spaces"}')" \
  "/Users/nate/path with spaces"

# ============================================================
# Empty / missing cases
# ============================================================
echo "## empty + missing"

assert_eq "missing cwd field returns empty" \
  "$(resolve_agent_cwd '{"tool_name":"Bash"}')" \
  ""

assert_eq "empty cwd field returns empty" \
  "$(resolve_agent_cwd '{"cwd":""}')" \
  ""

# JSON null vs missing key: both must yield empty string. Python's
# `.get('cwd', '')` returns '' for MISSING but None for explicit null —
# without the `or ''` coercion in the helper, print(None) emits 'None'
# and callers treat it as a valid path.
assert_eq "JSON null cwd returns empty (not 'None' string)" \
  "$(resolve_agent_cwd '{"cwd":null}')" \
  ""

assert_eq "empty JSON object returns empty" \
  "$(resolve_agent_cwd '{}')" \
  ""

assert_eq "empty input returns empty" \
  "$(resolve_agent_cwd '')" \
  ""

# ============================================================
# Malformed input
# ============================================================
echo "## malformed input"

assert_eq "non-JSON input returns empty (caught by try/except)" \
  "$(resolve_agent_cwd 'not json at all')" \
  ""

assert_eq "truncated JSON returns empty" \
  "$(resolve_agent_cwd '{"cwd": "/')" \
  ""

# ============================================================
# Defensive: ensures the helper survives weird shell injection attempts
# ============================================================
echo "## injection-resistant"

# Single quote in cwd value
assert_eq "single quote in cwd value (json-escaped)" \
  "$(resolve_agent_cwd '{"cwd":"/foo'"'"'bar"}')" \
  "/foo'bar"

# Newline in cwd value (encoded as \n in JSON)
assert_eq "newline in cwd value (JSON-encoded)" \
  "$(resolve_agent_cwd '{"cwd":"/foo\nbar"}')" \
  "/foo
bar"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
