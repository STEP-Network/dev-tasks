#!/bin/bash
# The hard stop: both LaunchAgents out, the front door and any worker stopped,
# and the mini paused, so a later install.sh starts nothing until a person
# runs agentctl resume. Leaves ~/.agentd (state, logs, worktrees, the front
# door's settings) for whoever looks next, and touches nothing in Linear,
# Slack or GitHub: the runbook's Rollback section covers those.
set -uo pipefail
AGENTD_HOME="${AGENTD_HOME:-$HOME/.agentd}"
LAUNCH_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LAUNCHCTL="${LAUNCHCTL:-launchctl}"
CONFIG="$AGENTD_HOME/config.json"
SESSION="$(jq -r '.frontDoor.tmuxSession // "frontdoor"' "$CONFIG" 2>/dev/null)"
[ -n "$SESSION" ] || SESSION=frontdoor
TMUX_BIN="$(jq -r '.frontDoor.tmuxPath // "tmux"' "$CONFIG" 2>/dev/null)"
[ -n "$TMUX_BIN" ] || TMUX_BIN=tmux

# A pause a person or agentd set is kept, with its reason.
if [ -d "$AGENTD_HOME" ] && [ ! -e "$AGENTD_HOME/PAUSE" ]; then
  printf '{"at":"%s","reason":"uninstalled"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$AGENTD_HOME/PAUSE"
  echo "paused"
fi

for label in eu.polads.agentd eu.polads.slack-bridge; do
  "$LAUNCHCTL" bootout "gui/$(id -u)/$label" 2>/dev/null && echo "stopped $label"
  rm -f "$LAUNCH_DIR/$label.plist"
done

# The front door's own tmux server (tmux -L agentd), and the session by its
# exact name: a bare name would also match a session it begins.
"$TMUX_BIN" -L agentd kill-session -t "=$SESSION" 2>/dev/null && echo "stopped the front door"

# A worker is its own process group. Its pid is signalled only while it is
# still that job's worker (agentd's workerLiveness): after a reboot or a crash
# the pid can belong to any process.
for job in "$AGENTD_HOME"/jobs/running/*.json; do
  [ -f "$job" ] || continue
  id="$(basename "$job" .json)"
  pid="$(jq -r '.pid // empty' "$job" 2>/dev/null)"
  [ -n "$pid" ] || continue
  command="$(/bin/ps -p "$pid" -o command= 2>/dev/null)"
  case " $command " in
    *"worker/run.ts $id "*)
      kill -TERM -- "-$pid" 2>/dev/null && echo "stopped the worker for $id (process group $pid)"
      ;;
    *)
      echo "left pid $pid alone: it is not the worker for $id any more"
      ;;
  esac
done
echo "stopped. Claims stay in Linear until released: see the runbook, Rollback. Nothing restarts until install.sh, and nothing runs until agentctl resume."
