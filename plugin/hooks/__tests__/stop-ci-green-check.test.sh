#!/bin/bash
# Tests for plugin/hooks/stop-ci-green-check.sh — focused on the v0.26.0
# per-task CI Gate skip path. gh + curl are PATH-mocked; the Monday live read
# is driven via MOCK_CURL_RESPONSE.
#
# Run with: bash plugin/hooks/__tests__/stop-ci-green-check.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../stop-ci-green-check.sh"

if [ ! -f "$HOOK" ]; then
  echo "FATAL: hook not found at $HOOK"
  exit 1
fi

PASS=0
FAIL=0

# --- Fixture: repo + branch + PATH mocks -------------------------------------
TEST_DIR=$(mktemp -d -t stop-ci-green-test-XXXX)
BRANCH="citest-$$"
SAFE_BRANCH=$(echo "$BRANCH" | sed 's|/|__|g')
MARKER="/tmp/.claude-pushed-${SAFE_BRANCH}"
ACK_FILE="/tmp/.claude-ci-ack-${SAFE_BRANCH}"

mkdir -p "$TEST_DIR/repo/.claude" "$TEST_DIR/bin"
cd "$TEST_DIR/repo"
git init --quiet -b "$BRANCH"
git config user.email "test@test.local"
git config user.name "Test"
echo x > x.txt
git add x.txt && git commit -qm init

cat > "$TEST_DIR/bin/gh" <<'EOF'
#!/bin/bash
case "$*" in
  *"pr list"*)   echo "${MOCK_PR_NUMBER:-42}" ;;
  *"pr view"*)   echo "${MOCK_PR_TITLE:-Regular PR}" ;;
  *"pr checks"*) echo "${MOCK_CHECKS:-[]}" ;;
esac
EOF
cat > "$TEST_DIR/bin/curl" <<'EOF'
#!/bin/bash
# Monday live-read mock. Empty MOCK_CURL_RESPONSE = network failure.
if [ -n "${MOCK_CURL_RESPONSE:-}" ]; then echo "$MOCK_CURL_RESPONSE"; fi
EOF
chmod +x "$TEST_DIR/bin/gh" "$TEST_DIR/bin/curl"
export PATH="$TEST_DIR/bin:$PATH"

PENDING_CHECKS='[{"name":"Vercel","bucket":"pending"}]'
FAILED_CHECKS='[{"name":"Test","bucket":"fail"}]'
CANCELLED_CHECKS='[{"name":"Vercel","bucket":"cancel"}]'
GREEN_CHECKS='[{"name":"Vercel","bucket":"pass"}]'

gate_response() {
  printf '{"data":{"items":[{"column_values":[{"id":"color_mm46jxc","text":"%s"}]}]}}' "$1"
}

write_state() {
  # write_state <ciGate-or-empty>
  if [ -z "$1" ]; then
    printf '{"taskId":"123","branch":"%s"}\n' "$BRANCH" > .claude/active-task.json
  else
    printf '{"taskId":"123","branch":"%s","ciGate":"%s"}\n' "$BRANCH" "$1" > .claude/active-task.json
  fi
}

# run_case <name> <expect_exit> <checks-json> <local-gate> <monday-key-or-empty> <curl-response>
run_case() {
  local name="$1" expect_exit="$2" checks="$3" local_gate="$4" api_key="$5" curl_resp="$6"
  : > "$MARKER"
  rm -f "$ACK_FILE"
  write_state "$local_gate"
  local out exit_code
  out=$(echo "{\"cwd\":\"$TEST_DIR/repo\"}" \
    | MOCK_CHECKS="$checks" MOCK_CURL_RESPONSE="$curl_resp" MONDAY_API_KEY="$api_key" \
      bash "$HOOK" 2>&1)
  exit_code=$?
  if [ "$exit_code" = "$expect_exit" ]; then
    echo "  PASS: $name"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $name (expected exit=$expect_exit, got=$exit_code)"
    echo "         output: $out"
    FAIL=$((FAIL+1))
  fi
}

echo "stop-ci-green-check.sh (CI Gate):"

# 1. Baseline: no gate, pending checks → block
run_case "no gate + pending → BLOCK" 2 "$PENDING_CHECKS" "" "" ""

# 2. Local mirror Skip (human), offline (no API key) → allow
run_case "local Skip (human) + pending, offline → ALLOW" 0 "$PENDING_CHECKS" "Skip (human)" "" ""

# 3. Skip gate + FAILED checks → still block (red is never skippable)
run_case "Skip (human) + failed → BLOCK" 2 "$FAILED_CHECKS" "Skip (human)" "" ""

# 4. Live Monday says Full, stale local mirror says Skip → live wins → block
run_case "live Full overrides local Skip → BLOCK" 2 "$PENDING_CHECKS" "Skip (human)" "dummy" "$(gate_response "Full")"

# 5. Live Monday says Skip (agent), local empty → allow
run_case "live Skip (agent) + pending → ALLOW" 0 "$PENDING_CHECKS" "" "dummy" "$(gate_response "Skip (agent)")"

# 6. Live read fails (network) → falls back to local Skip → allow
run_case "curl failure falls back to local Skip → ALLOW" 0 "$PENDING_CHECKS" "Skip (agent)" "dummy" ""

# 7. Cancelled checks + skip → allow
run_case "Skip (human) + cancelled → ALLOW" 0 "$CANCELLED_CHECKS" "Skip (human)" "" ""

# 8. Cancelled checks without skip → block
run_case "no gate + cancelled → BLOCK" 2 "$CANCELLED_CHECKS" "" "" ""

# 9. All green, skip set → allow (and marker cleared like before)
run_case "Skip + all green → ALLOW" 0 "$GREEN_CHECKS" "Skip (human)" "" ""
if [ ! -f "$MARKER" ]; then
  echo "  PASS: all-green still clears the push marker"
  PASS=$((PASS+1))
else
  echo "  FAIL: all-green should clear the push marker"
  FAIL=$((FAIL+1))
fi

# 10. Pending + skip keeps the marker (so a later Stop re-checks for red)
: > "$MARKER"
write_state "Skip (human)"
echo "{\"cwd\":\"$TEST_DIR/repo\"}" | MOCK_CHECKS="$PENDING_CHECKS" MONDAY_API_KEY="" MOCK_CURL_RESPONSE="" bash "$HOOK" >/dev/null 2>&1
if [ -f "$MARKER" ]; then
  echo "  PASS: skip-allow on pending keeps the push marker"
  PASS=$((PASS+1))
else
  echo "  FAIL: skip-allow on pending must keep the push marker"
  FAIL=$((FAIL+1))
fi

# --- Cleanup ------------------------------------------------------------------
rm -f "$MARKER" "$ACK_FILE"
cd /
rm -rf "$TEST_DIR"

echo ""
echo "stop-ci-green-check.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ] || exit 1
