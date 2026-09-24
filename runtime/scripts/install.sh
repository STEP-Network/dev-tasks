#!/bin/bash
# Installs this mini's agent runtime for the current macOS user: the
# ~/.agentd layout and its commands, the front door's Claude Code settings,
# and two LaunchAgents (agentd, slack-bridge). Idempotent: running it again
# re-renders everything and restarts both jobs. Run it as the agent user
# (eve), never with sudo. docs/agent-mini-runbook.md says when.
#
# `agentctl doctor` runs first, and nothing is written while it reports a
# FAIL. A LaunchAgent gets no login shell's PATH, so the plists carry an
# explicit one, built from the tools resolved here and checked to resolve to
# the same binaries under it, and agentd gets absolute paths for claude and
# tmux in config.json.
set -euo pipefail

RUNTIME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$(cd "$RUNTIME/../plugin" && pwd)"
AGENTD_HOME="${AGENTD_HOME:-$HOME/.agentd}"
LAUNCH_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHCTL="${LAUNCHCTL:-launchctl}"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
export AGENTD_HOME

fail() { echo "install: $*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || fail "run this as the agent user, not as root"
# What agentctl doctor itself needs. It checks everything else.
command -v jq >/dev/null || fail "jq is missing: brew install jq, from the admin account"
NODE="$(command -v node)" || fail "node is missing: brew install node@20, and put /opt/homebrew/opt/node@20/bin on PATH in ~/.zprofile"
# node --import with tsx's loader, not tsx's own command: that one opens an
# IPC socket, which the front door's sandbox refuses.
TSX_LOADER="$RUNTIME/node_modules/tsx/dist/loader.mjs"
[ -f "$TSX_LOADER" ] || fail "$TSX_LOADER is missing: cd $RUNTIME && npm ci"

"$NODE" --import "$TSX_LOADER" "$RUNTIME/src/cli/agentctl.ts" doctor || fail "fix the FAIL lines above, then run this again"

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

mkdir -p "$AGENTD_HOME/bin" "$AGENTD_HOME/logs" "$AGENTD_HOME/state" "$AGENTD_HOME/worktrees" "$AGENTD_HOME/tmp" "$LAUNCH_DIR"

# The two commands the skills call, with absolute paths so no PATH lookup is involved.
shim() {
  cat > "$AGENTD_HOME/bin/$1.tmp" <<EOF
#!/bin/bash
# Written by $RUNTIME/scripts/install.sh. Run again after a node or checkout move.
exec "$NODE" --import "$TSX_LOADER" "$2" "\$@"
EOF
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

# The front door's settings, merged over what is there. The first run keeps a
# backup of the file as it was. Lists are joined, so a person's own rules stay.
REPO="$(jq -r '.repo.path' "$AGENTD_HOME/config.json")"
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
jq -e 'type == "object"' "$SETTINGS" >/dev/null 2>&1 || fail "$SETTINGS is not a JSON object"
[ -f "$SETTINGS.before-agentd" ] || cp "$SETTINGS" "$SETTINGS.before-agentd"
RENDERED="$AGENTD_HOME/state/claude-settings.rendered.json"
sed -e "s|__AGENTD_HOME__|$AGENTD_HOME|g" -e "s|__REPO__|$REPO|g" "$RUNTIME/templates/claude-settings.json" > "$RENDERED"
jq -s '
  def join(a; b): ((a // []) + (b // [])) | unique;
  .[0] as $old | .[1] as $new
  | ($old * $new)
  | .permissions.allow = join($old.permissions.allow; $new.permissions.allow)
  | .permissions.deny = join($old.permissions.deny; $new.permissions.deny)
  | .sandbox.network.allowedDomains = join($old.sandbox.network.allowedDomains; $new.sandbox.network.allowedDomains)
  | .sandbox.filesystem.allowWrite = join($old.sandbox.filesystem.allowWrite; $new.sandbox.filesystem.allowWrite)
  | .sandbox.filesystem.allowRead = join($old.sandbox.filesystem.allowRead; $new.sandbox.filesystem.allowRead)
' "$SETTINGS" "$RENDERED" > "$SETTINGS.tmp"
mv "$SETTINGS.tmp" "$SETTINGS"

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
