#!/bin/bash
# Tests runtime/scripts/install.sh and uninstall.sh in a throwaway HOME with
# stub tools (claude, tmux, gh, pnpm, launchctl): install refuses an unready
# machine, then a clean run renders both plists, the commands and the merged
# settings, bootstraps both jobs, and a second run still works. uninstall
# pauses, stops both jobs and the front door, and signals only a worker that
# is still its job's. Needs jq, git, node and runtime/node_modules (npm ci),
# as the install itself does. Nothing here reaches GitHub, Slack or Linear.
set -u
RUNTIME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN="$(cd "$RUNTIME/../plugin" && pwd)"
PASS=0
FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

T=$(mktemp -d -t install-test-XXXX)
T=$(cd "$T" && pwd -P)
STRANGER=""
WORKER=""
cleanup() {
  [ -n "$STRANGER" ] && kill "$STRANGER" 2>/dev/null
  [ -n "$WORKER" ] && kill "$WORKER" 2>/dev/null
  rm -rf "$T"
}
trap cleanup EXIT
export HOME="$T/home"
unset AGENTD_HOME CLAUDE_SETTINGS MONDAY_API_KEY GH_TOKEN GITHUB_TOKEN
mkdir -p "$HOME/.claude/plugins" "$HOME/.config/linear" "$HOME/.config/agentd" "$T/bin" "$T/pnpm12"

stub() { # name, body
  printf '#!/bin/bash\n%s\n' "$2" > "$T/bin/$1"
  chmod 755 "$T/bin/$1"
}
stub claude 'case "$*" in "--version") echo "2.1.281 (Claude Code)" ;; *) exit 0 ;; esac'
stub tmux 'echo "$@" >> "'"$T"'/tmux.log"; case "$1" in -V) echo "tmux 3.5a" ;; esac; exit 0'
stub gh 'case "$*" in "auth status") echo "  Logged in to github.com account eve-polads (keyring)" ;; api*) echo true ;; esac'
stub pnpm 'echo 10.33.0'
stub launchctl 'echo "$@" >> "'"$T"'/launchctl.log"; [ "$1" = print ] && exit 113; exit 0'
printf '#!/bin/bash\necho 12.1.0\n' > "$T/pnpm12/pnpm"
chmod 755 "$T/pnpm12/pnpm"
export PATH="$T/bin:$PATH"
export LAUNCHCTL="$T/bin/launchctl" LAUNCH_AGENTS_DIR="$T/LaunchAgents"

git init -q -b staging "$T/polads"

run() { bash "$RUNTIME/scripts/install.sh" > "$T/out.log" 2>&1; }
refuses() {
  if run; then bad "$1: it installed"; elif grep -q "$2" "$T/out.log"; then ok "$1"; else bad "$1: $(cat "$T/out.log")"; fi
}

refuses "refuses without the agent profile" '"profile": "agent"'
echo '{ "profile": "agent", "devSurface": "preview", "mini": "eve" }' > "$HOME/.claude/dev-tasks-profile.json"

refuses "refuses without config.json" "config.example.json"
mkdir -p "$HOME/.agentd"
jq -n --arg repo "$T/polads" --arg plugin "$PLUGIN" \
  '{ mini: "eve", repo: { path: $repo }, pluginRoot: $plugin, slack: { allowedUsers: ["UNATE"] } }' > "$HOME/.agentd/config.json"

printf 'LINEAR_API_KEY=lin_api_test\n' > "$HOME/.config/linear/.env"
chmod 644 "$HOME/.config/linear/.env"
printf 'SLACK_BOT_TOKEN=xoxb-test\nSLACK_APP_TOKEN=xapp-test\n' > "$HOME/.config/agentd/slack.env"
chmod 600 "$HOME/.config/agentd/slack.env"
refuses "refuses a secrets file other users can read" "must be chmod 600"
chmod 600 "$HOME/.config/linear/.env"

