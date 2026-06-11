#!/bin/bash
# Tests for plugin/scripts/emit-state-marker.sh
#
# Run with: bash plugin/hooks/__tests__/emit-state-marker.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/../../scripts/emit-state-marker.sh"

if [ ! -x "$SCRIPT" ]; then
  echo "FATAL: script not found or not executable at $SCRIPT"
  exit 1
fi

PASS=0
FAIL=0

run_test() {
  local name="$1"
  local expect_exit="$2"
  shift 2
  local actual_out
  actual_out=$(bash "$SCRIPT" "$@" 2>&1)
  local actual_exit=$?

  if [ "$actual_exit" = "$expect_exit" ]; then
    echo "  PASS: $name"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $name (expected exit=$expect_exit, got=$actual_exit)"
    echo "         output: $actual_out"
    FAIL=$((FAIL+1))
  fi
}

# Set up a temp git repo (script requires HEAD).
TEST_DIR=$(mktemp -d -t emit-marker-test-XXXX)
cd "$TEST_DIR"
git init --quiet
git config user.email "test@example.com"
git config user.name "test"
echo init > seed
git add seed
git commit --quiet -m init
HEAD_SHA=$(git rev-parse HEAD)

clean_markers() { rm -f /tmp/.claude-state-marker-*-"$HEAD_SHA"; }

# ============================================================
# Valid fields
# ============================================================
echo "## valid fields emit marker"

for FIELD in selfReviewPassed reviewAddressed parentStatus mondayReconciledShas ciGate; do
  clean_markers
  run_test "emit $FIELD → exit 0" 0 "$FIELD"
  if [ ! -f "/tmp/.claude-state-marker-${FIELD}-${HEAD_SHA}" ]; then
    echo "  FAIL: marker file /tmp/.claude-state-marker-${FIELD}-${HEAD_SHA} not created"
    FAIL=$((FAIL+1))
  else
    echo "  PASS: marker file created for $FIELD"
    PASS=$((PASS+1))
  fi
done

# ============================================================
# allowMainCheckout has no marker path
# ============================================================
echo "## allowMainCheckout rejected"

clean_markers
run_test "emit allowMainCheckout → exit 1 (no marker path)" 1 "allowMainCheckout"
if [ -f "/tmp/.claude-state-marker-allowMainCheckout-${HEAD_SHA}" ]; then
  echo "  FAIL: allowMainCheckout marker created (should not be)"
  FAIL=$((FAIL+1))
else
  echo "  PASS: no marker created for allowMainCheckout"
  PASS=$((PASS+1))
fi

# ============================================================
# Invalid field name
# ============================================================
echo "## invalid field rejected"

run_test "emit bogusField → exit 1" 1 "bogusField"
run_test "emit (no arg) → exit 1" 1

# ============================================================
# No git repo
# ============================================================
echo "## no git repo"

NOGIT_DIR=$(mktemp -d -t emit-marker-nogit-XXXX)
cd "$NOGIT_DIR"
run_test "no git repo → exit 1" 1 "selfReviewPassed"

# Cleanup
cd /
rm -rf "$TEST_DIR" "$NOGIT_DIR"
clean_markers

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
