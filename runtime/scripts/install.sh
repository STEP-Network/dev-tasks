#!/bin/bash
# Installs this mini's agent runtime for the current macOS user: the
# ~/.agentd layout and its commands, the front door's Claude Code settings
# (~/.agentd/front-door-settings.json), and two LaunchAgents (agentd,
# slack-bridge). Idempotent: running it again
# re-renders everything and restarts both jobs. Run it as the agent user
# (eve), never with sudo. docs/agent-mini-runbook.md says when.
#
# `agentctl doctor --fresh` runs first, and nothing is written while it
# reports a FAIL. A LaunchAgent gets no login shell's PATH, so the plists carry an
# explicit one, built from the tools resolved here and checked to resolve to
# the same binaries under it, and agentd gets absolute paths for claude and
# tmux in config.json.
set -euo pipefail

RUNTIME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$(cd "$RUNTIME/../plugin" && pwd)"
AGENTD_HOME="${AGENTD_HOME:-$HOME/.agentd}"
LAUNCH_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHCTL="${LAUNCHCTL:-launchctl}"
export AGENTD_HOME

fail() { echo "install: $*" >&2; exit 1; }

# The front door's settings and the skills name ~/.agentd/bin as it is spelt.
[ "$AGENTD_HOME" = "$HOME/.agentd" ] || fail "AGENTD_HOME is $AGENTD_HOME: on a mini it must be ~/.agentd, which the front door's settings and the skills name"

[ "$(id -u)" -ne 0 ] || fail "run this as the agent user, not as root"
# What agentctl doctor itself needs. It checks everything else.
command -v jq >/dev/null || fail "jq is missing: brew install jq, from the admin account"
NODE="$(command -v node)" || fail "node is missing: brew install node@20, and put /opt/homebrew/opt/node@20/bin on PATH in ~/.zprofile"
# node --import with tsx's loader, not tsx's own command: that one opens an
# IPC socket, which the front door's sandbox refuses.
TSX_LOADER="$RUNTIME/node_modules/tsx/dist/loader.mjs"
[ -f "$TSX_LOADER" ] || fail "$TSX_LOADER is missing: cd $RUNTIME && npm ci"

# --fresh: claude and tmux as PATH finds them now, which is what gets recorded below.
"$NODE" --import "$TSX_LOADER" "$RUNTIME/src/cli/agentctl.ts" doctor --fresh || fail "fix the FAIL lines above, then run this again"

resolve() { command -v "$1" || fail "$1 is missing"; }
PNPM="$(resolve pnpm)"
CLAUDE="$(resolve claude)"
TMUX_BIN="$(resolve tmux)"
GH="$(resolve gh)"
GIT="$(resolve git)"
JQ="$(resolve jq)"

# The LaunchAgents' PATH: the directories of the tools doctor checked, the
# most specific first (Homebrew's keg-only node@20 and pnpm@10 live apart from
# /opt/homebrew/bin, where another pnpm may be), then the usual ones.
JOB_PATH=""
add_path() {
  case ":$JOB_PATH:" in
    *":$1:"*) ;;
    *) JOB_PATH="${JOB_PATH:+$JOB_PATH:}$1" ;;
  esac
}
for tool in "$PNPM" "$NODE" "$CLAUDE" "$TMUX_BIN" "$GH" "$GIT" "$JQ"; do add_path "$(dirname "$tool")"; done
for dir in /opt/homebrew/bin "$HOME/.local/bin" /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do add_path "$dir"; done
# The worker runs pnpm, git and gh by name, and the front door node: under
# that PATH each must be the binary doctor checked.
for pair in "node=$NODE" "pnpm=$PNPM" "git=$GIT" "gh=$GH" "jq=$JQ"; do
  name="${pair%%=*}"
  want="${pair#*=}"
  got="$(PATH="$JOB_PATH"; hash -r; command -v "$name" || true)"
  [ "$got" = "$want" ] || fail "under the LaunchAgents' PATH ($JOB_PATH), $name is ${got:-missing}, not $want"
done

