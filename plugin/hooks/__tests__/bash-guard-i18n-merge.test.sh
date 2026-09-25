#!/bin/bash
# Gates (d) and (e) at a merge commit (STEP-3348): only what is new over both
# parents is the merge's own. A key the branch merged in already has, and a
# locale file it already changed, came with it: its own commits were checked
# where they were made. A key the merge adds itself is still checked.
#
# Run with: bash plugin/hooks/__tests__/bash-guard-i18n-merge.test.sh

set -u
unset DEV_TASKS_PROFILE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../bash-guard.sh"

PASS=0
FAIL=0
TEST_DIR=$(mktemp -d -t i18n-merge-XXXX)
TEST_HOME=$(mktemp -d -t i18n-merge-home-XXXX)
mkdir -p "$TEST_DIR/.claude" "$TEST_DIR/messages" "$TEST_HOME/.claude"
export HOME="$TEST_HOME"
export CLAUDE_PROJECT_DIR="$TEST_DIR"
printf '{ "profile": "agent" }' > "$TEST_HOME/.claude/dev-tasks-profile.json"

cleanup() { command rm -r -f "$TEST_DIR" "$TEST_HOME"; }
trap cleanup EXIT

cd "$TEST_DIR"
git init --quiet --initial-branch=main
git config user.email "test@example.com"
git config user.name "test"

cat > .claude/project-config.json <<'CFG'
{
  "version": "1",
  "git": { "defaultBase": "main", "protectedBranches": ["main"] },
  "i18n": {
    "enabled": true,
    "defaultLocale": "en",
    "locales": ["en", "da", "de"],
    "messagesGlob": "messages/*.json",
    "parityHookMode": "block"
  },
  "hooks": { "enabled": [] }
}
CFG

# One key per line, far apart, so the two sides never touch the same lines.
json() { printf '{\n  "a": "%s",\n  "b": "b",\n  "c": "c",\n  "d": "d",\n  "e": "e",\n  "f": "f",\n  "z": "%s"%b\n}\n' "$1" "$2" "${3:-}"; }
for f in en da de _meta; do json A Z > "messages/$f.json"; done
printf 'x\n' > app.ts
git add . && git commit --quiet -m init

# assert <exit> <what the refusal says, or ""> <label>: a refusal must be the gate named.
assert() {
  local expected="$1" says="$2" label="$3" code out
  out=$(printf '{"tool_name":"Bash","tool_input":{"command":"git commit --no-edit"}}' | bash "$HOOK" 2>&1)
  code=$?
  if [ "$code" = "$expected" ] && { [ -z "$says" ] || printf '%s' "$out" | grep -q "$says"; }; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected exit $expected, got $code)"
    FAIL=$((FAIL + 1))
  fi
}

# --- (d): main gains a key in en, da and de, but not in _meta.json (the drift).
git checkout --quiet -b feat
printf 'y\n' > app.ts
git commit --quiet -am "feat: the PR, no messages"
git checkout --quiet main
for f in en da de; do json A Z ',\n  "awaitingBody": "Body"' > "messages/$f.json"; done
git commit --quiet -am "main gains a key, _meta.json left behind"
git checkout --quiet feat

echo "--- gate (d) at a merge ---"
git merge --quiet --no-ff --no-commit main
assert 0 "" "a merge bringing in the base's keys commits, though _meta.json lacks one"
# A key the merge adds itself, in en only: still the merge's own.
json A Z ',\n  "awaitingBody": "Body",\n  "resolvedKey": "New"' > messages/en.json
git add messages/en.json
assert 2 "locale parity" "a key the merge adds itself, missing from the other locales, still blocks"
git merge --abort

echo "--- gate (d) outside a merge ---"
json A Z ',\n  "goodbye": "Goodbye"' > messages/en.json
git add messages/en.json
assert 2 "locale parity" "a commit's own new key, in en only, still blocks"
# A branch named MERGE_HEAD is no merge in progress, whatever it holds: the
# file git writes for one is (STEP-3351). Each branch holds the staged tree.
branch_like_staged() { git branch --quiet -f MERGE_HEAD "$(git commit-tree "$(git write-tree)" -p HEAD -m 'a branch named MERGE_HEAD')"; }
branch_like_staged
assert 2 "locale parity" "a branch named MERGE_HEAD holding the new key does not let it through (d)"
git branch --quiet -D MERGE_HEAD
git checkout --quiet HEAD -- messages/en.json
json A2 Z > messages/en.json
git add messages/en.json
branch_like_staged
assert 2 "completeness" "a branch named MERGE_HEAD holding the same file does not let a partial change through (e)"
git branch --quiet -D MERGE_HEAD
git checkout --quiet HEAD -- messages/en.json

# A MERGE_HEAD file whose first line is no commit id is no merge (STEP-3351):
# an option there would reach git diff, and --output= writes where it names.
MERGE_HEAD_FILE="$(git rev-parse --absolute-git-dir)/MERGE_HEAD"
written() {
  if [ -e "$1" ]; then echo "FAIL: $2"; FAIL=$((FAIL + 1)); else echo "PASS: $2"; PASS=$((PASS + 1)); fi
}
json A Z ',\n  "goodbye": "Goodbye"' > messages/en.json
git add messages/en.json
for line in "--output=$TEST_HOME/pwned-d" "not-a-commit"; do
  printf '%s\n' "$line" > "$MERGE_HEAD_FILE"
  assert 2 "locale parity" "a MERGE_HEAD file reading '${line%%=*}…' is no merge: the new key still blocks (d)"
done
written "$TEST_HOME/pwned-d" "nothing is written where MERGE_HEAD's line names (d)"
git checkout --quiet HEAD -- messages/en.json
json A2 Z > messages/en.json
git add messages/en.json
printf -- '--output=%s\n' "$TEST_HOME/pwned-e" > "$MERGE_HEAD_FILE"
assert 2 "completeness" "a MERGE_HEAD file reading '--output…' is no merge: a partial change still blocks (e)"
written "$TEST_HOME/pwned-e" "nothing is written where MERGE_HEAD's line names (e)"
rm -f "$MERGE_HEAD_FILE"
git checkout --quiet HEAD -- messages/en.json

# --- (e): main changes values in da and de only; the PR touches no messages.
git checkout --quiet main
json "A2" Z ',\n  "awaitingBody": "Body"' > messages/da.json
json "A3" Z ',\n  "awaitingBody": "Body"' > messages/de.json
git commit --quiet -am "main rewords a string in da and de"
git checkout --quiet feat

echo "--- gate (e) at a merge ---"
git merge --quiet --no-ff --no-commit main
assert 0 "" "a merge bringing in the base's changes to some locales commits"
# The merge itself changes en only: its own partial change still blocks, da and de being the base's.
json "A4" Z ',\n  "awaitingBody": "Body"' > messages/en.json
git add messages/en.json
assert 2 "completeness" "a merge that changes one locale itself still blocks"
git merge --abort

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
