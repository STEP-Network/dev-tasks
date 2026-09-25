#!/bin/bash
# Sets up an agent mini from the orchestrator's machine, over SSH, once a
# person has done their part: the user and its automatic login, the tools, the
# agent's logins, the secrets files and the orchestrator's key (runbook
# sections 1, 2, 4 and 5, and "Orchestrator access over SSH"). Then:
#
#   section 3   both checkouts, their dependencies (PolAds's through the
#               agent's standalone pnpm), and the profile
#   section 6   ~/.agentd/config.json from templates/config.example.json, and
#               the first start's PAUSE
#   section 8   install.sh
#   section 9   agentctl probe-sandbox and probe-hooks --scripted (ssh -tt)
#   then        agentctl status (paused) and agentctl doctor
#
#   bootstrap-mini.sh [--dry-run] [--key <file>] [--force-config] [--usertest <file>]
#                     --allowed-users U1,U2 [--other-bots U3] <agent> <host>
#
# --usertest <file> holds what config.json's `usertest` section (the browser
# test, WS5) adds to the template's: `enabled` and the staging personas, which
# this public repository may not name. The orchestrator keeps it in a private
# file. Without it the section is left out, and the browser test stays off,
# so --force-config without --usertest turns the test off on that mini.
#
# One step per SSH call, each read before the next: the first that fails
# stops the run and names itself. Re-runnable: a checkout that exists is
# fetched, config.json that exists is kept (--force-config writes it again),
# and PAUSE is written only on a mini that had no config.json yet. No secret
# is read, passed or printed: the secrets files are checked by their mode.
# --dry-run prints each step's command and runs none.
#
# Over SSH the login keychain is locked, so gh, and git through gh's
# credential helper, cannot reach the private PolAds repository. Its clone and
# fetch run in the agent's automatic-login session (scripts/gui-session.sh,
# sent over the same SSH call). dev-tasks is public and needs no login.
set -euo pipefail

RUNTIME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$RUNTIME/templates/config.example.json"
GUI_SESSION="$RUNTIME/scripts/gui-session.sh"
DEV_TASKS_URL="https://github.com/STEP-Network/dev-tasks.git"
POLADS_REPO="STEP-Network/v0-politiske-annoncer"

usage() {
  echo "usage: bootstrap-mini.sh [--dry-run] [--key <file>] [--force-config] [--usertest <file>] --allowed-users U1,U2 [--other-bots U3] <agent> <host>" >&2
  echo "  --allowed-users  the Slack member ids that may talk to the agent, the same on every mini" >&2
  echo "  --other-bots     the other agents' bot user ids (slack.otherAgentBots)" >&2
  echo "  --usertest       a JSON file with config.json's usertest section (the browser test, kept private)" >&2
  echo "  --force-config   writes config.json again: without --usertest it leaves the browser test section out" >&2
  echo "  --key            the SSH key for <agent>@<host> (default ~/.ssh/<agent>_mini_ed25519 when it exists)" >&2
  exit 64
}
fail() { echo "bootstrap: $*" >&2; exit 64; }

DRY=0
FORCE=0
KEY=""
USERS=""
BOTS=""
USERTEST=""
ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --force-config) FORCE=1 ;;
    --key) [ "$#" -ge 2 ] || usage; KEY=$2; shift ;;
    --allowed-users) [ "$#" -ge 2 ] || usage; USERS=$2; shift ;;
    --other-bots) [ "$#" -ge 2 ] || usage; BOTS=$2; shift ;;
    --usertest) [ "$#" -ge 2 ] || usage; USERTEST=$2; shift ;;
    -h | --help) usage ;;
    -*) echo "bootstrap: unknown option $1" >&2; usage ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done
[ "${#ARGS[@]}" -eq 2 ] || usage
AGENT=${ARGS[0]}
HOST=${ARGS[1]}

