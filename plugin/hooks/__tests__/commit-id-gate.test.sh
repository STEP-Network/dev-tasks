#!/usr/bin/env bash
# Tests for plugin/hooks/commit-id-gate.sh
#
# Covers format enforcement (always-on) + board validation (mocked Monday API).
# curl is mocked via a PATH shim that emits a canned body + HTTP code chosen by
# the MOCK_SCENARIO env var, so the board-membership branches run offline.
#
# Each board-validation case uses a UNIQUE task id so the hook's /tmp validated-id
# cache can't carry a "valid" verdict from one case into the next (the bug that
# made the prior version fail 2/11). All ids used here are cleared up front; the
# explicit cache test sets its own marker.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../commit-id-gate.sh"

# Unique ids per case (8+ digits so they clear the format floor).
ID_NOCREDS=29511720001
ID_TASKS=29511720002
ID_WRONG=29511720003
ID_NOTFOUND=29511720004
ID_HTTP500=29511720005
ID_CACHE=29511720006

for _id in $ID_NOCREDS $ID_TASKS $ID_WRONG $ID_NOTFOUND $ID_HTTP500 $ID_CACHE; do
  rm -f "/tmp/.claude-commit-id-ok-${_id}"
done

PASS=0
FAIL=0
check() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc (expected exit $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

# --- mock curl shim ---------------------------------------------------------
MOCKBIN="$(mktemp -d)"
cat > "$MOCKBIN/curl" <<'MOCK'
#!/bin/bash
# Emits "<body>\n<http_code>" to match the hook's `-w '\n%{http_code}'`.
case "$MOCK_SCENARIO" in
  tasks_board)   printf '%s\n200' '{"data":{"items":[{"id":"1","board":{"id":"5091706356"}}]}}' ;;
  wrong_board)   printf '%s\n200' '{"data":{"items":[{"id":"1","board":{"id":"9999999999"}}]}}' ;;
  not_found)     printf '%s\n200' '{"data":{"items":[]}}' ;;
  http_500)      printf '%s\n500' 'upstream error' ;;
  *)             printf '%s\n200' '{"data":{"items":[]}}' ;;
esac
MOCK
chmod +x "$MOCKBIN/curl"
ORIG_PATH="$PATH"

# --- project-config harness -------------------------------------------------
make_cfg() {  # $1 = enabled? "yes"/"no"
  local dir; dir="$(mktemp -d)"
  mkdir -p "$dir/.claude"
  if [ "$1" = "yes" ]; then
    echo '{"hooks":{"enabled":["commit-id-gate"]}}' > "$dir/.claude/project-config.json"
  else
    echo '{"hooks":{"enabled":[]}}' > "$dir/.claude/project-config.json"
  fi
  printf '%s' "$dir"
}

# run <cfg-dir> <api-key> <scenario> <command-json>
run() {
  local cfg="$1" key="$2" scenario="$3" cmd="$4"
  printf '%s' "{\"cwd\":\"$cfg\",\"tool_input\":{\"command\":$cmd}}" | \
    PATH="$MOCKBIN:$ORIG_PATH" CLAUDE_PROJECT_DIR="$cfg" MONDAY_API_KEY="$key" \
    MOCK_SCENARIO="$scenario" bash "$HOOK" >/dev/null 2>&1
  echo $?
}

echo "commit-id-gate.test.sh"

CFG_ON="$(make_cfg yes)"
CFG_OFF="$(make_cfg no)"

# 1. No id → block (format layer, offline)
check "no id → block" 2 "$(run "$CFG_ON" "" "" '"git commit -m \"fix: thing\""')"

# 2. Short PR ref (#60) not mistaken for a Monday id → block
check "short PR ref #60 → block" 2 "$(run "$CFG_ON" "" "" '"git commit -m \"fix (#60)\""')"

# 3. Valid format, no creds → warn + allow
check "valid format, no creds → allow" 0 "$(run "$CFG_ON" "" "" "\"git commit -m \\\"x #${ID_NOCREDS}\\\"\"")"

# 4. Valid task id, API says Tasks board → allow
check "task id on Tasks board → allow" 0 "$(run "$CFG_ON" "key" "tasks_board" "\"git commit -m \\\"x #${ID_TASKS}\\\"\"")"

# 5. Id resolves to a different board → block
check "id on wrong board → block" 2 "$(run "$CFG_ON" "key" "wrong_board" "\"git commit -m \\\"x #${ID_WRONG}\\\"\"")"

# 6. Id not found on any board → block
check "id not found → block" 2 "$(run "$CFG_ON" "key" "not_found" "\"git commit -m \\\"x #${ID_NOTFOUND}\\\"\"")"

# 7. API HTTP 500 but format valid → warn + allow (don't brick on network)
check "API 500, format valid → allow" 0 "$(run "$CFG_ON" "key" "http_500" "\"git commit -m \\\"x #${ID_HTTP500}\\\"\"")"

# 8. amend --no-edit → skip
check "amend --no-edit → skip" 0 "$(run "$CFG_ON" "key" "tasks_board" '"git commit --amend --no-edit"')"

# 9. not a git commit → skip
check "non-commit git → skip" 0 "$(run "$CFG_ON" "" "" '"git push origin main"')"

# 10. hook disabled in project-config → skip (no id, would otherwise block)
check "hook disabled → skip" 0 "$(run "$CFG_OFF" "" "" '"git commit -m \"no id here\""')"

# 11. fresh cache marker lets an id pass even when the API would 500
touch "/tmp/.claude-commit-id-ok-${ID_CACHE}"
check "fresh cache hit → allow despite API 500" 0 "$(run "$CFG_ON" "key" "http_500" "\"git commit -m \\\"x #${ID_CACHE}\\\"\"")"

# --- cleanup ----------------------------------------------------------------
rm -f "$MOCKBIN/curl"
rmdir "$MOCKBIN" 2>/dev/null || true
rm -rf "$CFG_ON" "$CFG_OFF"
for _id in $ID_NOCREDS $ID_TASKS $ID_WRONG $ID_NOTFOUND $ID_HTTP500 $ID_CACHE; do
  rm -f "/tmp/.claude-commit-id-ok-${_id}"
done

echo ""
echo "  Total: $((PASS + FAIL)) — Passed: $PASS, Failed: $FAIL"
[ "$FAIL" -eq 0 ]
