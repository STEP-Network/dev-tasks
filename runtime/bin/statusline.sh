#!/bin/bash
# The front door's status line. Claude Code runs it after each update with a
# JSON payload on stdin. It prints one short line and, as its real job,
# records the subscription rate limits in ~/.agentd/state/usage.json for
# agentd (limit-aware restarts) and agentctl tick (light mode). The
# rate_limits object needs Claude Code v2.1.251+ on a Pro or Max plan;
# without it the fields are recorded as null.
#
# The front door's settings name it (~/.agentd/front-door-settings.json). A
# person's own session on the mini may run it too, if they set it up: the
# limits are the account's, so any session's count, but the session id is
# the one agentd resumes, so only the front door's is recorded, with when it
# was reported. agentd starts its tmux session with AGENTD_FRONT_DOOR=1, and
# any other session keeps the id and time already there.
input=$(cat)
state="${AGENTD_HOME:-$HOME/.agentd}/state"
mkdir -p "$state"
keep='{"sessionId":null,"sessionAt":null}'
if [ "${AGENTD_FRONT_DOOR:-}" != "1" ] && [ -f "$state/usage.json" ]; then
  keep=$(jq -c '{sessionId: (.sessionId // null), sessionAt: (.sessionAt // null)}' "$state/usage.json" 2>/dev/null) || keep='{"sessionId":null,"sessionAt":null}'
fi
tmp="$state/usage.json.$$.tmp"
if printf '%s' "$input" | jq -c --argjson keep "$keep" --arg frontdoor "${AGENTD_FRONT_DOOR:-}" '(now | todate) as $now | {
    at: $now,
    sessionId: (if $frontdoor == "1" then .session_id else $keep.sessionId end),
    sessionAt: (if $frontdoor == "1" then $now else $keep.sessionAt end),
    fiveHourPct: .rate_limits.five_hour.used_percentage,
    fiveHourResetsAt: .rate_limits.five_hour.resets_at,
    sevenDayPct: .rate_limits.seven_day.used_percentage,
    sevenDayResetsAt: .rate_limits.seven_day.resets_at
  }' > "$tmp" 2>/dev/null; then
  mv "$tmp" "$state/usage.json"
else
  rm -f "$tmp"
fi
printf '%s' "$input" | jq -r '"[\(.model.display_name // "?")] 5h \(.rate_limits.five_hour.used_percentage // "?")% 7d \(.rate_limits.seven_day.used_percentage // "?")%"' 2>/dev/null || echo "[front door]"
