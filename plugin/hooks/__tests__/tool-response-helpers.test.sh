#!/usr/bin/env bash
# Unit tests for plugin/hooks/lib/tool_response_helpers.py
#
# Covers every PostToolUse tool_response shape variant:
#   - bare string
#   - dict with `content`
#   - dict with `output`
#   - dict with `text`
#   - dict with `content` as list of {text:...} parts
#   - dict with `content` as list of mixed parts
#   - list of parts (no enclosing dict)
#   - None / missing
#   - completely unknown shape (int, bool)
#
# Each case is a self-contained python3 heredoc that imports the helper and
# prints PASS / FAIL with the actual output. Heredoc avoids the bash word-split
# + brace-expansion hazards that come with passing Python dict literals as
# function arguments.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$SCRIPT_DIR/../lib"

PASS=0
FAIL=0

# Run one case: name, expected string, python expression yielding `resp`.
run_case() {
  local desc="$1"
  local expected="$2"
  local resp_expr="$3"
  local actual
  actual=$(LIB_DIR="$LIB_DIR" python3 - <<PYEOF
import os, sys
sys.path.insert(0, os.environ["LIB_DIR"])
from tool_response_helpers import extract_text
resp = $resp_expr
print(extract_text(resp))
PYEOF
)
  if [ "$actual" = "$expected" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

echo "tool-response-helpers.test.sh"

run_case "bare string passes through" \
  "hello world" \
  "'hello world'"

run_case "dict with content (string)" \
  "from content" \
  "{'content': 'from content'}"

run_case "dict with output (string) when content missing" \
  "from output" \
  "{'output': 'from output'}"

run_case "dict with text (string) when content/output missing" \
  "from text" \
  "{'text': 'from text'}"

run_case "content wins over output and text" \
  "wins" \
  "{'content': 'wins', 'output': 'loses1', 'text': 'loses2'}"

run_case "list of {text:...} parts joined with newlines" \
  "part one
part two" \
  "{'content': [{'text': 'part one'}, {'text': 'part two'}]}"

run_case "list of mixed parts: dicts stringified by text, non-dicts by str()" \
  "block
fallback" \
  "{'content': [{'text': 'block'}, 'fallback']}"

run_case "top-level list (no enclosing dict)" \
  "a
b" \
  "[{'text': 'a'}, {'text': 'b'}]"

run_case "empty dict returns empty string" \
  "" \
  "{}"

run_case "None returns empty string" \
  "" \
  "None"

run_case "int falls through to str()" \
  "42" \
  "42"

run_case "bool falls through to str()" \
  "True" \
  "True"

# Practical scenario: the Self-Review PASSED needle that post-self-review.sh
# searches for must remain findable after the helper normalizes a list-of-parts
# tool_response.
NEEDLE_CHECK=$(LIB_DIR="$LIB_DIR" python3 - <<'PYEOF'
import os, sys
sys.path.insert(0, os.environ["LIB_DIR"])
from tool_response_helpers import extract_text
resp = {"content": [{"text": "Iteration 1:"}, {"text": "Self-Review PASSED (iteration 1)"}]}
text = extract_text(resp)
print("found" if "Self-Review PASSED" in text else "missed")
PYEOF
)
if [ "$NEEDLE_CHECK" = "found" ]; then
  echo "  ✓ Self-Review PASSED needle survives dict-content extraction"
  PASS=$((PASS + 1))
else
  echo "  ✗ Self-Review PASSED needle survives dict-content extraction"
  echo "    expected: found"
  echo "    actual:   $NEEDLE_CHECK"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "  Total: $((PASS + FAIL)) — Passed: $PASS, Failed: $FAIL"
[ "$FAIL" -eq 0 ]
