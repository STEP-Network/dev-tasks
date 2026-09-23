#!/bin/bash
# The four hooks retired in 1.0 (spec section 10) must be gone from disk AND
# from hooks.json. A registration pointing at a deleted script is a hook that
# fails to execute on every single tool call, which reads as a broken plugin
# rather than a retired hook — so the third block below walks every surviving
# registration and asserts the file it names exists.
#
# Run with: bash plugin/hooks/__tests__/retired-hooks.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOKS_DIR="$SCRIPT_DIR/.."
PLUGIN_ROOT="$HOOKS_DIR/.."
HOOKS_JSON="$HOOKS_DIR/hooks.json"

PASS=0
FAIL=0

RETIRED="stop-task-check stop-task-logic post-self-review parse-self-review-output subtask-reminder subtask-progress-gate"

echo "--- the scripts are deleted ---"
for name in $RETIRED; do
  hit=$(ls "$HOOKS_DIR/$name".* 2>/dev/null | head -1)
  if [ -z "$hit" ]; then
    echo "PASS: $name is gone"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name still present at $hit"
    FAIL=$((FAIL + 1))
  fi
done

echo "--- hooks.json references none of them ---"
for name in $RETIRED; do
  if grep -q "$name" "$HOOKS_JSON"; then
    echo "FAIL: hooks.json still registers $name"
    FAIL=$((FAIL + 1))
  else
    echo "PASS: hooks.json does not register $name"
    PASS=$((PASS + 1))
  fi
done

echo "--- every remaining registration points at a file that exists ---"
missing=0
for cmd in $(jq -r '.hooks | to_entries[] | .value[] | .hooks[] | .command' "$HOOKS_JSON"); do
  rel="${cmd#\$\{CLAUDE_PLUGIN_ROOT\}/}"
  if [ ! -f "$PLUGIN_ROOT/$rel" ]; then
    echo "FAIL: registration points at a missing file: $rel"
    missing=$((missing + 1))
  fi
done
if [ "$missing" -eq 0 ]; then
  echo "PASS: every registration resolves to a real file"
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + missing))
fi

echo "--- the survivors are still registered ---"
for name in bash-guard worktree-required worktree-path-boundary pre-commit-secrets-scan protect-sensitive-files stop-ci-green-check rule-autoload; do
  if grep -q "$name" "$HOOKS_JSON"; then
    echo "PASS: $name still registered"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name lost its registration"
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