# The worker's sandbox refuses ~/.config, so an identity there is invisible to its commits.
mkdir -p "$HOME/.config/git"
printf '[user]\n\temail = eve@polads.eu\n\tname = eve\n' > "$HOME/.config/git/config"
refuses "refuses a git identity outside ~/.gitconfig" "~/.gitconfig"
rm -rf "$HOME/.config/git"
git config --global user.email eve@polads.eu
git config --global user.name eve

PATH="$T/pnpm12:$PATH" refuses "refuses a pnpm other than 10" "pnpm@10"

# The LaunchAgents' PATH puts the checked tools' directories first. One that
# holds another node would hand agentd and the worker a node doctor never saw.
mkdir -p "$T/nodebin"
ln -s "$(command -v node)" "$T/nodebin/node"
printf '#!/bin/bash\necho v0.0.0\n' > "$T/bin/node"
chmod 755 "$T/bin/node"
PATH="$T/nodebin:$PATH" refuses "refuses a PATH under which a tool is another binary" "node is $T/bin/node, not $T/nodebin/node"
rm -f "$T/bin/node"

# A person's own settings, which the merge must keep.
echo '{ "model": "opus", "permissions": { "deny": ["Bash(rm -rf:*)"] } }' > "$HOME/.claude/settings.json"
cp "$HOME/.claude/settings.json" "$T/settings.original.json"

if run; then ok "installs"; else bad "install failed: $(cat "$T/out.log")"; fi
for label in eu.polads.agentd eu.polads.slack-bridge; do
  f="$T/LaunchAgents/$label.plist"
  [ -f "$f" ] && ok "renders $label" || bad "no $label plist"
  if grep -q "__" "$f"; then bad "$label still has a placeholder"; else ok "$label has no placeholder left"; fi
  if grep -q "TOKEN\|lin_api\|xox" "$f"; then bad "$label carries a secret"; else ok "$label carries no secret"; fi
  if command -v plutil >/dev/null; then plutil -lint "$f" >/dev/null && ok "$label lints" || bad "$label does not lint"; fi
  grep -q "bootstrap gui/$(id -u) $f" "$T/launchctl.log" && ok "bootstraps $label" || bad "did not bootstrap $label"
  grep -q "<string>$T/bin:" "$f" && ok "$label's PATH starts with the tools install checked" || bad "$label's PATH: $(grep -A1 '<key>PATH' "$f")"
  grep -q "[>:]$(dirname "$(command -v node)")[:<]" "$f" && ok "$label's PATH has node's directory" || bad "$label's PATH has no node"
  grep -q "<string>$(command -v node)</string>" "$f" && ok "$label runs node by its absolute path" || bad "$label's node is not absolute"
done
[ -x "$HOME/.agentd/bin/agentctl" ] && ok "writes the agentctl command" || bad "no agentctl command"
[ -x "$HOME/.agentd/bin/statusline" ] && ok "writes the status line" || bad "no status line"
if "$HOME/.agentd/bin/agentctl" job list > "$T/jobs.json" 2>&1 && [ "$(jq -c .pending "$T/jobs.json")" = "[]" ]; then ok "agentctl runs"; else bad "agentctl does not run: $(cat "$T/jobs.json")"; fi
"$HOME/.agentd/bin/trackerctl" nosuch > /dev/null 2>&1
[ "$?" = 64 ] && ok "trackerctl runs" || bad "trackerctl does not run"
grep -q "tsx/dist/loader.mjs" "$HOME/.agentd/bin/trackerctl" && ok "trackerctl uses tsx's loader, not its IPC command" || bad "trackerctl shim"
[ "$(jq -r .frontDoor.claudePath "$HOME/.agentd/config.json")" = "$T/bin/claude" ] && ok "records the claude path" || bad "claude path not recorded"
[ "$(jq -r .frontDoor.tmuxPath "$HOME/.agentd/config.json")" = "$T/bin/tmux" ] && ok "records the tmux path" || bad "tmux path not recorded"
S="$HOME/.claude/settings.json"
[ "$(jq -r .remoteControlAtStartup "$S")" = "true" ] && ok "turns Remote Control on at startup" || bad "settings not merged"
[ "$(jq -r .statusLine.command "$S")" = "$HOME/.agentd/bin/statusline" ] && ok "sets the status line" || bad "no status line setting"
jq -e --arg rule "Edit(/$T/polads/**)" '.permissions.deny | index($rule)' "$S" >/dev/null && ok "denies edits in the checkout" || bad "no edit deny for the checkout"
jq -e '.permissions.deny | index("Read(~/.config/linear/**)") and index("Read(~/.config/agentd/**)")' "$S" >/dev/null && ok "denies reading the secrets (decision 8)" || bad "no read deny for the secrets"
[ "$(jq -c .sandbox.filesystem.allowRead "$S")" = '["~/.config/linear/.env"]' ] && ok "lets sandboxed commands read only the Linear key" || bad "allowRead: $(jq -c .sandbox.filesystem.allowRead "$S")"
[ "$(jq -r .model "$S")" = "opus" ] && jq -e '.permissions.deny | index("Bash(rm -rf:*)")' "$S" >/dev/null && ok "keeps a person's own settings" || bad "lost a person's settings"
cmp -s "$S.before-agentd" "$T/settings.original.json" && ok "keeps a backup of the settings as they were" || bad "no backup"

