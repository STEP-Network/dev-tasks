#!/bin/bash
# Tests for plugin/hooks/lib/profile.sh.
#
# The reader decides which gates run on this machine, so its failure
# directions are the point of the test, not an afterthought:
#   absent file            -> human  (spec section 4, stated outright)
#   present but corrupt    -> agent  (a machine somebody configured must not
#                                     silently disarm its guards)
#   unknown profile value  -> agent  (same reasoning)
#   DEV_TASKS_PROFILE set  -> wins over the file, same validation
#
# Run with: bash plugin/hooks/__tests__/profile.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/../lib/profile.sh"

if [ ! -f "$LIB" ]; then
  echo "FATAL: reader not found at $LIB"
  exit 1
fi

PASS=0
FAIL=0

TEST_HOME=$(mktemp -d -t profile-test-XXXX)
mkdir -p "$TEST_HOME/.claude"
export HOME="$TEST_HOME"

cleanup() { rm -rf "$TEST_HOME"; }
trap cleanup EXIT

write_profile() {
  printf '%s' "$1" > "$TEST_HOME/.claude/dev-tasks-profile.json"
}

remove_profile() {
  rm -f "$TEST_HOME/.claude/dev-tasks-profile.json"
}

# assert_get <key> <expected> <label>
assert_get() {
  local key="$1" expected="$2" label="$3" actual
  actual=$(bash "$LIB" get "$key" 2>/dev/null)
  if [ "$actual" = "$expected" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected '$expected', got '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

# assert_is <value> <expected-exit> <label>
assert_is() {
  local value="$1" expected="$2" label="$3" code
  bash "$LIB" is "$value" >/dev/null 2>&1
  code=$?
  if [ "$code" = "$expected" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected exit $expected, got $code)"
    FAIL=$((FAIL + 1))
  fi
}

echo "--- absent file means human (spec section 4) ---"
remove_profile
unset DEV_TASKS_PROFILE
assert_get profile human "absent file -> human"
assert_get devSurface localhost "absent file -> localhost"
assert_get mini "" "absent file -> no mini"
assert_is agent 1 "absent file: is agent -> false"
assert_is human 0 "absent file: is human -> true"

echo "--- the human profile ---"
write_profile '{ "profile": "human", "devSurface": "localhost", "mini": null }'
assert_get profile human "human profile"
assert_get devSurface localhost "human devSurface"
assert_get mini "" "human mini is empty"
assert_is human 0 "human: is human -> true"

echo "--- the agent profile ---"
write_profile '{ "profile": "agent", "devSurface": "preview", "mini": "bob" }'
assert_get profile agent "agent profile"
assert_get devSurface preview "agent devSurface"
assert_get mini bob "agent mini"
assert_is agent 0 "agent: is agent -> true"
assert_is human 1 "agent: is human -> false"

echo "--- DEV_TASKS_PROFILE overrides the file ---"
write_profile '{ "profile": "agent", "devSurface": "preview", "mini": "bob" }'
export DEV_TASKS_PROFILE=human
assert_get profile human "exported override wins"
assert_get mini bob "override does not touch mini"
assert_get devSurface preview "override does not touch devSurface"
unset DEV_TASKS_PROFILE

echo "--- corrupt or unknown fails toward agent ---"
write_profile '{ this is not json'
assert_get profile agent "unparseable file -> agent"
write_profile '{ "profile": "robot" }'
assert_get profile agent "unknown profile value -> agent"
write_profile '{ "profile": "agent", "devSurface": "mars" }'
assert_get devSurface preview "unknown devSurface on agent -> preview"
write_profile '{ "profile": "human", "devSurface": "mars" }'
assert_get devSurface localhost "unknown devSurface on human -> localhost"
write_profile '{ "profile": "human" }'
export DEV_TASKS_PROFILE=robot
assert_get profile agent "unknown env override -> agent"
unset DEV_TASKS_PROFILE

echo ""
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
