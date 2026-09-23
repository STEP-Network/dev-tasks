#!/usr/bin/env bash
# Tests for tracker_provider in hooks/lib/config-reader.sh.
#
# It has to answer the way readTrackerProvider in src/tracker/index.ts does for
# the same directory, or a hook and trackerctl disagree about which tracker a
# session is on: DEV_TASKS_TRACKER first, then .claude/project-config.json at
# the git toplevel (the directory itself outside git), and `monday` for
# anything missing or unrecognised. Every fallback except "no tracker block"
# warns on stderr.
#
# No network. Run with: bash plugin/hooks/__tests__/tracker-provider.test.sh

set -u
unset DEV_TASKS_TRACKER CLAUDE_PROJECT_DIR

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$(cd "$TEST_DIR/.." && pwd)/lib/config-reader.sh"
[ -f "$LIB" ] || { echo "FAIL: config-reader.sh not found at $LIB" >&2; exit 1; }

PASS=0; FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1" >&2; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d -t tracker-provider-XXXX)"
trap 'rm -rf "$WORK"' EXIT
# Keep git's repository search inside $WORK, so a TMPDIR that happens to sit
# inside a checkout can't turn the "outside git" cases into inside-git ones.
export GIT_CEILING_DIRECTORIES="$WORK"

# git_repo <dir> [config-json] → a repo with one commit, config optional
git_repo() {
  mkdir -p "$1/lib/deep"
  printf 'x\n' > "$1/lib/deep/file.ts"
  if [ -n "${2:-}" ]; then
    mkdir -p "$1/.claude"
    printf '%s\n' "$2" > "$1/.claude/project-config.json"
  fi
  git -C "$1" init -q
  git -C "$1" add -A
  git -C "$1" -c user.email=t@example.com -c user.name=t commit -q -m init
}

# check <label> <cwd> <want> <warn: yes|no> [DEV_TASKS_TRACKER] [dir-argument]
# Runs tracker_provider from <cwd>, with the optional env value and argument.
check() {
  local label="$1" cwd="$2" want="$3" warn="$4" env="${5:-}" arg="${6:-}"
  local out err
  out=$(cd "$cwd" && DEV_TASKS_TRACKER="$env" bash -c 'source "$1"; tracker_provider ${2:+"$2"}' _ "$LIB" "$arg" 2>"$WORK/err")
  err=$(cat "$WORK/err")
  if [ "$out" != "$want" ]; then
    fail "$label: got '$out', want '$want' (stderr: $err)"
  elif [ "$warn" = "yes" ] && ! printf '%s' "$err" | grep -q '^dev-tasks: '; then
    fail "$label: answered '$out' but printed no dev-tasks: warning"
  elif [ "$warn" = "no" ] && [ -n "$err" ]; then
    fail "$label: answered '$out' but warned: $err"
  else
    pass "$label → $out"
  fi
}

REPO="$WORK/repo"
git_repo "$REPO" '{"tracker":{"provider":"linear"}}'

echo "==> Config at the git toplevel"
check "repo root" "$REPO" linear no
check "subdirectory two levels down" "$REPO/lib/deep" linear no
check "directory passed as an argument" "$WORK" linear no "" "$REPO/lib/deep"

echo "==> DEV_TASKS_TRACKER"
check "env monday beats a linear config" "$REPO/lib/deep" monday no monday
check "an invalid env value is ignored, with a warning" "$REPO/lib/deep" linear yes Linear

echo "==> A worktree reads its own copy of the config"
git -C "$REPO" worktree add -q -b other "$WORK/wt"
printf '{"tracker":{"provider":"monday"}}\n' > "$WORK/wt/.claude/project-config.json"
check "worktree subdirectory" "$WORK/wt/lib/deep" monday no

echo "==> Outside git, only the directory itself counts"
mkdir -p "$WORK/plain/.claude" "$WORK/plain/sub"
printf '{"tracker":{"provider":"linear"}}\n' > "$WORK/plain/.claude/project-config.json"
check "plain directory holding the config" "$WORK/plain" linear no
check "its subdirectory: no toplevel to walk up to" "$WORK/plain/sub" monday yes

echo "==> Fallbacks"
git_repo "$WORK/noconfig"
check "no config file" "$WORK/noconfig/lib" monday yes
git_repo "$WORK/noblock" '{"hooks":{"enabled":[]}}'
check "no tracker block is the documented default" "$WORK/noblock" monday no
git_repo "$WORK/typo" '{"tracker":{"provider":"linaer"}}'
check "unrecognised value" "$WORK/typo" monday yes
git_repo "$WORK/nullvalue" '{"tracker":{"provider":null}}'
check "explicit null" "$WORK/nullvalue" monday yes
git_repo "$WORK/broken" '{"tracker":'
check "invalid JSON" "$WORK/broken" monday yes

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