if run; then ok "runs a second time"; else bad "second run failed: $(cat "$T/out.log")"; fi
[ "$(jq '.permissions.deny | length' "$S")" = "$(jq '.permissions.deny | unique | length' "$S")" ] && ok "adds no rule twice" || bad "duplicate rules"
cmp -s "$S.before-agentd" "$T/settings.original.json" && ok "keeps the first backup" || bad "the backup was overwritten"

# uninstall: a worker still running its job, and a job whose pid now belongs to a stranger.
mkdir -p "$T/fake/src/worker" "$HOME/.agentd/jobs/running"
printf '#!/bin/bash\nsleep 30\n' > "$T/fake/src/worker/run.ts"
chmod 755 "$T/fake/src/worker/run.ts"
set -m
"$T/fake/src/worker/run.ts" STEP-1-20260924120000 &
WORKER=$!
sleep 30 &
STRANGER=$!
set +m
echo "{\"id\":\"STEP-1-20260924120000\",\"pid\":$WORKER}" > "$HOME/.agentd/jobs/running/STEP-1-20260924120000.json"
echo "{\"id\":\"STEP-2-20260924120000\",\"pid\":$STRANGER}" > "$HOME/.agentd/jobs/running/STEP-2-20260924120000.json"
: > "$T/launchctl.log"
bash "$RUNTIME/scripts/uninstall.sh" > "$T/un.log" 2>&1
sleep 1
for label in eu.polads.agentd eu.polads.slack-bridge; do
  grep -q "bootout gui/$(id -u)/$label" "$T/launchctl.log" && [ ! -f "$T/LaunchAgents/$label.plist" ] && ok "uninstall removes $label" || bad "uninstall left $label"
done
grep -q -- "-L agentd kill-session -t =frontdoor" "$T/tmux.log" && ok "uninstall stops the front door on its own server, by its exact name" || bad "tmux: $(cat "$T/tmux.log")"
[ "$(jq -r .reason "$HOME/.agentd/PAUSE")" = "uninstalled" ] && ok "uninstall pauses the mini" || bad "no pause"
if kill -0 "$WORKER" 2>/dev/null; then bad "the worker still runs"; else ok "uninstall stops the job's worker"; fi
if kill -0 "$STRANGER" 2>/dev/null; then ok "uninstall leaves a stranger with a job's old pid alone"; else bad "uninstall killed a stranger"; fi
echo '{"at":"2026-09-24T12:00:00Z","reason":"a person"}' > "$HOME/.agentd/PAUSE"
bash "$RUNTIME/scripts/uninstall.sh" > /dev/null 2>&1
[ "$(jq -r .reason "$HOME/.agentd/PAUSE")" = "a person" ] && ok "uninstall keeps a pause a person set" || bad "pause overwritten"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
