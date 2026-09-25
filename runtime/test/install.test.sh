#!/bin/bash
# Tests runtime/scripts/install.sh and uninstall.sh in a throwaway HOME with
# stub tools (claude, tmux, gh, pnpm, launchctl): install refuses an unready
# machine, then a clean run renders both plists, the commands and the front
# door's own settings, bootstraps both jobs, and a second run still works. uninstall
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

AGENTD_HOME="$T/elsewhere-agentd" refuses "refuses an AGENTD_HOME other than ~/.agentd" "must be ~/.agentd"
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
git config --file "$HOME/.gitconfig" user.email eve@polads.eu
git config --file "$HOME/.gitconfig" user.name eve
# Even beside ~/.gitconfig: git reads the XDG file whenever it exists, and in
# the worker's sandbox that read is fatal.
printf '[credential]\n\thelper = osxkeychain\n' > "$HOME/.config/git/config"
refuses "refuses any ~/.config/git/config" "config/git/config exists"
rm -rf "$HOME/.config/git"

# The latest pnpm and Node are fine. Below what the checkout's package.json names, doctor warns and installs.
printf '{ "engines": { "node": "99.x" }, "packageManager": "pnpm@99.0.0" }\n' > "$T/polads/package.json"
if run; then
  grep -q "WARN  pnpm: 10.33.0 is older than 99.0.0" "$T/out.log" && grep -q "WARN  node: .* is older than the checkout's engines.node, 99.x" "$T/out.log" && ok "warns, and installs, below the checkout's pnpm and Node" || bad "no toolchain warning: $(grep -E 'pnpm:|node:' "$T/out.log")"
else
  bad "refused a pnpm below packageManager: $(grep FAIL "$T/out.log")"
fi
rm "$T/polads/package.json"
PATH="$T/pnpm12:$PATH" run && grep -q "^ok    pnpm: 12.1.0" "$T/out.log" && ok "takes a pnpm other than 10" || bad "pnpm 12: $(grep pnpm "$T/out.log")"

# The LaunchAgents' PATH puts the checked tools' directories first. One that
# holds another node would hand agentd and the worker a node doctor never saw.
mkdir -p "$T/nodebin"
ln -s "$(command -v node)" "$T/nodebin/node"
printf '#!/bin/bash\necho v0.0.0\n' > "$T/bin/node"
chmod 755 "$T/bin/node"
PATH="$T/nodebin:$PATH" refuses "refuses a PATH under which a tool is another binary" "node is $T/bin/node, not $T/nodebin/node"
rm -f "$T/bin/node"

# A person's own settings, which the install must leave alone: the front door
# gets its own with --settings.
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
# The front door runs the shims outside its sandbox, so they take nothing from their caller.
printf 'require("fs").writeFileSync("%s/injected", "node")\n' "$T" > "$T/evil.cjs"
printf 'touch "%s/injected"\n' "$T" > "$T/evil.sh"
NODE_OPTIONS="--require=$T/evil.cjs" BASH_ENV="$T/evil.sh" "$HOME/.agentd/bin/agentctl" job list > /dev/null 2>&1
[ ! -e "$T/injected" ] && ok "NODE_OPTIONS and BASH_ENV in front of a shim run nothing" || bad "an injected variable ran code"
AGENTD_HOME="$T/elsewhere" "$HOME/.agentd/bin/agentctl" job submit --issue STEP-77 > /dev/null 2>&1
[ -n "$(ls "$HOME/.agentd/jobs/pending" 2>/dev/null)" ] && [ ! -e "$T/elsewhere" ] && ok "AGENTD_HOME in front of a shim changes nothing" || bad "a shim took AGENTD_HOME from its caller"
# HOME decides whose profile and key a shim reads: another one here would be a laptop's profile.
mkdir -p "$T/otherhome/.claude"
echo '{ "profile": "human" }' > "$T/otherhome/.claude/dev-tasks-profile.json"
HOME="$T/otherhome" "$HOME/.agentd/bin/agentctl" doctor > "$T/doctor.out" 2>&1
grep -q "^ok    profile: agent" "$T/doctor.out" && ok "HOME in front of a shim changes nothing" || bad "a shim took HOME from its caller: $(grep profile "$T/doctor.out")"
[ "$(jq -r .frontDoor.claudePath "$HOME/.agentd/config.json")" = "$T/bin/claude" ] && ok "records the claude path" || bad "claude path not recorded"
[ "$(jq -r .frontDoor.tmuxPath "$HOME/.agentd/config.json")" = "$T/bin/tmux" ] && ok "records the tmux path" || bad "tmux path not recorded"
S="$HOME/.agentd/front-door-settings.json"
[ "$(jq -r .remoteControlAtStartup "$S")" = "true" ] && ok "turns Remote Control on at startup for the front door" || bad "no front door settings"
[ "$(jq -r .statusLine.command "$S")" = "$HOME/.agentd/bin/statusline" ] && ok "sets the status line" || bad "no status line setting"
jq -e --arg rule "Edit(/$T/polads/**)" '.permissions.deny | index($rule)' "$S" >/dev/null && ok "denies edits in the checkout" || bad "no edit deny for the checkout"
jq -e '.permissions.deny | index("Read(~/.config/**)") and index("Read(~/.ssh/**)")' "$S" >/dev/null && ok "denies reading the secrets and other credentials (decision 8)" || bad "no read deny for the secrets"
[ "$(jq -c .sandbox.excludedCommands "$S")" = '["~/.agentd/bin/agentctl:*","~/.agentd/bin/trackerctl:*"]' ] && ok "runs agentctl and trackerctl, and only those, outside the sandbox" || bad "excludedCommands: $(jq -c .sandbox.excludedCommands "$S")"
jq -e '.permissions.allow | index("Bash(~/.agentd/bin/agentctl:*)") and index("Bash(~/.agentd/bin/trackerctl:*)")' "$S" >/dev/null && ok "allows the two commands without a prompt" || bad "no allow for the two commands"
jq -e '.permissions.deny | index("Edit(~/.agentd/**)") and index("Bash(~/.agentd/bin/agentctl resume:*)")' "$S" >/dev/null && ok "keeps the front door out of ~/.agentd and off agentctl resume" || bad "no deny for ~/.agentd or resume"
[ "$(jq -c .sandbox.filesystem "$S")" = '{"allowWrite":["~/.front-door"]}' ] && ok "lets sandboxed commands write ~/.front-door and read no secret" || bad "sandbox filesystem: $(jq -c .sandbox.filesystem "$S")"
[ -d "$HOME/.front-door" ] && ok "makes ~/.front-door" || bad "no ~/.front-door"
cmp -s "$HOME/.claude/settings.json" "$T/settings.original.json" && ok "leaves a person's own settings alone" || bad "changed ~/.claude/settings.json"