# Both go into commands and file paths as they are.
[[ "$AGENT" =~ ^[a-z][a-z0-9-]{0,27}$ ]] || fail "the agent's name is its macOS user in lower case (eve, bob): '$AGENT'"
[[ "$HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || fail "the host is the mini's name on Tailscale: '$HOST'"
ids_json() { # a comma list of Slack ids, as a JSON array
  local list=$1 what=$2 id out=""
  IFS=, read -r -a ids <<< "$list"
  for id in ${ids[@]+"${ids[@]}"}; do
    [[ "$id" =~ ^[UW][A-Z0-9]{2,}$ ]] || fail "$what: '$id' is not a Slack member id (U... or W...)"
    out="${out:+$out,}\"$id\""
  done
  printf '[%s]' "$out"
}
[ -n "$USERS" ] || fail "--allowed-users is needed: the Slack member ids that may talk to $AGENT"
USERS_JSON=$(ids_json "$USERS" "--allowed-users")
BOTS_JSON=$(ids_json "$BOTS" "--other-bots")
if [ -z "$KEY" ] && [ -f "$HOME/.ssh/${AGENT}_mini_ed25519" ]; then KEY="$HOME/.ssh/${AGENT}_mini_ed25519"; fi
if [ -n "$KEY" ] && [ "$DRY" = 0 ] && [ ! -f "$KEY" ]; then fail "no SSH key at $KEY"; fi
command -v jq >/dev/null || fail "jq is missing on this machine"
if [ -n "$USERTEST" ]; then
  jq -e 'type == "object"' "$USERTEST" >/dev/null 2>&1 || fail "--usertest: $USERTEST is not a JSON object (config.json's usertest section)"
fi

WORK=$(mktemp -d -t bootstrap-mini-XXXX)
trap 'rm -rf "$WORK"' EXIT

# A command for the agent's login shell, quoted once for it.
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# ssh runs a shell that does not read ~/.zprofile, and pnpm's own installer
# writes its PATH to ~/.zshrc, which no script reads: so the PATH is named
# here, the standalone pnpm first, then Claude Code's folder, then Homebrew's.
BOOT_ENV='export PATH="$HOME/Library/pnpm/bin:$HOME/Library/pnpm:$HOME/.local/bin:/opt/homebrew/bin:$PATH" DISABLE_AUTOUPDATER=1'
login() { printf '/bin/zsh -lc %s' "$(q "$BOOT_ENV; $1")"; }

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30)
[ -n "$KEY" ] && SSH_OPTS+=(-i "$KEY")
TARGET="$AGENT@$HOST"
N=0
OUT="$WORK/out"

# step <name> <how> '<command>' [stdin file]
#   login        in the login shell, with BOOT_ENV
#   tty          as it is, over ssh -tt: the commands only a person's terminal may run
#   gui:<secs>   in the automatic-login session, where the keychain is open
step() {
  local name=$1 how=$2 command=$3 input=${4:-/dev/null} remote
  local ssh=(ssh)
  case "$how" in
    login) remote=$(login "$command") ;;
    tty) ssh+=(-tt); remote=$command ;;
    gui:*)
      remote=$(login "bash -s -- $name ${how#gui:} $(q "$BOOT_ENV; $command")")
      input=$GUI_SESSION
      ;;
  esac
  ssh+=("${SSH_OPTS[@]}" "$TARGET" "$remote")
  N=$((N + 1))
  echo "== $N. $name"
  if [ "$DRY" = 1 ]; then
    printf '   %s\n' "$(printf '%q ' "${ssh[@]:0:${#ssh[@]}-1}")"
    case "$how" in
      login) echo "   runs, in the login shell: $command" ;;
      tty) echo "   runs, at a terminal: $command" ;;
      gui:*) echo "   runs, in the automatic-login session (gui-session.sh on stdin, ${how#gui:}s at most): $command" ;;
    esac
    if [ "$input" != /dev/null ] && [ "$input" != "$GUI_SESSION" ]; then echo "   stdin: the $(basename "$input") above"; fi
    : > "$OUT"
    return 0
  fi
  set +e
  "${ssh[@]}" < "$input" 2>&1 | tee "$OUT"
  local code=${PIPESTATUS[0]}
  set -e
  if [ "$code" -ne 0 ]; then
    echo "bootstrap: step $N ($name) failed with exit $code. Fix what it says, then run the same command again: the steps before it are safe to repeat." >&2
    exit 1
  fi
}

