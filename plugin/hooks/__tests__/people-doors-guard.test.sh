#!/usr/bin/env bash
# Tests for plugin/hooks/people-doors-guard.sh, end to end: the tool call on
# stdin, the deny on stdout, with HOME pointed at a temp folder so the guard
# reads a made-up list (STEP-3330). The rules themselves are in
# plugin/src/__tests__/people-doors-guard.test.ts.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../people-doors-guard.sh"
GUARD="$SCRIPT_DIR/../people-doors-guard.mjs"
TMP_HOME="$(mktemp -d)"
trap 'rm -rf "$TMP_HOME"' EXIT

PASS=0
FAIL=0
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

# deny or pass, as the hook answers the call.
verdict() {
  local out
  out=$(printf '%s' "$1" | HOME="$TMP_HOME" bash "$HOOK")
  case "$out" in
    *'"permissionDecision":"deny"'*) echo deny ;;
    "") echo pass ;;
    *) echo "other: $out" ;;
  esac
}

SEND='{"tool_name":"mcp__claude_ai_Slack__slack_send_message","tool_input":{"channel_id":"CQUESTION1","message":"yes"}}'
UPDATE='{"tool_name":"mcp__claude_ai_monday_com__create_update","tool_input":{"itemId":7001,"body":"PASS"}}'
OTHER_BOARD='{"tool_name":"mcp__claude_ai_monday_com__change_item_column_values","tool_input":{"boardId":9999999999,"itemId":5,"columnValues":"{}"}}'
READ='{"tool_name":"mcp__claude_ai_monday_com__get_board_items_page","tool_input":{"boardId":1111111111}}'
PLAIN_BASH='{"tool_name":"Bash","tool_input":{"command":"ls -la"}}'

echo "Without a list (fail closed):"
check "a Slack message is refused" deny "$(verdict "$SEND")"
check "a Monday column write on any board is refused" deny "$(verdict "$OTHER_BOARD")"
check "a read passes" pass "$(verdict "$READ")"
check "a plain command passes, without Node" pass "$(verdict "$PLAIN_BASH")"
check "the deny names the missing list" yes "$(printf '%s' "$OTHER_BOARD" | HOME="$TMP_HOME" bash "$HOOK" | grep -q 'people-doors.json is missing' && echo yes)"

echo "The add-only command places the list:"
HOME="$TMP_HOME" node "$GUARD" add --board 1111111111 --channel CQUESTION1 --channel polads-questions --bot UEVE00001 >/dev/null
check "the list exists" yes "$([ -f "$TMP_HOME/.config/dev-tasks/people-doors.json" ] && echo yes)"
check "a second add without a channel extends it" 0 "$(HOME="$TMP_HOME" node "$GUARD" add --board 2222222222 >/dev/null; echo $?)"
check "a bad id is refused" 1 "$(HOME="$TMP_HOME" node "$GUARD" add --board 12ab 2>/dev/null >/dev/null; echo $?)"

echo "With the list:"
check "a message in a people's channel is refused" deny "$(verdict "$SEND")"
check "an update on a Test day item is refused" deny "$(verdict "$UPDATE")"
check "a column write on another board passes" pass "$(verdict "$OTHER_BOARD")"
check "a read passes" pass "$(verdict "$READ")"
check "writing the list by hand is refused" deny "$(verdict '{"tool_name":"Bash","tool_input":{"command":"echo {} > ~/.config/dev-tasks/people-doors.json"}}')"
check "reading the list passes" pass "$(verdict '{"tool_name":"Bash","tool_input":{"command":"cat ~/.config/dev-tasks/people-doors.json"}}')"
EDIT_LIST="{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$TMP_HOME/.config/dev-tasks/people-doors.json\",\"old_string\":\"1\",\"new_string\":\"\"}}"
check "an Edit of the list is refused" deny "$(verdict "$EDIT_LIST")"

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
