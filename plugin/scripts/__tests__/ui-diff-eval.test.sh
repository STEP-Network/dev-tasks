#!/bin/bash
# Tests for scripts/ui-diff-eval.sh and the shared hooks/lib/ui-globs.sh.
#
# Strategy: build a temp git repo with a base branch + a feature branch that
# changes a controlled set of files, run ui-diff-eval.sh, assert the verdict.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL="$SCRIPT_DIR/../ui-diff-eval.sh"
LIB="$SCRIPT_DIR/../../hooks/lib/ui-globs.sh"

[ ! -f "$EVAL" ] && { echo "FATAL: ui-diff-eval.sh not found"; exit 1; }
[ ! -f "$LIB" ] && { echo "FATAL: ui-globs.sh not found"; exit 1; }

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

# ---- Unit: path_is_ui ----
source "$LIB"
path_is_ui "src/components/Button.tsx" && r=0 || r=1; assert "components tsx is UI" "$r" "0"
path_is_ui "components/Foo.tsx"          && r=0 || r=1; assert "root components tsx is UI" "$r" "0"
path_is_ui "app/dashboard/page.tsx"      && r=0 || r=1; assert "app page is UI" "$r" "0"
path_is_ui "app/(group)/x/layout.tsx"    && r=0 || r=1; assert "app layout is UI" "$r" "0"
path_is_ui "styles/main.css"             && r=0 || r=1; assert "css is UI" "$r" "0"
path_is_ui "lib/email/welcome-templates.tsx" && r=0 || r=1; assert "email template is UI" "$r" "0"
path_is_ui "src/lib/util.ts"             && r=0 || r=1; assert "plain ts is NOT UI" "$r" "1"
path_is_ui "components/Button.test.tsx"  && r=0 || r=1; assert "test tsx is NOT UI" "$r" "1"
path_is_ui "e2e/flow.spec.ts"            && r=0 || r=1; assert "e2e spec is NOT UI" "$r" "1"
path_is_ui "src/__tests__/Button.tsx"    && r=0 || r=1; assert "__tests__ is NOT UI" "$r" "1"
path_is_ui ".claude/active-task.json"    && r=0 || r=1; assert ".claude is NOT UI" "$r" "1"
path_is_ui ""                            && r=0 || r=1; assert "empty path is NOT UI" "$r" "1"

# ---- Integration: ui-diff-eval.sh against a temp repo ----
make_repo() {
  TMP=$(mktemp -d)
  git -C "$TMP" init -q
  git -C "$TMP" config user.email t@e.com
  git -C "$TMP" config user.name t
  git -C "$TMP" config commit.gpgsign false 2>/dev/null
  mkdir -p "$TMP/src/components" "$TMP/src/lib"
  echo "base" > "$TMP/src/lib/util.ts"
  git -C "$TMP" add -A && git -C "$TMP" commit -q -m "init"
  git -C "$TMP" branch -m main 2>/dev/null
  git -C "$TMP" checkout -q -b feat 2>/dev/null
  echo "$TMP"
}

# Case A: feature branch changes a component → UI.
TMP=$(make_repo)
echo "export const B = () => null" > "$TMP/src/components/Button.tsx"
git -C "$TMP" add -A && git -C "$TMP" commit -q -m "ui change #1"
OUT=$( (cd "$TMP" && bash "$EVAL" --base main) ); RC=$?
assert "component change → exit 0" "$RC" "0"
assert_contains "verdict UI" "$OUT" "UI"
assert_contains "lists the component" "$OUT" "src/components/Button.tsx"
rm -rf "$TMP"

# Case B: feature branch changes only a plain .ts file → NON_UI.
TMP=$(make_repo)
echo "changed" > "$TMP/src/lib/util.ts"
git -C "$TMP" add -A && git -C "$TMP" commit -q -m "logic change #1"
OUT=$( (cd "$TMP" && bash "$EVAL" --base main) ); RC=$?
assert "non-UI change → exit 1" "$RC" "1"
assert_contains "verdict NON_UI" "$OUT" "NON_UI"
rm -rf "$TMP"

# Case C: a .css change → UI.
TMP=$(make_repo)
mkdir -p "$TMP/styles"
echo ".x{}" > "$TMP/styles/main.css"
git -C "$TMP" add -A && git -C "$TMP" commit -q -m "css change #1"
OUT=$( (cd "$TMP" && bash "$EVAL" --base main) ); RC=$?
assert "css change → exit 0" "$RC" "0"
assert_contains "css verdict UI" "$OUT" "UI"
rm -rf "$TMP"

