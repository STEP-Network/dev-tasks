#!/bin/bash
# Tests runtime/bin/statusline.sh: the line it prints and the usage snapshot
# it records for agentd and agentctl tick. Needs jq.
set -u
RUNTIME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; PASS=$((PASS + 1)); else echo "FAIL: $1 (expected '$3', got '$2')"; FAIL=$((FAIL + 1)); fi
}

export AGENTD_HOME
AGENTD_HOME=$(mktemp -d -t statusline-XXXX)
trap 'rm -rf "$AGENTD_HOME"' EXIT
USAGE="$AGENTD_HOME/state/usage.json"

# agentd starts the front door's tmux session with AGENTD_FRONT_DOOR=1.
line=$(printf '%s' '{"session_id":"s-1","model":{"display_name":"Sonnet"},"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1790000000},"seven_day":{"used_percentage":41.2,"resets_at":1790500000}}}' | AGENTD_FRONT_DOOR=1 bash "$RUNTIME/bin/statusline.sh")
check "prints the model and both windows" "$line" "[Sonnet] 5h 23.5% 7d 41.2%"
check "records the 5-hour percentage" "$(jq -r .fiveHourPct "$USAGE")" "23.5"
check "records the weekly reset" "$(jq -r .sevenDayResetsAt "$USAGE")" "1790500000"
check "records the front door's session" "$(jq -r .sessionId "$USAGE")" "s-1"

line=$(printf '%s' '{"session_id":"s-2","model":{"display_name":"Sonnet"}}' | AGENTD_FRONT_DOOR=1 bash "$RUNTIME/bin/statusline.sh")
check "copes without rate_limits" "$line" "[Sonnet] 5h ?% 7d ?%"
check "records null, not the previous number" "$(jq -r .fiveHourPct "$USAGE")" "null"
check "records the front door's new session" "$(jq -r .sessionId "$USAGE")" "s-2"
session_at=$(jq -r .sessionAt "$USAGE")
check "records when the front door reported it" "$([ "$session_at" != null ] && echo set)" "set"
sleep 1

# A person's own claude session on the mini has the same status line. Its
# limits are the account's, so they count, but its session is not the one
# agentd resumes.
line=$(printf '%s' '{"session_id":"person-1","model":{"display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":50,"resets_at":1790000000}}}' | env -u AGENTD_FRONT_DOOR bash "$RUNTIME/bin/statusline.sh")
check "prints a person's session line too" "$line" "[Opus] 5h 50% 7d ?%"
check "records the account's limits from any session" "$(jq -r .fiveHourPct "$USAGE")" "50"
check "keeps the front door's session, not a person's" "$(jq -r .sessionId "$USAGE")" "s-2"
check "keeps when the front door reported it" "$(jq -r .sessionAt "$USAGE")" "$session_at"

printf 'not json' | AGENTD_FRONT_DOOR=1 bash "$RUNTIME/bin/statusline.sh" >/dev/null
check "keeps the last good snapshot when the input is garbage" "$(jq -r .fiveHourPct "$USAGE")" "50"
check "leaves no temporary file behind" "$(ls "$AGENTD_HOME/state" | tr '\n' ' ')" "usage.json "

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
