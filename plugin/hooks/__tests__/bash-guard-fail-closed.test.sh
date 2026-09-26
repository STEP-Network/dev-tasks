#!/bin/bash
# bash-guard fails closed (STEP-3354): a check that cannot run blocks the
# command, never lets it through. For each gate, a forced failure blocks: input
# that is not the payload, no python3, no jq, a project config that cannot be
# read, a command it cannot parse, a git error, a snippet that raises. And
# gate (f) reads every branch a push names, so none of them reaches main.
#
# Run with: bash plugin/hooks/__tests__/bash-guard-fail-closed.test.sh

set -u
unset DEV_TASKS_PROFILE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../bash-guard.sh"

PASS=0
FAIL=0
TEST_DIR=$(mktemp -d -t bash-guard-closed-XXXX)
TEST_HOME=$(mktemp -d -t bash-guard-closed-home-XXXX)
NOT_GIT=$(mktemp -d -t bash-guard-closed-nogit-XXXX)
mkdir -p "$TEST_DIR/.claude" "$TEST_DIR/messages" "$TEST_HOME/.claude"
export HOME="$TEST_HOME"
export CLAUDE_PROJECT_DIR="$TEST_DIR"
cleanup() { command rm -r -f "$TEST_DIR" "$TEST_HOME" "$NOT_GIT" "$SHIMS" /tmp/.claude-prepush-feat-x; }
SHIMS=$(mktemp -d -t bash-guard-closed-shims-XXXX)
trap cleanup EXIT

# A PATH with every tool the hook uses, but for the one named.
shims_without() {
  local dir="$SHIMS/without-$1" tool
  mkdir -p "$dir"
  for tool in cat dirname grep head tail tr sed git python3 jq; do
    [ "$tool" = "$1" ] && continue
    ln -sf "$(command -v "$tool")" "$dir/$tool"
  done
  printf '%s' "$dir"
}

cd "$TEST_DIR"
git init --quiet --initial-branch=main
git config user.email "test@example.com"
git config user.name "test"
config() { printf '%s\n' "$1" > .claude/project-config.json; }
config '{ "version": "1", "hooks": { "enabled": [] } }'
printf '{"hello":"Hello"}\n' > messages/en.json
printf 'x\n' > app.ts
git add . && git commit --quiet -m init
git checkout --quiet -b feat/x
# Gate (c)'s marker for this branch, so a push it lets through gets to 0.
marker() { git rev-parse HEAD > "/tmp/.claude-prepush-$(git rev-parse --abbrev-ref HEAD | tr '/' '-')"; }
marker

payload() { python3 -c 'import json, sys; print(json.dumps({"tool_name": "Bash", "tool_input": {"command": sys.argv[1]}, "cwd": sys.argv[2]}))' "$1" "${2:-$TEST_DIR}"; }

# check <exit> <what the output says, or ""> <label> <raw stdin> [PATH]
check() {
  local expected="$1" says="$2" label="$3" input="$4" path="${5:-$PATH}" out code
  out=$(printf '%s' "$input" | PATH="$path" /bin/bash "$HOOK" 2>&1)
  code=$?
  if [ "$code" = "$expected" ] && { [ -z "$says" ] || printf '%s' "$out" | grep -q "$says"; }; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected exit $expected${says:+ saying '$says'}, got $code): $(printf '%s' "$out" | head -n 2)"
    FAIL=$((FAIL + 1))
  fi
}

echo "--- the command parse ---"
check 2 "could not check" "input that is not JSON blocks" 'not json'
check 2 "could not check" "a payload with no command blocks" '{"tool_name":"Bash","tool_input":{}}'
check 2 "python3 is not on PATH" "no python3 blocks, git push origin main from a feature branch included" "$(payload 'git push origin main')" "$(shims_without python3)"
check 0 "" "an empty command runs nothing, and passes" "$(payload '')"

