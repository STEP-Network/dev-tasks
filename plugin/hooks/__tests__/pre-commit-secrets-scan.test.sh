#!/usr/bin/env bash
# Tests for plugin/hooks/pre-commit-secrets-scan.sh
#
# A commit's own added lines are scanned. A merge commit's own are what
# differs from the branch merged in (STEP-3340): that branch's lines were
# committed, and scanned, where they were written, and a merge of a moving
# base would otherwise carry every line the base gained since.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../pre-commit-secrets-scan.sh"

PASS=0
FAIL=0
check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc (expected exit $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

REPO="$(mktemp -d)"
trap 'rm -rf "$REPO"' EXIT
g() { git -C "$REPO" -c user.name=t -c user.email=t@localhost "$@" >/dev/null 2>&1; }
g init -q -b staging
mkdir -p "$REPO/.claude"
printf '{"hooks":{"enabled":["pre-commit-secrets-scan"]}}\n' > "$REPO/.claude/project-config.json"
printf 'one\n' > "$REPO/a.ts"
g add .
g commit -q -m base
g checkout -q -b STEP-7-x
printf 'the PR\n' > "$REPO/a.ts"
g commit -q -am "feat: the PR"
g checkout -q staging
# A fake key the base gained after the branch left it, as a fixture would.
printf 'const KEY = "sk-abcdefghijklmnopqrstuvwxyz"\n' > "$REPO/fixture.ts"
printf 'staging\n' > "$REPO/a.ts"
g add .
g commit -q -m "staging moves on"
g checkout -q STEP-7-x

run() {
  printf '{"tool_name":"Bash","tool_input":{"command":"git commit --no-edit"}}' |
    (cd "$REPO" && CLAUDE_PROJECT_DIR="$REPO" bash "$HOOK" >/dev/null 2>&1)
  echo $?
}

# run_from <dir> <command>: the hook for that command, its session sitting in <dir>.
run_from() {
  python3 -c 'import json, sys; print(json.dumps({"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}}))' "$2" |
    (cd "$1" && CLAUDE_PROJECT_DIR="$REPO" bash "$HOOK" >/dev/null 2>&1)
  echo $?
}

echo "pre-commit-secrets-scan"

# 1. A plain commit that adds the key: blocked.
cp "$REPO/a.ts" "$REPO/a.bak"
printf 'const KEY = "sk-abcdefghijklmnopqrstuvwxyz"\n' > "$REPO/own.ts"
g add own.ts
check "a commit adding a key → block" 2 "$(run)"
# The same commit behind -C, or a cd, from a session sitting elsewhere, is scanned in the repository it runs in (STEP-3354).
ELSEWHERE="$(mktemp -d)"
check "git -C <repo> commit, from elsewhere → block" 2 "$(run_from "$ELSEWHERE" "git -C $REPO commit -m x")"
check "cd <repo> && git commit, from elsewhere → block" 2 "$(run_from "$ELSEWHERE" "cd $REPO && git commit -m x")"
check "a heredoc message that mentions a commit is no commit → allow" 0 "$(run_from "$ELSEWHERE" "cat <<'EOF'
git commit -m x
EOF")"
rm -rf "$ELSEWHERE"
g rm -q --cached own.ts
rm -f "$REPO/own.ts" "$REPO/a.bak"

# 1b. A branch named MERGE_HEAD that holds the key is no merge (STEP-3351): still blocked.
printf 'const KEY = "sk-abcdefghijklmnopqrstuvwxyz"\n' > "$REPO/own.ts"
g add own.ts
g branch -f MERGE_HEAD "$(git -C "$REPO" -c user.name=t -c user.email=t@localhost commit-tree "$(git -C "$REPO" write-tree)" -p HEAD -m decoy)"
check "a branch named MERGE_HEAD holding the key → block" 2 "$(run)"
g branch -D MERGE_HEAD
g rm -q --cached own.ts
rm -f "$REPO/own.ts"

# 1c. A MERGE_HEAD file whose first line is no commit id is no merge (STEP-3351):
# an option there would reach git diff, and --output= writes where it names.
OUT="$(mktemp -d)"
MH="$(git -C "$REPO" rev-parse --absolute-git-dir)/MERGE_HEAD"
printf 'const KEY = "sk-abcdefghijklmnopqrstuvwxyz"\n' > "$REPO/own.ts"
g add own.ts
for line in "--output=$OUT/pwned" "not-a-commit"; do
  printf '%s\n' "$line" > "$MH"
  check "a MERGE_HEAD file reading '${line%%=*}…' is no merge → block" 2 "$(run)"
done
check "nothing is written where MERGE_HEAD's line names" 1 "$([ -e "$OUT/pwned" ]; echo $?)"
rm -f "$MH"
rm -rf "$OUT"
g rm -q --cached own.ts
rm -f "$REPO/own.ts"

# 2. A merge of the base, conflict resolved: the base's fixture is not this commit's.
g merge --no-ff --no-edit staging
printf 'the PR, and staging\n' > "$REPO/a.ts"
g add a.ts
check "a merge carrying the base's lines → allow" 0 "$(run)"

# 3. The same merge with a key in the resolution itself: still blocked.
printf 'const TOKEN = "sk-zyxwvutsrqponmlkjihgfedcba"\n' >> "$REPO/a.ts"
g add a.ts
check "a key added in the merge's own resolution → block" 2 "$(run)"

echo ""
echo "pre-commit-secrets-scan: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
