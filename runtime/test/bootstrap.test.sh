#!/bin/bash
# Tests runtime/scripts/bootstrap-mini.sh and gui-session.sh. A stub ssh runs
# each remote command as the agent's login shell would, with a clean
# environment, in a throwaway home (the mini) whose PATH holds stub git, gh,
# pnpm, npm, claude, tmux and launchctl. As over real SSH, the stub gh and
# the stub git's fetch refuse outside the automatic-login session, which the
# stub launchctl stands for. Nothing reaches a mini, GitHub, Slack or npm.
set -u
RUNTIME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOTSTRAP="$RUNTIME/scripts/bootstrap-mini.sh"
PASS=0
FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

T=$(mktemp -d -t bootstrap-test-XXXX)
T=$(cd "$T" && pwd -P)
trap 'rm -rf "$T"' EXIT
unset AGENTD_HOME MONDAY_API_KEY RESEND_API_KEY GH_TOKEN GITHUB_TOKEN
R="$T/mini"   # bob's home on the mini
mkdir -p "$T/bin" "$T/laptop/.ssh" "$R/.local/bin" "$R/Library/pnpm/bin" "$R/.config/linear" "$R/.config/agentd"
export HOME="$T/laptop"

# The stubs name $T as it is: they run under the stub ssh's clean environment.
put() { # path, body
  printf '#!/bin/bash\n%s\n' "$2" > "$1"
  chmod 755 "$1"
}
put "$T/bin/ssh" '
echo "$*" >> "'"$T"'/ssh.args"
tty=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -tt | -t) tty=1 ;;
    -o | -i) shift ;;
    -*) ;;
    *) break ;;
  esac
  shift
done
target=$1
shift
printf "tty=%s target=%s cmd=%s\n" "$tty" "$target" "$(printf "%s" "$*" | tr "\n" " ")" >> "'"$T"'/ssh.log"
cd "'"$R"'"
exec env -i HOME="'"$R"'" USER=bob LOGNAME=bob SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin FAKE_TTY=$tty /bin/zsh -c "$*"'
M="$R/.local/bin"
put "$M/id" 'case "$1" in -un) echo bob ;; *) exec /usr/bin/id "$@" ;; esac'
put "$M/node" 'echo v24.9.0'
put "$M/claude" 'echo "2.1.281 (Claude Code)"'
put "$M/tmux" 'echo "tmux 3.5a"'
put "$M/npm" 'echo "npm $* in $PWD" >> "'"$T"'/npm.log"'
# The standalone pnpm, and another one further down the PATH that must not run.
put "$R/Library/pnpm/bin/pnpm" 'echo "standalone $* in $PWD" >> "'"$T"'/pnpm.log"
[ "$1" = --version ] && echo 12.6.0
if [ -e "'"$T"'/fail-pnpm" ]; then echo "ERR_PNPM_OUTDATED_LOCKFILE"; exit 1; fi
exit 0'
put "$M/pnpm" 'echo "other $* in $PWD" >> "'"$T"'/pnpm.log"; echo 10.0.0'
put "$M/gh" 'echo "gh $* gui=${FAKE_GUI:-0}" >> "'"$T"'/git.log"
[ "${FAKE_GUI:-}" = 1 ] || { echo "failed to read the keychain: User interaction is not allowed." >&2; exit 1; }
[ "$1 $2" = "repo clone" ] && mkdir -p "$4/.git"'
put "$M/git" 'echo "git $* gui=${FAKE_GUI:-0}" >> "'"$T"'/git.log"
[ "$1" = -C ] && { dir=$2; shift 2; }
case "$1" in
  clone) dest=${4:-$3}; mkdir -p "$dest/.git" "$dest/plugin" "$dest/runtime/scripts"; cp "'"$T"'/fake-install.sh" "$dest/runtime/scripts/install.sh" ;;
  fetch) [ "${FAKE_GUI:-}" = 1 ] || { echo "fatal: could not read Username for https://github.com: terminal prompts disabled" >&2; exit 128; } ;;
  log) echo "abc1234 the last commit" ;;