echo "--- gate (f): the project config ---"
check 2 "jq is not on PATH" "no jq blocks a push when the config is there" "$(payload 'git push origin feat/x')" "$(shims_without jq)"
config '{ "version": "1", "git": { "protectedBranches": '
check 2 "cannot read" "a config that is not JSON blocks git push origin main, whose marker is valid" "$(payload 'git push origin main')"
config '{ "version": "1", "git": { "protectedBranches": [1, {"a": 2}] } }'
check 2 "cannot read" "a list jq cannot join blocks" "$(payload 'git push origin feat/x')"
command rm -f .claude/project-config.json
check 2 "protected branch 'main'" "no config at all: the default list, and main is refused" "$(payload 'git push origin main')"
config '{ "version": "1", "hooks": { "enabled": [] } }'

echo "--- gate (f): the push's targets ---"
check 2 "could not check" "an unclosed quote blocks the push: git push origin \"main" "$(payload 'git push origin "main')"
check 2 "protected branch 'main'" "a second refspec: git push origin feat/x main" "$(payload 'git push origin feat/x main')"
check 2 "protected branch 'main'" "an option's value: git push -o ci.skip origin main" "$(payload 'git push -o ci.skip origin main')"
check 2 "protected branch 'main'" "a second push: ... && git push origin main" "$(payload 'git push origin feat/x && git push origin main')"
check 2 "protected branch 'main'" "a global option: git -C . push origin main" "$(payload 'git -C . push origin main')"
check 2 "protected branch 'main'" "a full ref: git push origin refs/heads/main" "$(payload 'git push origin refs/heads/main')"
check 2 "protected branch 'staging'" "a quoted refspec: git push origin 'HEAD:staging'" "$(payload "git push origin 'HEAD:staging'")"
check 2 "every branch" "git push --all origin" "$(payload 'git push --all origin')"
check 2 "every branch" "git push --mirror origin" "$(payload 'git push --mirror origin')"
check 0 "" "a feature branch by name still goes: git push origin feat/x" "$(payload 'git push origin feat/x')"
check 0 "" "and with an option's value: git push -o ci.skip -u origin feat/x" "$(payload 'git push -o ci.skip -u origin feat/x')"
check 0 "" "a commit message that names git push is no push" "$(payload 'git commit --allow-empty -m "docs: git push origin main"')"
check 2 "could not name the branch" "an implicit push outside git blocks" "$(payload 'git push' "$NOT_GIT")"
# On main, a push that names only a remote, behind an option's value, is main's.
git checkout --quiet main
check 2 "protected branch 'main'" "on main: git push -o ci.skip origin" "$(payload 'git push -o ci.skip origin')"
check 2 "protected branch 'main'" "on main: git push origin HEAD" "$(payload 'git push origin HEAD')"
git checkout --quiet feat/x