# A later template replaces the file whole: nothing an earlier install wrote lingers.
jq '.permissions.deny += ["Bash(dropped-rule:*)"]' "$S" > "$S.tmp" && mv "$S.tmp" "$S"
if run; then ok "runs a second time"; else bad "second run failed: $(cat "$T/out.log")"; fi
if jq -e '.permissions.deny | index("Bash(dropped-rule:*)")' "$S" >/dev/null; then bad "kept a rule the template does not have"; else ok "renders the template whole again"; fi

# Over SSH the login keychain is locked: the logins cannot be checked, and install says where to check them.
cp "$T/bin/claude" "$T/claude.ok"; cp "$T/bin/gh" "$T/gh.ok"
stub claude 'case "$*" in "--version") echo "2.1.281 (Claude Code)" ;; "auth status") echo "{\"loggedIn\":false}"; exit 1 ;; *) exit 0 ;; esac'
stub gh 'case "$*" in "auth status") echo "User interaction is not allowed." >&2; exit 1 ;; api*) exit 1 ;; esac'
if SSH_CONNECTION="100.64.0.2 51234 100.64.0.9 22" run; then
  grep -q "WARN  claude login: can't check over SSH" "$T/out.log" && grep -q "WARN  gh: can't check over SSH" "$T/out.log" && ok "over SSH, doctor defers the keychain logins" || bad "doctor over SSH: $(grep -E 'claude login|gh:' "$T/out.log")"
  # What a person over SSH runs: the shim, which starts node with a clean environment.
  SSH_CONNECTION="100.64.0.2 51234 100.64.0.9 22" "$HOME/.agentd/bin/agentctl" doctor > "$T/shim-doctor.out" 2>&1
  grep -q "WARN  gh: can't check over SSH" "$T/shim-doctor.out" && ! grep -q "FAIL  gh" "$T/shim-doctor.out" && ok "over SSH, the shim's doctor defers the keychain logins too" || bad "shim doctor over SSH: $(grep -E 'claude login|gh:' "$T/shim-doctor.out")"
  "$HOME/.agentd/bin/agentctl" doctor > "$T/shim-doctor.out" 2>&1
  grep -q "FAIL  gh" "$T/shim-doctor.out" && ok "outside SSH, the shim's doctor refuses them" || bad "shim doctor outside SSH: $(grep -E 'gh:' "$T/shim-doctor.out")"
  grep -q "Run .*agentctl doctor from the mini's own Terminal" "$T/out.log" && ok "over SSH, install says where to check the logins" || bad "no SSH note: $(tail -3 "$T/out.log")"
else
  bad "install over SSH failed on the keychain logins: $(tail -5 "$T/out.log")"
fi
refuses "refuses the same logins outside SSH" "FAIL  claude login"
mv "$T/claude.ok" "$T/bin/claude"; mv "$T/gh.ok" "$T/bin/gh"
run && ! grep -q "over SSH" "$T/out.log" && ok "no SSH note outside SSH" || bad "outside SSH: $(tail -3 "$T/out.log")"

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