esac
exit 0'
# launchd: gui/<uid> is the automatic-login session. bootstrap runs the job
# there, from its plist as launchd would read it.
put "$M/launchctl" 'echo "launchctl $*" >> "'"$T"'/launchctl.log"
case "$1" in
  print) [ "$2" = "gui/$(/usr/bin/id -u)" ] && [ ! -e "'"$T"'/no-gui" ] && exit 0; exit 113 ;;
  bootout) exit 0 ;;
  bootstrap)
    [ -e "'"$T"'/launchd-hangs" ] && exit 0
    exec /usr/bin/python3 -c "
import os, plistlib, subprocess, sys
job = plistlib.load(open(sys.argv[1], \"rb\"))
with open(job[\"StandardOutPath\"], \"ab\") as out:
    subprocess.run(job[\"ProgramArguments\"], stdout=out, stderr=out, env=dict(os.environ, FAKE_GUI=\"1\"))
" "$3" ;;
esac'
# What the checkout's install.sh does here: the commands, and the bridge's status with its bot.
put "$T/fake-install.sh" 'echo "install with pnpm $(command -v pnpm)" >> "'"$T"'/install.log"
[ -e "'"$T"'/fail-install" ] && { echo "FAIL  plugin"; exit 1; }
mkdir -p ~/.agentd/bin ~/.agentd/state
cp "'"$T"'/fake-agentctl" ~/.agentd/bin/agentctl
echo "{\"connected\":true,\"botUserId\":\"UBOBBOT\"}" > ~/.agentd/state/bridge.json
echo installed'
put "$T/fake-agentctl" 'echo "agentctl $* tty=$FAKE_TTY" >> "'"$T"'/agentctl.log"
case "$1" in
  probe-*) [ "$FAKE_TTY" = 1 ] || { echo "agentctl: $1 runs only at a person'"'"'s terminal"; exit 1; }; echo "ok    $1" ;;
  status) if [ -e ~/.agentd/PAUSE ]; then echo "bob PAUSED ($(jq -r .reason ~/.agentd/PAUSE))"; else echo "bob running"; fi ;;
  doctor) echo "ok    profile: agent" ;;
esac'
printf 'LINEAR_API_KEY=lin_api_SECRETVALUE\n' > "$R/.config/linear/.env"
printf 'SLACK_BOT_TOKEN=xoxb-SECRETVALUE\nSLACK_APP_TOKEN=xapp-SECRETVALUE\n' > "$R/.config/agentd/slack.env"
chmod 600 "$R/.config/linear/.env" "$R/.config/agentd/slack.env"
export PATH="$T/bin:$PATH"

STEPS="reach tools secrets gui-session dev-tasks polads polads-staging polads-deps plugin-deps runtime-deps profile pause config install probe-sandbox probe-hooks status doctor bot"
NSTEPS=$(echo $STEPS | wc -w | tr -d ' ')
USERS=(--allowed-users UNATE,UKRIS --other-bots UEVEBOT)
boot() { bash "$BOOTSTRAP" "$@" > "$T/out.log" 2>&1; }
steps_run() { grep -o '^== [0-9]*\. [a-z-]*' "$T/out.log" | awk '{print $3}' | tr '\n' ' ' | sed 's/ $//'; }
calls() { [ -f "$T/ssh.log" ] && wc -l < "$T/ssh.log" | tr -d ' ' || echo 0; }
parses() { # config.json: agentd's own schema takes it
  (cd "$RUNTIME" && ./node_modules/.bin/tsx -e 'import("./src/config.ts").then(({ ConfigSchema }) => { const r = ConfigSchema.safeParse(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))); if (!r.success) { console.error(JSON.stringify(r.error.issues)); process.exit(1) } })' "$1")
}
refuses() { # what, pattern, args...
  local what=$1 pattern=$2
  shift 2
  rm -f "$T/ssh.log"
  boot "$@"
  local code=$?
  if [ "$code" = 64 ] && grep -q -- "$pattern" "$T/out.log" && [ ! -e "$T/ssh.log" ]; then ok "$what"; else bad "$what: exit $code, $(cat "$T/out.log")"; fi
}

refuses "refuses without an agent and a host" "usage:" "${USERS[@]}" bob
refuses "refuses an agent name that is not a lower-case user" "lower case" "${USERS[@]}" Bob bobs-mac-mini
refuses "refuses an agent name with a path in it" "lower case" "${USERS[@]}" ../bob bobs-mac-mini
refuses "refuses a host with a shell character" "Tailscale" "${USERS[@]}" bob 'bobs-mac-mini;true'
refuses "refuses without --allowed-users" "allowed-users is needed" bob bobs-mac-mini
refuses "refuses a Slack id that is not one" "not a Slack member id" --allowed-users nate bob bobs-mac-mini
refuses "refuses a bot id that is not one" "not a Slack member id" --allowed-users UNATE --other-bots '"x"' bob bobs-mac-mini
printf '["not", "an object"]\n' > "$T/usertest-bad.json"
refuses "refuses a --usertest file that is not a JSON object" "not a JSON object" --usertest "$T/usertest-bad.json" "${USERS[@]}" bob bobs-mac-mini
refuses "the usage says --force-config without --usertest leaves the browser test out" "without --usertest it leaves the browser test section out" bob

# --dry-run: every step's command, and nothing run.
rm -f "$T/ssh.log"
if boot --dry-run "${USERS[@]}" bob bobs-mac-mini && [ ! -e "$T/ssh.log" ]; then ok "--dry-run runs nothing"; else bad "--dry-run: $(cat "$T/out.log")"; fi
[ "$(steps_run)" = "$STEPS" ] && ok "--dry-run names every step, in order" || bad "dry-run steps: $(steps_run)"
[ "$(grep -c '^   ssh ' "$T/out.log")" = "$NSTEPS" ] && ok "--dry-run prints one ssh command per step" || bad "dry-run commands: $(grep -c '^   ssh ' "$T/out.log")"
[ "$(grep -c -- '^   ssh -tt ' "$T/out.log")" = 2 ] && [ "$(grep -A1 -- '^   ssh -tt ' "$T/out.log" | grep -c 'runs, at a terminal: ~/.agentd/bin/agentctl probe-')" = 2 ] && ok "--dry-run shows ssh -tt for the two probes alone" || bad "dry-run -tt: $(grep -A1 -- '-tt' "$T/out.log")"
[ "$(grep -c 'runs, in the automatic-login session' "$T/out.log")" = 1 ] && grep 'runs, in the automatic-login session' "$T/out.log" | grep -q 'gh repo clone STEP-Network/v0-politiske-annoncer' && ok "--dry-run shows PolAds's clone going to the automatic-login session" || bad "dry-run gui: $(grep 'automatic-login' "$T/out.log")"
grep -q '"allowedUsers": \[' "$T/out.log" && grep -q "stdin: the config.json above" "$T/out.log" && ok "--dry-run shows the config.json it would write" || bad "dry-run config: $(grep -A3 'config.json it writes' "$T/out.log")"

# A first run, on a mini where a person's steps are done.
: > "$T/laptop/.ssh/bob_mini_ed25519"
rm -f "$T/ssh.log" "$T/ssh.args"
if boot "${USERS[@]}" bob bobs-mac-mini; then ok "bootstraps a fresh mini"; else bad "the first run failed: $(tail -20 "$T/out.log")"; fi
[ "$(steps_run)" = "$STEPS" ] && ok "runs every step, in order" || bad "steps: $(steps_run)"
[ "$(calls)" = "$NSTEPS" ] && ok "one SSH call per step" || bad "$(calls) SSH calls for $NSTEPS steps"
[ "$(grep -c 'BatchMode=yes' "$T/ssh.args")" = "$NSTEPS" ] && [ "$(grep -c -- "-i $T/laptop/.ssh/bob_mini_ed25519" "$T/ssh.args")" = "$NSTEPS" ] && ok "uses ~/.ssh/<agent>_mini_ed25519, and never asks for a password" || bad "ssh options: $(head -1 "$T/ssh.args")"
[ "$(grep -c '^tty=1' "$T/ssh.log")" = 2 ] && [ "$(grep '^tty=1' "$T/ssh.log" | grep -c 'probe-sandbox\|probe-hooks --scripted')" = 2 ] && ok "ssh -tt for probe-sandbox and probe-hooks --scripted alone" || bad "tty calls: $(grep '^tty=1' "$T/ssh.log")"
grep -q "git clone -q https://github.com/STEP-Network/dev-tasks.git $R/dev-tasks gui=0" "$T/git.log" && ok "clones dev-tasks, public, over plain SSH" || bad "dev-tasks clone: $(cat "$T/git.log")"
grep -q "gh repo clone STEP-Network/v0-politiske-annoncer $R/polads -- -q gui=1" "$T/git.log" && ok "clones PolAds in the automatic-login session, where the keychain is open" || bad "polads clone: $(cat "$T/git.log")"
grep -q "git -C $R/polads checkout -q --detach origin/staging" "$T/git.log" && ok "detaches PolAds at origin/staging" || bad "no detach: $(cat "$T/git.log")"
grep -q "^standalone install --frozen-lockfile in $R/polads$" "$T/pnpm.log" && ! grep -q "^other install" "$T/pnpm.log" && ok "installs PolAds with the standalone pnpm, from the lockfile" || bad "pnpm: $(cat "$T/pnpm.log")"
grep -q "^npm ci in $R/dev-tasks/plugin$" "$T/npm.log" && grep -q "^npm ci in $R/dev-tasks/runtime$" "$T/npm.log" && ok "npm ci in the plugin and the runtime" || bad "npm: $(cat "$T/npm.log")"
[ "$(jq -c . "$R/.claude/dev-tasks-profile.json")" = '{"profile":"agent","devSurface":"preview","mini":"bob"}' ] && ok "writes the agent profile" || bad "profile: $(cat "$R/.claude/dev-tasks-profile.json")"
[ "$(jq -r .reason "$R/.agentd/PAUSE")" = "first start, not watched yet" ] && ok "pauses the first start" || bad "no first-start pause"
C="$R/.agentd/config.json"
[ "$(jq -c '[.mini, .repo.path, .pluginRoot]' "$C")" = "[\"bob\",\"$R/polads\",\"$R/dev-tasks/plugin\"]" ] && ok "config: bob's name and paths, under the home the mini reported" || bad "config paths: $(jq -c '[.mini, .repo.path, .pluginRoot]' "$C")"
[ "$(jq -c '[.slack.allowedUsers, .slack.otherAgentBots]' "$C")" = '[["UNATE","UKRIS"],["UEVEBOT"]]' ] && ok "config: the allowed users and the other agents' bots" || bad "config slack: $(jq -c .slack "$C")"
[ "$(jq -c '[.queue.mode, .queue.allow, .worker.autoMerge]' "$C")" = '["allowlist",[],true]' ] && ok "config: an empty allowlist, and auto-merge on" || bad "config queue: $(jq -c '[.queue, .worker.autoMerge]' "$C")"
same='del(.mini, .repo.path, .pluginRoot, .slack.allowedUsers, .slack.otherAgentBots, .queue.mode, .queue.allow, .worker.autoMerge, .usertest)'
[ "$(jq -cS "$same" "$C")" = "$(jq -cS "$same" "$RUNTIME/templates/config.example.json")" ] && ok "config: every model and limit as the template has them (Eve's)" || bad "config differs from the template: $(jq -cS "$same" "$C")"
[ "$(jq -r 'has("usertest")' "$C")" = false ] && ok "config: no browser test section without --usertest, so the test stays off" || bad "config usertest: $(jq -c .usertest "$C")"
grep -qE '^(Chrome: |no Google Chrome: the browser test needs it)' "$T/out.log" && ok "says whether Chrome is there, without failing" || bad "no Chrome line: $(grep -A3 '== 2. tools' "$T/out.log")"
grep -q "usertest.env absent: the browser test runs signed out" "$T/out.log" && grep -q "^3. For the browser test: put TEST_LOGIN_SECRET and VERCEL_AUTOMATION_BYPASS_SECRET in ~/.config/agentd/usertest.env on the mini, chmod 600" "$T/out.log" && grep -q "^4. When someone is watching" "$T/out.log" && ok "an absent usertest.env fails nothing, and is on the list of what is left" || bad "usertest.env absent: $(tail -6 "$T/out.log")"
grep -q "^install with pnpm $R/Library/pnpm/bin/pnpm$" "$T/install.log" && ok "runs install.sh with the standalone pnpm first on the PATH" || bad "install: $(cat "$T/install.log" 2>/dev/null)"
grep -q "^agentctl probe-sandbox tty=1$" "$T/agentctl.log" && grep -q "^agentctl probe-hooks --scripted tty=1$" "$T/agentctl.log" && ok "runs both probes at a terminal" || bad "probes: $(cat "$T/agentctl.log")"
grep -q "^bob PAUSED (first start, not watched yet)" "$T/out.log" && grep -q "^agentctl doctor tty=0$" "$T/agentctl.log" && ok "shows the paused status, then doctor" || bad "status and doctor: $(cat "$T/agentctl.log")"
grep -q "jq --arg bot UBOBBOT '.slack.otherAgentBots" "$T/out.log" && grep -q "kickstart -k gui/\$(id -u)/eu.polads.slack-bridge" "$T/out.log" && ok "says how to add bob's bot to the other minis, with its id" || bad "no instruction for the other minis: $(tail -12 "$T/out.log")"
grep -q "bootout gui/$(id -u)/eu.polads.bootstrap.polads" "$T/launchctl.log" && [ -z "$(ls "$R/.agentd/bootstrap/"*.plist 2>/dev/null)" ] && ok "removes the automatic-login job once it is done" || bad "the gui job lingers: $(ls "$R/.agentd/bootstrap")"
# The secrets files are looked at by their mode, once, and never read.
if grep -rq SECRETVALUE "$T/out.log" "$T/ssh.log" "$T/ssh.args"; then bad "a secret reached the output"; else ok "no secret in the output or on a command line"; fi
[ "$(grep -c '\.env' "$T/ssh.log")" = 1 ] && grep '\.env' "$T/ssh.log" | grep -q 'stat -f %Lp' && ! grep '\.env' "$T/ssh.log" | grep -qE 'cat |source |\. ~|read ' && ok "the one step naming the secrets files only stats them" || bad "secrets files: $(grep '\.env' "$T/ssh.log")"

# Again, on the same mini: nothing a person changed since is undone.
jq '.marker = "kept"' "$C" > "$C.tmp" && mv "$C.tmp" "$C"
rm "$R/.agentd/PAUSE"
: > "$T/git.log"
rm -f "$T/ssh.log"
if boot "${USERS[@]}" bob bobs-mac-mini; then ok "runs again"; else bad "the second run failed: $(tail -20 "$T/out.log")"; fi
[ "$(calls)" = "$NSTEPS" ] && ok "again one SSH call per step" || bad "second run: $(calls) calls"
[ "$(jq -r .marker "$C")" = kept ] && grep -q "kept ~/.agentd/config.json" "$T/out.log" && ok "keeps the config it finds" || bad "config rewritten: $(jq -c . "$C")"
[ ! -e "$R/.agentd/PAUSE" ] && grep -q "configured before: the pause is left as it is" "$T/out.log" && ok "leaves a resumed mini resumed" || bad "paused again"
grep -q "git -C $R/dev-tasks pull --ff-only -q gui=0" "$T/git.log" && grep -q "git -C $R/polads fetch -q origin gui=1" "$T/git.log" && ! grep -q "clone" "$T/git.log" && ok "fetches the checkouts it finds, PolAds in the automatic-login session" || bad "second run git: $(cat "$T/git.log")"
if boot --force-config "${USERS[@]}" bob bobs-mac-mini && [ "$(jq -r '.marker // "gone"' "$C")" = gone ] && [ ! -e "$R/.agentd/PAUSE" ]; then ok "--force-config writes the config again, and pauses nothing"; else bad "--force-config: $(jq -c . "$C")"; fi
printf '{"enabled":true,"personas":[{"id":"customer","email":"customer@example.test"}]}\n' > "$T/usertest.json"
printf 'TEST_LOGIN_SECRET=SECRETVALUE\n' > "$R/.config/agentd/usertest.env"
chmod 600 "$R/.config/agentd/usertest.env"
if boot --force-config --usertest "$T/usertest.json" "${USERS[@]}" bob bobs-mac-mini && [ "$(jq -c '[.usertest.enabled, .usertest.personas[0].id]' "$C")" = '[true,"customer"]' ]; then ok "--usertest puts the private file's section in config.json"; else bad "--usertest: $(jq -c .usertest "$C") $(tail -3 "$T/out.log")"; fi
# The private file adds to the template's public section, so agentd takes the result.
[ "$(jq -cS '.usertest | del(.enabled, .personas)' "$C")" = "$(jq -cS '.usertest | del(.enabled, .personas)' "$RUNTIME/templates/config.example.json")" ] && ok "--usertest keeps the template's preview and staging settings" || bad "--usertest template: $(jq -c .usertest "$C")"
if out=$(parses "$C" 2>&1); then ok "the config.json --usertest writes is one agentd takes"; else bad "agentd refuses it: $out"; fi
grep -q "ok $R/.config/agentd/usertest.env (600)" "$T/out.log" && ! grep -q "For the browser test: put" "$T/out.log" && ok "a usertest.env at 600 passes, and is not on the list" || bad "usertest.env 600: $(grep usertest "$T/out.log")"
if grep -q SECRETVALUE "$T/out.log" "$T/ssh.log"; then bad "a browser-test secret reached the output"; else ok "no browser-test secret in the output"; fi

# The first step that fails stops the run, and says which it was.
stops_at() { # what, step, pattern, args...
  local what=$1 at=$2 pattern=$3
  shift 3
  rm -f "$T/ssh.log"
  boot "$@"
  local code=$?
  local last
  last=$(steps_run | awk '{print $NF}')
  if [ "$code" != 0 ] && [ "$last" = "$at" ] && grep -q "failed with exit" "$T/out.log" && grep -q -- "$pattern" "$T/out.log"; then ok "$what"; else bad "$what: exit $code, last step $last: $(tail -5 "$T/out.log")"; fi
}
touch "$T/fail-pnpm"
stops_at "stops at the first failing step, and names it" polads-deps "(polads-deps)" "${USERS[@]}" bob bobs-mac-mini
[ "$(calls)" = 8 ] && ok "runs nothing after it" || bad "$(calls) calls after a failure at step 8"
rm "$T/fail-pnpm"
touch "$T/no-gui"
stops_at "refuses a mini with no automatic-login session" gui-session "has no GUI session" "${USERS[@]}" bob bobs-mac-mini
rm "$T/no-gui"
chmod 644 "$R/.config/agentd/slack.env"
stops_at "refuses a secrets file other users can read" secrets "slack.env is mode 644" "${USERS[@]}" bob bobs-mac-mini
chmod 600 "$R/.config/agentd/slack.env"
chmod 644 "$R/.config/agentd/usertest.env"
stops_at "refuses a browser-test secrets file other users can read" secrets "usertest.env is mode 644" "${USERS[@]}" bob bobs-mac-mini
chmod 600 "$R/.config/agentd/usertest.env"
rm -f "$T/ssh.log"
if boot "${USERS[@]}" eve bobs-mac-mini; then bad "bootstrapped eve on bob's mini"; else
  [ "$(calls)" = 1 ] && grep -q "is the user 'bob', not eve" "$T/out.log" && ok "stops after reach on a host where the user is another agent" || bad "another agent's mini: $(calls) calls, $(tail -3 "$T/out.log")"
fi

# gui-session.sh on its own: the command as written, its status, and a job that never ends.
gui() { env HOME="$R" PATH="$M:/usr/bin:/bin:/usr/sbin:/sbin" bash "$RUNTIME/scripts/gui-session.sh" "$@" > "$T/gui.out" 2>&1; }
gui quoting 10 'echo "a<b>" && echo '"'"'c&d'"'"''
[ "$?" = 0 ] && [ "$(cat "$T/gui.out")" = "$(printf 'a<b>\nc&d')" ] && ok "gui-session runs the command as written, & < > and quotes too" || bad "gui-session quoting: $(cat "$T/gui.out")"
gui status 10 'echo before; exit 3'
[ "$?" = 3 ] && grep -q before "$T/gui.out" && ok "gui-session exits with the command's status, even from its own exit" || bad "gui-session status: $(cat "$T/gui.out")"
touch "$T/launchd-hangs"
gui hangs 2 'echo never'
[ "$?" = 124 ] && grep -q "still running after 2s" "$T/gui.out" && ok "gui-session stops a job that outlives its time" || bad "gui-session timeout: $(cat "$T/gui.out")"
rm "$T/launchd-hangs"
gui 'Bad Name' 10 true
[ "$?" = 64 ] && ok "gui-session refuses a name launchd's label cannot hold" || bad "gui-session name: $(cat "$T/gui.out")"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