echo "--- a commit message is text, and what bash runs is read (#151 review) ---"
check 0 "" "a heredoc commit whose message says push commits" "$(payload "git commit --allow-empty -F - <<'EOF'
fix: don't push twice
EOF")"
check 0 "" "a -m \"\$(cat <<'EOF'…)\" message with an odd quote commits" "$(payload "git commit --allow-empty -m \"\$(cat <<'EOF'
fix: a \" and git push origin main
EOF
)\"")"
check 2 "protected branch 'main'" "a push in backticks" "$(payload 'echo `git push origin main`')"
check 2 "protected branch 'main'" "a push in \$(...)" "$(payload 'echo "$(git push origin main)"')"
check 2 "every branch" "git push origin : (matching branches)" "$(payload 'git push origin :')"
check 2 "every branch" "a glob refspec" "$(payload "git push origin 'refs/heads/*:refs/heads/*'")"
check 2 "every branch" "git -c push.default=matching push origin" "$(payload 'git -c push.default=matching push origin')"
check 2 "every branch" "git -c remote.origin.push=refs/heads/main push origin" "$(payload 'git -c remote.origin.push=refs/heads/main push origin')"
check 2 "protected branch 'main'" "a push on the second line" "$(payload 'git status
git push origin main')"
check 2 "protected branch 'staging'" "a push on the line after a heredoc" "$(payload "cat <<'EOF'
text
EOF
git push origin staging")"
check 2 "protected branch 'main'" "if …; then git push origin main; fi" "$(payload 'if true; then git push origin main; fi')"
check 2 "protected branch 'main'" "for …; do git push origin main; done" "$(payload 'for b in a; do git push origin main; done')"
check 2 "protected branch 'main'" "gi''t push origin main" "$(payload "gi''t push origin main")"
check 2 "protected branch 'main'" "a tab before git" "$(payload "$(printf '\tgit push origin main')")"
check 2 "protected branch 'main'" "\\git push origin main" "$(payload '\git push origin main')"
check 0 "" "arithmetic and \$'…' read, and the commit goes" "$(payload "x=\$((1<<2)); git commit --allow-empty -m \$'it\\'s done'")"
# A second checkout on main, while the session's own is on feat/x.
MAIN_WT="$NOT_GIT/main-wt"
git worktree add --quiet "$MAIN_WT" main
check 2 "protected branch 'main'" "git -C <a checkout on main> push origin HEAD: its branch, not the session's" "$(payload "git -C $MAIN_WT push origin HEAD")"
check 2 "protected branch 'main'" "cd <a checkout on main> && git push" "$(payload "cd $MAIN_WT && git push")"
check 0 "" "git -C <this checkout> push origin HEAD still goes" "$(payload "git -C $TEST_DIR push origin HEAD")"
check 2 "cannot tell which branch" "a push from --git-dir" "$(payload "git --git-dir=$MAIN_WT/.git push origin HEAD")"
check 2 "cannot tell which branch" "echo main | xargs git push origin: xargs adds the branch" "$(payload 'echo main | xargs git push origin')"
check 2 "protected branch 'main'" "\$'git' push origin main" "$(payload "\$'git' push origin main")"
check 2 "protected branch 'main'" "\$'\\x67it' push origin main" "$(payload "\$'\\x67it' push origin main")"
check 0 "" "\$'git' push origin feat/x still goes" "$(payload "\$'git' push origin feat/x")"
check 2 "protected branch 'main'" "\$'git\\0junk' push origin main: a NUL ends the word" "$(payload "\$'git\\0junk' push origin main")"
check 2 "protected branch 'main'" "git push origin \$'main\\x00x'" "$(payload "git push origin \$'main\\x00x'")"
check 2 "protected branch 'main'" "git push origin \$'main\\0'-x: zsh pushes main" "$(payload "git push origin \$'main\\0'-x")"
check 2 "cannot tell which branch" "xargs sh -c 'git push origin \"\$0\"'" "$(payload "echo main | xargs sh -c 'git push origin \"\$0\"'")"
check 2 "cannot tell which branch" "find main -exec git push origin {} \\;" "$(payload 'find main -maxdepth 0 -exec git push origin {} \;')"
check 2 "cannot tell which branch" "B=main; git push origin \$B" "$(payload 'B=main; git push origin $B')"
check 2 "cannot tell which branch" "git push origin \"\$(git branch --show-current)\"" "$(payload 'git push origin "$(git branch --show-current)"')"