# Case D: mixed UI + non-UI → UI (any UI file qualifies).
TMP=$(make_repo)
echo "x" > "$TMP/src/lib/util.ts"
echo "export const B = () => null" > "$TMP/src/components/Button.tsx"
git -C "$TMP" add -A && git -C "$TMP" commit -q -m "mixed change #1"
OUT=$( (cd "$TMP" && bash "$EVAL" --base main) ); RC=$?
assert "mixed change → exit 0" "$RC" "0"
rm -rf "$TMP"

# Case E: i18n-only diff (messages/*.json) → NON_UI by path, but UI under --force-ui.
TMP=$(make_repo)
mkdir -p "$TMP/messages"
echo '{"hello":"world"}' > "$TMP/messages/en.json"
git -C "$TMP" add -A && git -C "$TMP" commit -q -m "i18n change #1"
OUT=$( (cd "$TMP" && bash "$EVAL" --base main) ); RC=$?
assert "i18n-only change → exit 1 (NON_UI)" "$RC" "1"
assert_contains "i18n verdict NON_UI" "$OUT" "NON_UI"
OUT=$( (cd "$TMP" && bash "$EVAL" --base main --force-ui) ); RC=$?
assert "i18n-only + --force-ui → exit 0 (UI)" "$RC" "0"
assert_contains "forced verdict UI" "$OUT" "UI"
assert_contains "forced note present" "$OUT" "forced: UX-UI subtask override"
rm -rf "$TMP"

# Case F: --force-ui with a real UI file → still UI, lists the file + forced note.
TMP=$(make_repo)
echo "export const B = () => null" > "$TMP/src/components/Button.tsx"
git -C "$TMP" add -A && git -C "$TMP" commit -q -m "ui + force #1"
OUT=$( (cd "$TMP" && bash "$EVAL" --base main --force-ui) ); RC=$?
assert "force-ui + UI file → exit 0" "$RC" "0"
assert_contains "force-ui lists the component" "$OUT" "src/components/Button.tsx"
assert_contains "force-ui note present" "$OUT" "forced: UX-UI subtask override"
rm -rf "$TMP"

# Case G: EMPTY diff → NON_UI even under --force-ui (#3173683437). The override
# turns a NON_UI-by-path verdict into UI; it must not manufacture one where
# nothing changed. A freshly claimed UX-UI task carries --force-ui from the
# moment /pickup-task records its subtask types.
TMP=$(make_repo)
OUT=$( (cd "$TMP" && bash "$EVAL" --base main) ); RC=$?
assert "empty diff → exit 1 (NON_UI)" "$RC" "1"
assert_contains "empty diff verdict" "$OUT" "NON_UI: empty diff"
OUT=$( (cd "$TMP" && bash "$EVAL" --base main --force-ui) ); RC=$?
assert "empty diff + --force-ui → STILL exit 1 (NON_UI)" "$RC" "1"
assert_contains "empty diff + force-ui verdict" "$OUT" "NON_UI: empty diff"
# Negative control: one committed UI file on the same repo flips it back to UI,
# proving the guard keys on emptiness and not on something else.
echo "export const B = () => null" > "$TMP/src/components/Button.tsx"
git -C "$TMP" add -A && git -C "$TMP" commit -q -m "ui after empty"
OUT=$( (cd "$TMP" && bash "$EVAL" --base main --force-ui) ); RC=$?
assert "non-empty again → exit 0 (UI)" "$RC" "0"
rm -rf "$TMP"

# Case H: a dash-leading --base is sanitized to main, never reaching git as an
# option (git option injection). main..HEAD here is a real UI diff → UI.
TMP=$(make_repo)
echo "export const B = () => null" > "$TMP/src/components/Button.tsx"
git -C "$TMP" add -A && git -C "$TMP" commit -q -m "ui for injection case"
OUT=$( (cd "$TMP" && bash "$EVAL" --base "--output=$TMP/pwned") ); RC=$?
assert "dash-leading --base → sanitized to main, exit 0 (UI)" "$RC" "0"
assert_contains "sanitized base reported as main" "$OUT" "base: main"
[ ! -e "$TMP/pwned" ]; assert "dash-leading --base wrote no file" "$?" "0"
rm -rf "$TMP"

echo ""
echo "==================================================="
echo "ui-diff-eval tests: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "==================================================="
[ "$FAIL_COUNT" -eq 0 ]
