#!/usr/bin/env bash
# Tests for plugin/hooks/people-doors-guard.sh, end to end: the tool call on
# stdin, the deny on stdout (STEP-3330). The rules themselves are in
# plugin/src/__tests__/people-doors-guard.test.ts. The list is root's
# (/etc/dev-tasks/people-doors.json) and no test may write it, so the cases
# that need it absent are skipped on a machine that has one.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../people-doors-guard.sh"
GUARD="$SCRIPT_DIR/../people-doors-guard.mjs"
TMP_HOME="$(mktemp -d)"
trap 'rm -rf "$TMP_HOME"' EXIT

PASS=0
FAIL=0
SKIP=0
check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc (expected $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

# deny or pass, as the hook answers the call. No Monday or Linear key, so no lookup reaches the network.
verdict() {
  local out
  out=$(printf '%s' "$1" | env -u MONDAY_API_KEY -u LINEAR_API_KEY HOME="$TMP_HOME" bash "$HOOK")
  case "$out" in
    *'"permissionDecision":"deny"'*) echo deny ;;
    "") echo pass ;;
    *) echo "other: $out" ;;
  esac
}

SEND='{"tool_name":"mcp__claude_ai_Slack__slack_send_message","tool_input":{"channel_id":"COTHER0001","message":"lunch?"}}'
UPDATE='{"tool_name":"mcp__claude_ai_monday_com__create_update","tool_input":{"itemId":7000000002,"body":"Done"}}'
DEV_UPDATE='{"tool_name":"mcp__plugin_dev-tasks_dev-tasks__createUpdate","tool_input":{"taskId":"7000000002","body":"Deployed"}}'
HOSTED_DEV='{"tool_name":"mcp__claude_ai_Dev_Tasks__createUpdate","tool_input":{"itemId":"7000000002","body":"PASS"}}'
READ='{"tool_name":"mcp__claude_ai_monday_com__get_board_items_page","tool_input":{"boardId":1111111111}}'
PLAIN_BASH='{"tool_name":"Bash","tool_input":{"command":"ls -la"}}'

echo "The API writes from the shell (with or without a list):"
check "a Monday mutation with curl is refused" deny "$(verdict '{"tool_name":"Bash","tool_input":{"command":"curl https://api.monday.com/v2 -d {\"query\":\"mutation { create_update(item_id: 1, body: \\\"yes\\\") { id } }\"}"}}')"
check "a Linear body from a file is refused" deny "$(verdict '{"tool_name":"Bash","tool_input":{"command":"curl https://api.linear.app/graphql --data @body.json"}}')"
check "a Slack message with curl is refused" deny "$(verdict '{"tool_name":"Bash","tool_input":{"command":"curl -X POST https://slack.com/api/chat.postMessage -d channel=C1 -d text=yes"}}')"
check "sudo on the guard's list is refused" deny "$(verdict '{"tool_name":"Bash","tool_input":{"command":"echo {} | sudo tee /etc/dev-tasks/people-doors.json"}}')"
check "a Monday read with curl passes" pass "$(verdict '{"tool_name":"Bash","tool_input":{"command":"curl https://api.monday.com/v2 -d {\"query\":\"query { me { id } }\"}"}}')"
check "a plain command passes, without Node" pass "$(verdict "$PLAIN_BASH")"
check "an answer entry through the hosted Linear server is refused" deny "$(verdict '{"tool_name":"mcp__claude_ai_Linear__save_comment","tool_input":{"issueId":"STEP-7","body":"<!-- slack:1790000000.000100 -->\nyes"}}')"
check "a plan approved on a new issue is refused" deny "$(verdict '{"tool_name":"mcp__linear-server__save_issue","tool_input":{"team":"STEP","title":"New","labels":["plan-approved"]}}')"

if [ -e /etc/dev-tasks/people-doors.json ] || [ -e /etc/dev-tasks/people-doors.off ]; then
  echo "Without a list: skipped, this machine has /etc/dev-tasks"
  SKIP=$((SKIP + 7))
else
  echo "Without a list (fail closed):"
  check "a Slack message anywhere is refused" deny "$(verdict "$SEND")"
  check "a Monday update on any board is refused" deny "$(verdict "$UPDATE")"
  check "a dev-tasks update is refused" deny "$(verdict "$DEV_UPDATE")"
  check "a hosted dev-tasks update is refused" deny "$(verdict "$HOSTED_DEV")"
  check "a read passes" pass "$(verdict "$READ")"
  check "the deny names the list" yes "$(printf '%s' "$SEND" | HOME="$TMP_HOME" bash "$HOOK" | grep -q '/etc/dev-tasks/people-doors.json is missing' && echo yes)"

  echo "A \$HOME override and an empty list don't disable it:"
  mkdir -p "$TMP_HOME/.config/dev-tasks"
  printf '%s' '{"mondayBoards":[],"slackChannels":[],"agentBots":[]}' >"$TMP_HOME/.config/dev-tasks/people-doors.json"
  : >"$TMP_HOME/.config/dev-tasks/people-doors.off"
  check "a Slack message is still refused" deny "$(verdict "$SEND")"
fi

echo "The check command:"
if [ -e /etc/dev-tasks/people-doors.json ] || [ -e /etc/dev-tasks/people-doors.off ]; then
  echo "  (skipped: this machine has /etc/dev-tasks)"
  SKIP=$((SKIP + 1))
else
  check "says there is no trusted list, and fails" 1 "$(node "$GUARD" check >/dev/null; echo $?)"
fi

echo ""
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" -eq 0 ]
