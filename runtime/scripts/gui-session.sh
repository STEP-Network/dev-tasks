#!/bin/bash
# Runs one command in the agent's automatic-login (GUI) session and waits for
# it: gui-session.sh <name> <timeout-seconds> '<command>'. Over SSH the login
# keychain is locked, so gh, and git through gh's credential helper, cannot
# reach a private repository ("could not read Username"). A LaunchAgent in
# gui/<uid> runs where the keychain is open, as agentd's own jobs do. The
# command runs under `zsh -lc`, for the login shell's PATH, and this prints
# its output and exits with its status (124 when it ran out of time).
# bootstrap-mini.sh calls it over SSH. It takes no secret and prints none.
set -euo pipefail

[ "$#" -eq 3 ] || { echo "usage: gui-session.sh <name> <timeout-seconds> '<command>'" >&2; exit 64; }
NAME=$1
TIMEOUT=$2
COMMAND=$3
case "$NAME" in *[!a-z0-9-]* | "") echo "gui-session: the name must be lower-case letters, digits and dashes" >&2; exit 64 ;; esac
case "$TIMEOUT" in *[!0-9]* | "") echo "gui-session: the timeout is a number of seconds" >&2; exit 64 ;; esac

LAUNCHCTL="${LAUNCHCTL:-launchctl}"
DIR="${AGENTD_HOME:-$HOME/.agentd}/bootstrap"
LABEL="eu.polads.bootstrap.$NAME"
PLIST="$DIR/$LABEL.plist"
LOG="$DIR/$NAME.log"
STATUS="$DIR/$NAME.status"
DOMAIN="gui/$(id -u)"

mkdir -p "$DIR"
"$LAUNCHCTL" bootout "$DOMAIN/$LABEL" 2>/dev/null || true
rm -f "$LOG" "$STATUS"

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
# The status file is written last, whatever the command does: in a subshell,
# even its own `exit` leaves the line after it to run.
SCRIPT="$(printf '(\n%s\n)\necho $? > %q\n' "$COMMAND" "$STATUS" | xml)"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>$SCRIPT</string></array>
  <key>StandardOutPath</key><string>$(printf '%s' "$LOG" | xml)</string>
  <key>StandardErrorPath</key><string>$(printf '%s' "$LOG" | xml)</string>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
EOF

finish() {
  "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
}
trap finish EXIT
"$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST" || { echo "gui-session: launchctl bootstrap $DOMAIN failed: is $(id -un) logged in at the mini (automatic login, runbook section 1)?" >&2; exit 1; }

waited=0
until [ -s "$STATUS" ]; do
  if [ "$waited" -ge "$TIMEOUT" ]; then
    [ -f "$LOG" ] && tail -n 40 "$LOG"
    echo "gui-session: $NAME still running after ${TIMEOUT}s: stopped" >&2
    exit 124
  fi
  sleep 2
  waited=$((waited + 2))
done
[ -f "$LOG" ] && cat "$LOG"
exit "$(cat "$STATUS")"
