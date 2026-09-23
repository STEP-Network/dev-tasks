#!/bin/bash
# Gates (d) and (e) — i18n parity at commit — are agent-only (spec section 4).
# A human's miss is caught by the CI `i18n` job a minute after the push; an
# agent has no equivalent feedback inside its own session, so the commit-time
# gate stays there.
#
# Run with: bash plugin/hooks/__tests__/bash-guard-i18n-profile.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/../bash-guard.sh"

PASS=0
FAIL=0

TEST_DIR=$(mktemp -d -t i18n-gate-XXXX)
TEST_HOME=$(mktemp -d -t i18n-gate-home-XXXX)
mkdir -p "$TEST_DIR/.claude" "$TEST_DIR/messages" "$TEST_HOME/.claude"
export HOME="$TEST_HOME"
export CLAUDE_PROJECT_DIR="$TEST_DIR"

cleanup() { command rm -r -f "$TEST_DIR" "$TEST_HOME"; }
trap cleanup EXIT

cd "$TEST_DIR"
git init --quiet --initial-branch=main
git config user.email "test@example.com"
git config user.name "test"

cat > "$TEST_DIR/.claude/project-config.json" <<'CFG'
{
  "version": "1",
  "monday": { "productId": "1" },
  "git": { "defaultBase": "main", "protectedBranches": ["main"] },
  "i18n": {
    "enabled": true,
    "defaultLocale": "en",
    "locales": ["en", "da", "de"],
    "messagesGlob": "messages/*.json",
    "parityHookMode": "block"
  },
  "hooks": { "enabled": [] }
}
CFG

printf '{"hello":"Hello"}\n'  > messages/en.json
printf '{"hello":"Hej"}\n'    > messages/da.json
printf '{"hello":"Hallo"}\n'  > messages/de.json
git add .
git commit --quiet -m init
git checkout --quiet -b feat/i18n

# The offence: a NEW key added to en only, staged.
printf '{"hello":"Hello","goodbye":"Goodbye"}\n' > messages/en.json
git add messages/en.json

# assert_profile <profile> <expected-exit> <label>
assert_profile() {
  local profile="$1" expected="$2" label="$3" code
  printf '{ "profile": "%s" }' "$profile" > "$TEST_HOME/.claude/dev-tasks-profile.json"
  printf '{"tool_name":"Bash","tool_input":{"command":"git commit -m add-a-key"}}' | bash "$HOOK" >/dev/null 2>&1
  code=$?
  if [ "$code" = "$expected" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected exit $expected, got $code)"
    FAIL=$((FAIL + 1))
  fi
}

echo "--- the profile decides ---"
assert_profile agent 2 "agent: i18n parity blocks the commit"
assert_profile human 0 "human: i18n parity does not block"

echo "--- gate (f) is NOT profile-gated ---"
printf '{ "profile": "human" }' > "$TEST_HOME/.claude/dev-tasks-profile.json"
printf '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}' | bash "$HOOK" >/dev/null 2>&1
if [ $? = 2 ]; then
  echo "PASS: gate (f) still blocks on human"
  PASS=$((PASS + 1))
else
  echo "FAIL: gate (f) stopped blocking on human"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