step reach login 'printf "%s %s\n" "$(id -un)" "$HOME"'
REMOTE_HOME="/Users/$AGENT"
if [ "$DRY" = 0 ]; then
  read -r who REMOTE_HOME < <(tail -n 1 "$OUT")
  [ "$who" = "$AGENT" ] || { echo "bootstrap: $TARGET is the user '$who', not $AGENT" >&2; exit 1; }
fi

# What the person's steps leave behind, before anything is written.
step tools login 'missing=""; for t in node npm pnpm gh git jq tmux claude; do command -v "$t" >/dev/null || missing="$missing $t"; done
[ -z "$missing" ] || { echo "missing on the PATH:$missing (runbook sections 1 and 2)"; exit 1; }
echo "node $(node --version), pnpm $(pnpm --version) at $(command -v pnpm), $(claude --version)"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "$chrome" ]; then echo "Chrome: $("$chrome" --version)"; else echo "no Google Chrome: the browser test needs it (brew install --cask google-chrome from the admin account)"; fi'
step secrets login 'for f in ~/.config/linear/.env ~/.config/agentd/slack.env; do
  [ -f "$f" ] || { echo "$f is missing (runbook section 5)"; exit 1; }
  mode=$(stat -f %Lp "$f"); [ "$mode" = 600 ] || { echo "$f is mode $mode, not 600 (runbook section 5)"; exit 1; }
  echo "ok $f (600)"
done
u=~/.config/agentd/usertest.env
if [ -f "$u" ]; then
  mode=$(stat -f %Lp "$u"); [ "$mode" = 600 ] || { echo "$u is mode $mode, not 600 (runbook, The browser test)"; exit 1; }
  echo "ok $u (600)"
else
  echo "$u absent: the browser test runs signed out"
fi'
USERTEST_ENV_ABSENT=0
if [ "$DRY" = 0 ] && grep -q "usertest.env absent" "$OUT"; then USERTEST_ENV_ABSENT=1; fi
step gui-session login 'launchctl print "gui/$(id -u)" >/dev/null 2>&1 || { echo "$(id -un) has no GUI session: log in at the mini, with automatic login on (runbook section 1)"; exit 1; }
echo "ok gui/$(id -u)"'

# Section 3.
step dev-tasks login "if [ -d ~/dev-tasks/.git ]; then git -C ~/dev-tasks pull --ff-only -q; else git clone -q $DEV_TASKS_URL ~/dev-tasks; fi; git -C ~/dev-tasks log -1 --format='dev-tasks at %h %s'"
step polads gui:1200 "if [ -d ~/polads/.git ]; then git -C ~/polads fetch -q origin; else gh repo clone $POLADS_REPO ~/polads -- -q; fi"
step polads-staging login "git -C ~/polads checkout -q --detach origin/staging && git -C ~/polads log -1 --format='polads at %h %s'"
step polads-deps login 'cd ~/polads && pnpm install --frozen-lockfile'
step plugin-deps login 'cd ~/dev-tasks/plugin && npm ci'
step runtime-deps login 'cd ~/dev-tasks/runtime && npm ci'
PROFILE=$(jq -cn --arg mini "$AGENT" '{ profile: "agent", devSurface: "preview", mini: $mini }')
step profile login "mkdir -p ~/.claude && printf '%s\n' $(q "$PROFILE") > ~/.claude/dev-tasks-profile.json && cat ~/.claude/dev-tasks-profile.json"

# Section 6. The pause comes first: a run that stops between the two leaves a
# paused mini, never a configured one that starts working.
step pause login "if [ -e ~/.agentd/config.json ]; then echo 'configured before: the pause is left as it is'; elif [ -e ~/.agentd/PAUSE ]; then echo 'already paused'; else mkdir -p ~/.agentd && printf '%s\n' '{\"reason\":\"first start, not watched yet\"}' > ~/.agentd/PAUSE && echo 'paused: first start, not watched yet'; fi"
# Eve's models and limits are the template's. The queue starts on an empty allowlist.
jq --arg mini "$AGENT" --arg home "$REMOTE_HOME" --argjson users "$USERS_JSON" --argjson bots "$BOTS_JSON" '
  .mini = $mini
  | .repo.path = ($home + "/polads")
  | .pluginRoot = ($home + "/dev-tasks/plugin")
  | .slack.allowedUsers = $users
  | .slack.otherAgentBots = $bots
  | .queue.mode = "allowlist"
  | .queue.allow = []
  | .worker.autoMerge = true' "$TEMPLATE" > "$WORK/config.json"