echo "--- gate (a): what the command runs, never its text (#151 review) ---"
check 0 "" "grep -n \"rm -rf\"" "$(payload 'grep -n "rm -rf" app.ts')"
check 0 "" "grep -rn \"git reset --hard\" docs/" "$(payload 'grep -rn "git reset --hard" docs/')"
check 0 "" "git checkout .github/workflows/ci.yml" "$(payload 'git checkout .github/workflows/ci.yml')"
check 0 "" "gh pr create --body \"Never run git push --force…\"" "$(payload 'gh pr create --body "Never run git push --force on main"')"
check 0 "" "a heredoc message that names git reset --hard" "$(payload "git commit --allow-empty -F - <<'EOF'
docs: never run git reset --hard or rm -rf here
EOF")"
check 0 "" "git branch -d (a merged branch)" "$(payload 'git branch -d merged')"
check 0 "" "rm -r -- -f: after --, -f is a file" "$(payload 'rm -r -- -f')"
check 2 "Destructive command detected: 'rm -rf'" "rm -rf -- build" "$(payload 'rm -rf -- build')"
check 2 "Destructive command detected: 'rm -rf'" "\$'rm' -rf x" "$(payload "\$'rm' -rf x")"
check 2 "Destructive command detected: 'rm -rf'" "rm -rf /" "$(payload 'rm -rf /')"
check 2 "Destructive command detected: 'rm -rf'" "rm -r -f build" "$(payload 'rm -r -f build')"
check 2 "Destructive command detected: 'git reset --hard'" "git reset --hard" "$(payload 'git reset --hard HEAD')"
check 2 "Destructive command detected: 'git push --force'" "git push --force" "$(payload 'git push --force origin feat/x')"
check 2 "Destructive command detected: 'git push -f'" "git push -f" "$(payload 'git push -f origin feat/x')"
check 2 "Destructive command detected: 'git checkout" "git checkout ." "$(payload 'git checkout .')"
check 2 "Destructive command detected: 'git checkout" "git checkout -- ." "$(payload 'git checkout -- .')"
check 2 "Destructive command detected: 'git clean -f'" "git clean -fd" "$(payload 'git clean -fd')"
check 2 "Destructive command detected: 'git clean -f'" "git clean -df" "$(payload 'git clean -df')"
check 2 "Destructive command detected: 'git branch -D'" "git branch -D" "$(payload 'git branch -D old')"
check 2 "Destructive command detected: 'rm -rf'" "find -exec rm -rf" "$(payload 'find . -name x -exec rm -rf {} \;')"
check 2 "Destructive command detected: 'rm -rf'" "xargs rm -rf" "$(payload 'ls | xargs rm -rf')"
check 2 "Destructive command detected: 'rm -rf'" "bash -c 'rm -rf /'" "$(payload "bash -c 'rm -rf /'")"
check 2 "protected branch 'main'" "sh -c \"git push origin main\"" "$(payload 'sh -c "git push origin main"')"
check 2 "could not check" "an rm it cannot read: rm -rf \"build" "$(payload 'rm -rf "build')"
check 0 "" "a command with neither git nor rm that it cannot read is bash's to reject" "$(payload 'echo "unclosed')"

echo "--- gates (d) and (e): i18n, agent profile ---"
printf '{ "profile": "agent" }' > "$TEST_HOME/.claude/dev-tasks-profile.json"
config '{ "version": "1", "git": { "defaultBase": "main" }, "i18n": { "enabled": true, "defaultLocale": "en", "locales": ["en", "da"], "messagesGlob": "messages/*.json", "parityHookMode": "block" }, "hooks": { "enabled": [] } }'
printf '{"hello":"Hello","bye":"Bye"}\n' > messages/en.json
printf '{"hello":"Hej","bye":"Farvel"}\n' > messages/da.json
git add messages
check 0 "" "a complete change commits" "$(payload 'git commit -m both')"
# A locale file that is a directory: reading it raises, and no verdict comes.
mkdir -p messages/xx.json
check 2 "locale parity check did not finish" "(d): a snippet that raises blocks" "$(payload 'git commit -m both')"
command rm -r -f messages/xx.json
check 2 "git could not list the staged files" "(d): a git error blocks" "$(payload 'git commit -m both' "$NOT_GIT")"
# A commit behind -C is checked in its own checkout: a new key there, missing from da, blocks.
printf '{\n  "hello": "Hello",\n  "only": "Only here"\n}\n' > "$MAIN_WT/messages/en.json"
printf '{"hello":"Hej"}\n' > "$MAIN_WT/messages/da.json"
git -C "$MAIN_WT" add messages
check 2 "locale parity" "(d): git -C <dir> commit is checked in <dir>" "$(payload "git -C $MAIN_WT commit -m x")"
check 2 "locale parity" "(d): cd <dir> && git commit is checked in <dir>" "$(payload "cd $MAIN_WT && git commit -m x")"
check 2 "locale parity" "(d): git add on one line, git commit on the next" "$(payload "git -C $MAIN_WT add messages
git -C $MAIN_WT commit -m x")"
git -C "$MAIN_WT" reset --quiet
config '{ "version": "1", "git": { "defaultBase": "no-such-base" }, "i18n": { "enabled": true, "defaultLocale": "en", "locales": ["en", "da"], "messagesGlob": "messages/*.json", "parityHookMode": "block" }, "hooks": { "enabled": [] } }'
check 2 "completeness check did not finish" "(e): a base it cannot find blocks" "$(payload 'git commit -m both')"
config '{ "version": "1", "i18n": { "enabled": true, "locales": "en" }, "hooks": { "enabled": [] } }'
check 2 "cannot read" "(d)/(e): a locales list jq cannot join blocks" "$(payload 'git commit -m both')"

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