# The paths below are written into XML, the shims and sed expressions as they are.
for value in "$NODE" "$RUNTIME" "$AGENTD_HOME" "$JOB_PATH" "$HOME"; do
  case "$value" in
    *[\|\&\<\>\"\'\$\`\\]*) fail "$value has a character the plists and shims cannot hold (| & < > \$ a backtick, a backslash or a quote): move it" ;;
  esac
done

# ~/.front-door is the one place the front door's sandboxed Bash may write:
# the briefs and replies it hands to trackerctl and agentctl as files.
mkdir -p "$AGENTD_HOME/bin" "$AGENTD_HOME/logs" "$AGENTD_HOME/state" "$AGENTD_HOME/worktrees" "$HOME/.front-door" "$LAUNCH_DIR"

# The two commands the skills call, which the front door's settings run
# outside its sandbox, rendered from runtime/templates/shim.sh: absolute
# paths, and node with a clean environment, so nothing set in front of a shim
# reaches it. Run install again after a node or checkout move.
USER_NAME="$(id -un)"
shim() {
  sed -e "s|__NAME__|$1|g" -e "s|__HOME__|$HOME|g" -e "s|__USER__|$USER_NAME|g" -e "s|__PATH__|$JOB_PATH|g" \
    -e "s|__AGENTD_HOME__|$AGENTD_HOME|g" -e "s|__NODE__|$NODE|g" -e "s|__LOADER__|$TSX_LOADER|g" -e "s|__SCRIPT__|$2|g" \
    "$RUNTIME/templates/shim.sh" > "$AGENTD_HOME/bin/$1.tmp"
  if grep -q "__[A-Z_]*__" "$AGENTD_HOME/bin/$1.tmp"; then fail "$1 still has a placeholder"; fi
  chmod 755 "$AGENTD_HOME/bin/$1.tmp"
  mv "$AGENTD_HOME/bin/$1.tmp" "$AGENTD_HOME/bin/$1"
}
shim agentctl "$RUNTIME/src/cli/agentctl.ts"
shim trackerctl "$PLUGIN/scripts/trackerctl.ts"
cp "$RUNTIME/bin/statusline.sh" "$AGENTD_HOME/bin/statusline.tmp"
chmod 755 "$AGENTD_HOME/bin/statusline.tmp"
mv "$AGENTD_HOME/bin/statusline.tmp" "$AGENTD_HOME/bin/statusline"

# agentd starts the front door with these exact binaries.
jq --arg claude "$CLAUDE" --arg tmux "$TMUX_BIN" '.frontDoor.claudePath = $claude | .frontDoor.tmuxPath = $tmux' "$AGENTD_HOME/config.json" > "$AGENTD_HOME/config.json.tmp"
mv "$AGENTD_HOME/config.json.tmp" "$AGENTD_HOME/config.json"

# The front door's own settings, which agentd passes with --settings: the
# sandbox, the deny rules, the status line and Remote Control. A person's own
# claude sessions on the mini keep ~/.claude/settings.json as it is.
REPO="$(jq -r '.repo.path' "$AGENTD_HOME/config.json")"
jq --arg home "$AGENTD_HOME" --arg repo "$REPO" \
  'walk(if type == "string" then gsub("__AGENTD_HOME__"; $home) | gsub("__REPO__"; $repo) else . end)' \
  "$RUNTIME/templates/claude-settings.json" > "$AGENTD_HOME/front-door-settings.json.tmp"
mv "$AGENTD_HOME/front-door-settings.json.tmp" "$AGENTD_HOME/front-door-settings.json"

UID_NOW="$(id -u)"
for label in eu.polads.agentd eu.polads.slack-bridge; do
  plist="$LAUNCH_DIR/$label.plist"
  sed -e "s|__NODE__|$NODE|g" -e "s|__RUNTIME__|$RUNTIME|g" -e "s|__AGENTD_HOME__|$AGENTD_HOME|g" -e "s|__PATH__|$JOB_PATH|g" \
    "$RUNTIME/launchd/$label.plist" > "$plist.tmp"
  if grep -q "__[A-Z_]*__" "$plist.tmp"; then fail "$plist still has a placeholder"; fi
  if command -v plutil >/dev/null; then plutil -lint "$plist.tmp" >/dev/null || fail "$plist is not a valid plist"; fi
  mv "$plist.tmp" "$plist"
  "$LAUNCHCTL" bootout "gui/$UID_NOW/$label" 2>/dev/null || true
  # bootout returns before the job is gone, and a bootstrap meanwhile fails.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    "$LAUNCHCTL" print "gui/$UID_NOW/$label" >/dev/null 2>&1 || break
    sleep 1
  done
  "$LAUNCHCTL" bootstrap "gui/$UID_NOW" "$plist" || fail "launchctl bootstrap gui/$UID_NOW $plist failed"
done

echo "installed. Check it with: $AGENTD_HOME/bin/agentctl status"
if [ -e "$AGENTD_HOME/PAUSE" ]; then echo "paused: nothing is developed or refined until $AGENTD_HOME/bin/agentctl resume"; fi