# The browser test's section comes from the orchestrator's private file, or not at all.
if [ -n "$USERTEST" ]; then
  jq --slurpfile u "$USERTEST" '.usertest = ((.usertest // {}) + $u[0])' "$WORK/config.json" > "$WORK/config.next.json"
else
  jq 'del(.usertest)' "$WORK/config.json" > "$WORK/config.next.json"
fi
mv "$WORK/config.next.json" "$WORK/config.json"
if [ "$DRY" = 1 ]; then echo "config.json it writes on a mini that has none:"; jq . "$WORK/config.json"; fi
step config login "if [ -e ~/.agentd/config.json ] && [ $FORCE = 0 ]; then cat > /dev/null; echo 'kept ~/.agentd/config.json (--force-config writes it again)'; else mkdir -p ~/.agentd && cat > ~/.agentd/config.json.tmp && mv ~/.agentd/config.json.tmp ~/.agentd/config.json && echo 'wrote ~/.agentd/config.json'; fi" "$WORK/config.json"

# Sections 8 and 9.
step install login 'bash ~/dev-tasks/runtime/scripts/install.sh'
step probe-sandbox tty '~/.agentd/bin/agentctl probe-sandbox'
step probe-hooks tty '~/.agentd/bin/agentctl probe-hooks --scripted'
step status login '~/.agentd/bin/agentctl status'
step doctor login '~/.agentd/bin/agentctl doctor'
step bot login "jq -r '.botUserId // empty' ~/.agentd/state/bridge.json 2>/dev/null || true"
BOT=""
if [ "$DRY" = 0 ]; then BOT=$(tail -n 1 "$OUT" | tr -d '\r'); fi
[[ "$BOT" =~ ^[UW][A-Z0-9]{2,}$ ]] || BOT=""

BOT_SHOWN=${BOT:-<bot id>}
cat <<EOF

$AGENT is installed and paused. What is left:

1. At the mini, as $AGENT (in person or over Screen Sharing): runbook
   section 7 if doctor's "front door plugin" line warns, and then
   tmux -L agentd kill-session -t =frontdoor (agentd starts it again within
   15 seconds, with the plugin). Then ~/.agentd/bin/agentctl doctor, which
   checks the claude and gh logins that SSH cannot.
2. On every other mini (Eve's too), as that agent: add $AGENT's bot to
   slack.otherAgentBots and restart its bridge. Over SSH, one call each,
   the first two as zsh -lc '<command>':
EOF
if [ -z "$BOT" ]; then
  echo "   ($AGENT's bot id is not known yet: the bridge writes it to ~/.agentd/state/bridge.json once Slack takes the app. Run this again then, or copy the member id from the bot's Slack profile.)"
fi
printf '     %s\n' \
  "jq --arg bot $BOT_SHOWN '.slack.otherAgentBots |= ((. + [\$bot]) | unique)' ~/.agentd/config.json > ~/.agentd/config.json.new" \
  "mv ~/.agentd/config.json.new ~/.agentd/config.json" \
  "launchctl kickstart -k gui/\$(id -u)/eu.polads.slack-bridge"
LAST=3
if [ "$USERTEST_ENV_ABSENT" = 1 ]; then
  echo "3. For the browser test: put TEST_LOGIN_SECRET and VERCEL_AUTOMATION_BYPASS_SECRET in ~/.config/agentd/usertest.env on the mini, chmod 600 (Nate has the values)."
  LAST=4
fi
echo "$LAST. When someone is watching: ssh -tt $TARGET '~/.agentd/bin/agentctl resume'"
